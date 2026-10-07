// M06 release gate: real PostgreSQL + PostgREST concurrency. LOCAL ONLY.
// Prerequisites: `supabase start`, `scripts/local-db-bootstrap.sh`, and
// ZUDE_PG_MODULE pointing at an installed `pg`. Run explicitly:
//   ZUDE_PG_MODULE=/path/to/node_modules/pg node --test tests/release/m06-real-postgres.test.cjs
// Every handler is the real server module; every request is a separate
// PostgREST transaction; barriers are real row/advisory locks held on
// independent connections and observed through pg_blocking_pids, not sleeps.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@supabase/supabase-js');
const { harness, uuid } = require('../support/local-postgres.cjs');

const M = 60000, H = 60 * M, D = 24 * H;
const iso = (ms) => new Date(ms).toISOString();
const mondayUtc = (ms) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); };
const day = (ms) => iso(ms).slice(0, 10);
const json = async (r) => ({ status: r.status, body: await r.json() });

let h, ts, clock, working, reports, issues, svc;
before(async () => {
  h = await harness();
  ts = h.load('server/handlers/timesheets.ts');
  clock = h.load('server/handlers/time-clock.ts');
  working = h.load('server/handlers/working.ts');
  reports = h.load('server/handlers/time-reports.ts');
  issues = h.load('server/handlers/time-issues.ts');
  svc = createClient(h.api, h.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
});
after(async () => {
  try { assert.equal(await h.deadlocks(), 0, 'no deadlocks during normal operation'); }
  finally { await h.close(); }
});

// ---- Request helpers (real handlers) -----------------------------------------------
const acct = (T, who, session, extra = {}) => ({ Authorization: `Bearer ${who.accessToken}`, 'x-anaai-business-id': T.business, 'Content-Type': 'application/json',
  ...(session ? { 'x-zude-device': T.device.value, 'x-zude-employee-session': session.value } : {}), ...extra });
const timesheet = async (T, who, emp, week) => json(await ts.GET(new Request(`https://zude.test/api/management/timesheets/${emp}?weekStart=${week}`, { headers: acct(T, who) })));
const preview = async (T, who, emp, body, session) => json(await ts.PREVIEW_CORRECTION(new Request(`https://zude.test/api/management/timesheets/${emp}/corrections/preview`, { method: 'POST', headers: acct(T, who, session), body: JSON.stringify(body) })));
const commit = (T, who, emp, body, { key = uuid(), session } = {}) => ts.COMMIT_CORRECTION(new Request(`https://zude.test/api/management/timesheets/${emp}/corrections`, { method: 'POST', headers: acct(T, who, session, { 'Idempotency-Key': key }), body: JSON.stringify(body) })).then(json);
const device = (T, session, extra = {}) => ({ Authorization: `ZudeDevice ${T.device.value}`, 'x-zude-employee-session': session.value, ...extra });
const act = (T, session, action, body = {}) => clock[action](new Request('https://zude.test/api/time-clock/action', { method: 'POST', headers: device(T, session, { 'Idempotency-Key': uuid(), 'Content-Type': 'application/json' }), body: JSON.stringify(body) })).then(json);
const myTime = async (T, session) => json(await clock.MY_TIME(new Request('https://zude.test/api/my-time', { headers: device(T, session) })));
const roster = async (T, who) => json(await working.GET(new Request('https://zude.test/api/management/working', { headers: acct(T, who) })));
const report = async (T, who, from, to) => json(await reports.GET(new Request(`https://zude.test/api/management/reports?startDate=${from}&endDate=${to}`, { headers: acct(T, who) })));
const reportIssue = (T, session, note) => clock.REPORT_ISSUE(new Request('https://zude.test/api/time-clock/issues', { method: 'POST', headers: device(T, session, { 'Idempotency-Key': uuid(), 'Content-Type': 'application/json' }), body: JSON.stringify({ note }) })).then(json);
const resolve = (T, who, issueId, note, { key = uuid(), correctionId } = {}) => issues.RESOLVE(new Request(`https://zude.test/api/management/time-issues/${issueId}/resolve`, { method: 'POST', headers: acct(T, who, null, { 'Idempotency-Key': key }), body: JSON.stringify({ note, ...(correctionId ? { correctionId } : {}) }) })).then(json);

// The real UI flow: preview, then commit with the preview's revision/watermark.
async function base(T, who, emp, operations, session) {
  const p = await preview(T, who, emp, { operations }, session);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  return { operations, reason: 'Release gate correction', expectedRevision: p.body.correction.basedOnRevision, expectedWatermark: p.body.correction.basedOnWatermark };
}
async function counts(business) {
  return (await h.admin.query(`select
    (select count(*) from public.employee_time_events where business_id = $1)::int originals,
    (select count(*) from public.employee_time_effective_events where business_id = $1)::int effective,
    (select count(*) from public.employee_time_corrections where business_id = $1)::int corrections,
    (select count(*) from public.employee_time_correction_entries x join public.employee_time_corrections c on c.id = x.correction_id where c.business_id = $1)::int entries,
    (select count(*) from public.employee_management_actions where business_id = $1)::int audits,
    (select count(*) from public.employee_time_issue_resolutions where business_id = $1)::int resolutions`, [business])).rows[0];
}
const lockEmployeeTime = (T, emp) => h.hold("select pg_advisory_xact_lock(hashtextextended('zude:m05:time:' || $1 || ':' || $2, 505))", [T.business, emp]);
const updatedAt = async (emp) => (await h.admin.query('select updated_at::text u from public.employees where id = $1', [emp])).rows[0].u;
const writeEmployee = (T, actor, emp, values, extra = {}) => ({ p_business_id: T.business, p_actor_id: actor, p_employee_id: emp, p_pin_snapshot: null, p_values: values,
  p_authority_mode: 'account', p_expected_account_role: 'owner', p_actor_employee_id: null, p_actor_device_id: null, p_actor_session_id: null, ...extra });
// supabase-js builders are lazy; `.then` sends the PostgREST request now.
const teamRpc = (args) => svc.rpc('m04_write_employee', args).then((r) => r);
const teamSql = 'select * from public.m04_write_employee($1,$2,$3,$4::timestamptz,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11)';
const teamArgs = (a, expected) => [a.p_business_id, a.p_actor_id, a.p_employee_id, expected, a.p_pin_snapshot && JSON.stringify(a.p_pin_snapshot), JSON.stringify(a.p_values), a.p_authority_mode, a.p_expected_account_role, a.p_actor_employee_id, a.p_actor_device_id, a.p_actor_session_id];
async function inService(holder) { await holder.query('set local role service_role'); }

// A closed shift last week (Tuesday 09:00-17:00 UTC with a 15-minute paid break).
async function lastWeekShift(T, emp) {
  const tue = mondayUtc(Date.now()) - 7 * D + D;
  const ids = {};
  ids.in = (await T.event(emp, 'CLOCK_IN', tue + 9 * H)).id;
  ids.breakStart = (await T.event(emp, 'BREAK_START', tue + 12 * H, 'PAID')).id;
  ids.breakEnd = (await T.event(emp, 'BREAK_END', tue + 12 * H + 15 * M, 'PAID')).id;
  ids.out = (await T.event(emp, 'CLOCK_OUT', tue + 17 * H)).id;
  return { ids, week: day(mondayUtc(Date.now()) - 7 * D), tue };
}

// Effective read under a concurrent committed change. Accept only coherent old,
// coherent new, or the bounded TIME_LEDGER_CHANGED retry outcome.
async function coherentRead({ read, signature, match, mutate, persistent = false }) {
  const old = await read();
  assert.equal(old.status, 200, JSON.stringify(old.body));
  // Version tokens bracket each attempt (odd = opening token). Commit one
  // mutation inside attempt 1 (and attempt 2 when persistent), right after the
  // first matching request of that attempt.
  let versions = 0, mutations = 0;
  const mutated = new Set();
  h.hooks.after('rpc/m06_ledger_read_versions', () => { versions++; }, 1000);
  h.hooks.after(match, async () => {
    const attempt = (versions + 1) / 2;
    if (versions % 2 !== 1 || mutated.has(attempt) || attempt > (persistent ? 2 : 1)) return;
    mutated.add(attempt); mutations++;
    await h.hooks.quietly(() => mutate(mutations));
  }, 1000);
  const raced = await read();
  h.hooks.clear();
  const fresh = await read();
  assert.equal(fresh.status, 200);
  assert.notDeepEqual(signature(fresh.body), signature(old.body), 'the concurrent write changed the effective ledger');
  assert.ok(mutations >= 1, 'interleaving happened');
  if (persistent) {
    assert.equal(raced.status, 503); assert.equal(raced.body.code, 'TIME_LEDGER_CHANGED');
    assert.equal(versions, 4, 'exactly two bounded attempts');
    return 'TIME_LEDGER_CHANGED';
  }
  assert.equal(raced.status, 200, JSON.stringify(raced.body));
  const got = JSON.stringify(signature(raced.body));
  assert.ok(got === JSON.stringify(signature(old.body)) || got === JSON.stringify(signature(fresh.body)), `mixed revision: ${got}`);
  assert.equal(got, JSON.stringify(signature(fresh.body)), 'change after the first token forces a retry to the new state');
  assert.equal(versions, 4, 'version mismatch detected and retried once');
  return 'new';
}

// ---- 1. Correction vs correction ---------------------------------------------------
test('1. correction vs correction: one revision wins, stale/replay/conflict are exact, no partial writes', async () => {
  const T = await h.tenant('Corr');
  const emp = await T.employee({ name: 'Riley' });
  const { ids, week, tue } = await lastWeekShift(T, emp);
  const ops = (min) => [{ op: 'REPLACE', target: ids.out, occurredAt: iso(tue + 17 * H - min * M) }];
  // (a) Five different commits on the same base, truly overlapping behind the employee lock.
  const b = await Promise.all([1, 2, 3, 4, 5].map(m => base(T, T.owner, emp, ops(m))));
  const start = await counts(T.business);
  const holder = await lockEmployeeTime(T, emp);
  const racing = b.map(body => commit(T, T.owner, emp, { ...body, weekStart: week }));
  await h.blockedBy(holder.pid, 'm06_correct_employee_time', 5);
  await holder.rollback();
  const results = await Promise.all(racing);
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409, 409, 409, 409]);
  for (const r of results.filter(r => r.status === 409)) assert.equal(r.body.code, 'TIME_CORRECTION_STALE');
  const after = await counts(T.business);
  assert.equal(after.corrections - start.corrections, 1);
  assert.equal(after.audits - start.audits, 1);
  assert.equal(after.originals, start.originals, 'originals untouched');
  // (b) Same key + same payload concurrently: one commit, one exact replay.
  const body = { ...(await base(T, T.owner, emp, ops(20))), weekStart: week }, key = uuid();
  const h2 = await lockEmployeeTime(T, emp);
  const pair = [commit(T, T.owner, emp, body, { key })];
  await h.blockedBy(h2.pid, 'm06_correct_employee_time', 1);
  pair.push(commit(T, T.owner, emp, body, { key }));
  await h.blockedBy(h2.pid, 'm06_correct_employee_time', 2);
  await h2.rollback();
  const [first, replay] = await Promise.all(pair);
  assert.equal(first.status, 201); assert.equal(replay.status, 200);
  assert.equal(replay.body.correction.replayed, true);
  assert.equal(replay.body.correction.id, first.body.correction.id);
  // (c) Same key, different payload: refused, nothing written.
  const before = await counts(T.business);
  const conflict = await commit(T, T.owner, emp, { ...body, operations: ops(25) }, { key });
  assert.equal(conflict.status, 409); assert.equal(conflict.body.code, 'TIME_REQUEST_CONFLICT');
  assert.deepEqual(await counts(T.business), before);
  await h.invariants(T.business);
});

// ---- 2. Correction vs real CLOCK_IN/CLOCK_OUT ------------------------------------
test('2. correction vs real clock action: serialized by the shared employee lock in either order', async () => {
  const T = await h.tenant('Clock');
  const emp = await T.employee({ name: 'Casey' });
  const s = await T.session(emp);
  for (const order of ['correction-first', 'clock-first']) {
    assert.equal((await act(T, s, 'CLOCK_IN')).status, 200);
    const evs = await h.effective(emp), clockedIn = evs.at(-1), prior = evs.at(-2);
    // Earlier clock-in that stays after any previous event.
    const at = prior ? Math.floor((prior.occurred_at.getTime() + clockedIn.occurred_at.getTime()) / 2) : clockedIn.occurred_at.getTime() - 20 * M;
    const body = await base(T, T.owner, emp, [{ op: 'REPLACE', target: clockedIn.id, occurredAt: iso(at) }]);
    const start = await counts(T.business);
    const holder = await lockEmployeeTime(T, emp);
    let correction, clockOut;
    if (order === 'correction-first') {
      correction = commit(T, T.owner, emp, body); await h.blockedBy(holder.pid, 'm06_correct_employee_time');
      clockOut = act(T, s, 'CLOCK_OUT'); await h.blockedBy(holder.pid, 'm05_record_time_event');
    } else {
      clockOut = act(T, s, 'CLOCK_OUT'); await h.blockedBy(holder.pid, 'm05_record_time_event');
      correction = commit(T, T.owner, emp, body); await h.blockedBy(holder.pid, 'm06_correct_employee_time');
    }
    await holder.rollback();
    const [c, o] = await Promise.all([correction, clockOut]);
    assert.equal(o.status, 200, JSON.stringify(o.body)); assert.equal(o.body.state, 'OFF_CLOCK');
    const after = await counts(T.business);
    assert.equal(after.originals - start.originals, 1, 'exactly one CLOCK_OUT original');
    if (order === 'correction-first') { assert.equal(c.status, 201); assert.equal(after.corrections - start.corrections, 1); }
    else { assert.equal(c.status, 409); assert.equal(c.body.code, 'TIME_CORRECTION_STALE'); assert.equal(after.corrections, start.corrections); assert.equal(after.audits, start.audits); }
    await h.invariants(T.business);
  }
});

// ---- 3-6. Correction vs effective reads -------------------------------------------
test('3. correction vs Timesheet read: coherent old/new or TIME_LEDGER_CHANGED, never mixed', async () => {
  const T = await h.tenant('Sheet');
  const emp = await T.employee({ name: 'Taylor' });
  const { ids, week, tue } = await lastWeekShift(T, emp);
  const c = await h.connect();
  const sig = (b) => ({ totals: b.totals, events: b.events.map(e => [e.id, e.type, e.occurredAt]) });
  // Rebuild every event time between the head query and the boundary/page queries.
  const mutate = (n) => h.commitCorrection(c, T, emp, [
    { op: 'REPLACE', target: ids.in, occurredAt: iso(tue + 9 * H - n * 7 * M) }, { op: 'REPLACE', target: ids.out, occurredAt: iso(tue + 17 * H - n * 11 * M) }]);
  await mutate(0.5); // renumber the projection first so only version tokens can detect the race (see control)
  const read = () => timesheet(T, T.owner, emp, week);
  assert.equal(await coherentRead({ read, signature: sig, match: 'employee_time_effective_events?', mutate }), 'new');
  assert.equal(await coherentRead({ read, signature: sig, match: 'employee_time_effective_events?', mutate: (n) => mutate(n + 2), persistent: true }), 'TIME_LEDGER_CHANGED');
  await h.invariants(T.business);
});

test('4. correction vs My Time read: coherent old/new or TIME_LEDGER_CHANGED', async () => {
  const T = await h.tenant('MyTime');
  const emp = await T.employee({ name: 'Jordan' });
  const s = await T.session(emp);
  const now = Date.now(), start = Math.max(mondayUtc(now) + M, now - 6 * H), end = now - 2 * M;
  assert.ok(end - start > 40 * M, 'needs 40 minutes of the current UTC week; rerun after Monday 00:45 UTC');
  const inId = (await T.event(emp, 'CLOCK_IN', start)).id, outId = (await T.event(emp, 'CLOCK_OUT', end)).id;
  const c = await h.connect();
  const sig = (b) => ({ state: b.state, week: [b.week.workedMs, b.week.paidBreakMs, b.week.mealBreakMs] });
  const mutate = (n) => h.commitCorrection(c, T, emp, [{ op: 'REPLACE', target: inId, occurredAt: iso(start + n * 3 * M) }, { op: 'REPLACE', target: outId, occurredAt: iso(end - n * 2 * M) }]);
  await mutate(0.5); // renumber the projection first so only version tokens can detect the race (see control)
  const read = () => myTime(T, s);
  assert.equal(await coherentRead({ read, signature: sig, match: 'employee_time_effective_events?', mutate }), 'new');
  assert.equal(await coherentRead({ read, signature: sig, match: 'employee_time_effective_events?', mutate: (n) => mutate(n + 2), persistent: true }), 'TIME_LEDGER_CHANGED');
  await h.invariants(T.business);
});

test("5. correction vs Who's Working read: heads and events never mix revisions", async () => {
  const T = await h.tenant('Working');
  const emp = await T.employee({ name: 'Morgan' });
  const now = Date.now();
  const inId = (await T.event(emp, 'CLOCK_IN', now - 3 * H)).id;
  await T.event(emp, 'BREAK_START', now - 2 * H, 'PAID');
  const endId = (await T.event(emp, 'BREAK_END', now - 110 * M, 'PAID')).id;
  const c = await h.connect();
  const sig = (b) => b.employees.map(e => [e.employee.id, e.state, e.stateStartedAt, e.shift?.id ?? null, e.shift?.clockInAt ?? null]);
  // Between the head statement and the bounded event batch: move the clock-in and the latest event.
  const mutate = (n) => h.commitCorrection(c, T, emp, [{ op: 'REPLACE', target: inId, occurredAt: iso(now - 3 * H - n * 5 * M) }, { op: 'REPLACE', target: endId, occurredAt: iso(now - 110 * M + n * 4 * M) }]);
  await mutate(0.5); // renumber the projection first so only version tokens can detect the race (see control)
  const read = () => roster(T, T.owner);
  assert.equal(await coherentRead({ read, signature: sig, match: '/rest/v1/employees?', mutate }), 'new');
  assert.equal(await coherentRead({ read, signature: sig, match: '/rest/v1/employees?', mutate: (n) => mutate(n + 2), persistent: true }), 'TIME_LEDGER_CHANGED');
  await h.invariants(T.business);
});

test("control: with the version tokens neutralised, the same Who's Working interleaving IS mixed (proves test 5 is sensitive)", async () => {
  const T = await h.tenant('Control');
  const emp = await T.employee({ name: 'Control' });
  const now = Date.now();
  const inId = (await T.event(emp, 'CLOCK_IN', now - 3 * H)).id;
  await T.event(emp, 'BREAK_START', now - 2 * H, 'PAID');
  const endId = (await T.event(emp, 'BREAK_END', now - 110 * M, 'PAID')).id;
  const c = await h.connect();
  // A first correction renumbers the projection's seq (which Working's own seq
  // bounds would catch); afterwards a time-only correction keeps seq stable, so
  // only the version tokens can detect it.
  await h.commitCorrection(c, T, emp, [{ op: 'REPLACE', target: inId, occurredAt: iso(now - 3 * H - M) }]);
  const sig = (b) => b.employees.map(e => [e.employee.id, e.state, e.stateStartedAt, e.shift?.id ?? null, e.shift?.clockInAt ?? null]);
  const old = await roster(T, T.owner);
  h.hooks.freeze('rpc/m06_ledger_read_versions');
  h.hooks.after('/rest/v1/employees?', () => h.hooks.quietly(() => h.commitCorrection(c, T, emp, [
    { op: 'REPLACE', target: inId, occurredAt: iso(now - 3 * H - 5 * M) }, { op: 'REPLACE', target: endId, occurredAt: iso(now - 106 * M) }])));
  const raced = await roster(T, T.owner);
  h.hooks.clear();
  const fresh = await roster(T, T.owner);
  assert.equal(raced.status, 200);
  const got = JSON.stringify(sig(raced.body));
  assert.notEqual(got, JSON.stringify(sig(old.body)), 'not the old revision');
  assert.notEqual(got, JSON.stringify(sig(fresh.body)), 'not the new revision: mixed, as expected without the protocol');
});

test('6. correction vs Reports read: coherent totals or TIME_LEDGER_CHANGED', async () => {
  const T = await h.tenant('Reports');
  const emp = await T.employee({ name: 'Avery' });
  const { ids, tue } = await lastWeekShift(T, emp);
  const c = await h.connect();
  const from = day(mondayUtc(Date.now()) - 7 * D), to = day(Date.now());
  const sig = (b) => ({ totals: b.totals, rows: b.rows.map(r => [r.employeeId, r.workedMs, r.paidBreakMs, r.corrected]) });
  const mutate = (n) => h.commitCorrection(c, T, emp, [{ op: 'REPLACE', target: ids.out, occurredAt: iso(tue + 17 * H - n * 13 * M) }]);
  const read = () => report(T, T.owner, from, to);
  assert.equal(await coherentRead({ read, signature: sig, match: 'rpc/m06_ledger_read_versions', mutate }), 'new');
  assert.equal(await coherentRead({ read, signature: sig, match: 'rpc/m06_ledger_read_versions', mutate: (n) => mutate(n + 2), persistent: true }), 'TIME_LEDGER_CHANGED');
  await h.invariants(T.business);
});

// ---- 7. Real clock write vs Reports --------------------------------------------------
test('7. real clock action vs Reports read: coherent or bounded retry', async () => {
  const T = await h.tenant('ClockReport');
  const emp = await T.employee({ name: 'Quinn' });
  const s = await T.session(emp);
  assert.equal((await act(T, s, 'CLOCK_IN')).status, 200);
  const from = day(Date.now() - D), to = day(Date.now());
  const sig = (b) => ({ open: b.totals.open, rows: b.rows.map(r => [r.employeeId, r.open]) });
  const actions = ['BREAK_START', 'BREAK_END', 'CLOCK_OUT'];
  const read = () => report(T, T.owner, from, to);
  // The read is open before; a real CLOCK_OUT commits between token and dataset.
  const outcome = await coherentRead({ read, signature: sig, match: 'rpc/m06_ledger_read_versions', mutate: async () => {
    const r = await act(T, s, 'CLOCK_OUT'); assert.equal(r.status, 200); } });
  assert.equal(outcome, 'new');
  // Persistent real clock writes on both attempts: bounded failure, no mixed totals.
  assert.equal((await act(T, s, 'CLOCK_IN')).status, 200);
  let i = 0;
  assert.equal(await coherentRead({ read, signature: (b) => ({ rows: b.rows.map(r => [r.employeeId, r.open, r.paidBreakMs > 0]) }), match: 'rpc/m06_ledger_read_versions', persistent: true,
    mutate: async () => { const r = await act(T, s, actions[i++], i === 1 ? { breakType: 'PAID' } : {}); assert.equal(r.status, 200, JSON.stringify(r.body)); } }), 'TIME_LEDGER_CHANGED');
  await h.invariants(T.business);
});

// ---- 8. Management mutation vs actor demotion ----------------------------------------
test('8. management mutation vs actor demotion (account role and shared-device employee role), both orders', async () => {
  const T = await h.tenant('Demote');
  const emp = await T.employee({ name: 'Drew' });
  const { ids, week, tue } = await lastWeekShift(T, emp);
  const demote = "update public.business_members set role = 'staff' where business_id = $1 and user_id = $2";
  const restore = () => h.admin.query("update public.business_members set role = 'manager' where business_id = $1 and user_id = $2", [T.business, T.manager.id]);
  // (a) Demotion commits first while the manager's correction is in flight: rejected, nothing written.
  let body = { ...(await base(T, T.manager, emp, [{ op: 'REPLACE', target: ids.out, occurredAt: iso(tue + 16 * H) }])), weekStart: week };
  let start = await counts(T.business);
  let holder = await h.hold(demote, [T.business, T.manager.id]);
  const rejected = commit(T, T.manager, emp, body);
  await h.blockedBy(holder.pid, 'm06_correct_employee_time');
  await holder.commit();
  const r1 = await rejected;
  assert.equal(r1.status, 403); assert.equal(r1.body.code, 'ROLE_FORBIDDEN');
  assert.deepEqual(await counts(T.business), start, 'no partial correction or audit');
  await restore();
  // (b) Correction holds the membership row first: demotion waits for its commit.
  body = { ...(await base(T, T.manager, emp, [{ op: 'REPLACE', target: ids.out, occurredAt: iso(tue + 16 * H) }])) };
  start = await counts(T.business);
  holder = await h.hold(); await inService(holder);
  const v = await h.ledgerVersion(T.business, emp);
  await holder.query(h.correctionSql, [T.business, emp, T.manager.id, 'account', 'manager', null, null, null, JSON.stringify(body.operations), 'Before demotion', uuid(), v.revision, v.watermark]);
  const demoter = await h.connect();
  const demotion = demoter.query(demote, [T.business, T.manager.id]);
  await h.blockedBy(holder.pid, 'business_members');
  await holder.commit(); await demotion;
  const after = await counts(T.business);
  assert.equal(after.corrections - start.corrections, 1); assert.equal(after.audits - start.audits, 1);
  assert.equal((await h.admin.query("select effective_role from public.employee_management_actions where business_id = $1 and action = 'time.corrected' order by recorded_at desc limit 1", [T.business])).rows[0].effective_role, 'manager');
  await restore();
  // (c) Shared-device: owner demotes the manager-employee while their Team write waits on the Team lock.
  const mgr = await T.employee({ role: 'manager', name: 'Manager Employee' });
  const ms = await T.session(mgr);
  const shared = { p_authority_mode: 'shared-device', p_expected_account_role: 'owner', p_actor_employee_id: mgr, p_actor_device_id: T.device.id, p_actor_session_id: ms.id };
  start = await counts(T.business);
  holder = await h.hold(); await inService(holder);
  await holder.query(teamSql, teamArgs(writeEmployee(T, T.owner.id, mgr, { role: 'employee' }), await updatedAt(mgr)));
  const teamWrite = teamRpc({ ...writeEmployee(T, T.owner.id, emp, { display_name: 'Renamed by demoted actor' }, shared), p_expected_updated_at: await updatedAt(emp) });
  await h.blockedBy(holder.pid, 'm04_write_employee');
  await holder.commit();
  const w = await teamWrite;
  assert.ok(w.error && ['28000', '42501'].includes(w.error.code), 'demoted actor rejected');
  assert.equal((await h.admin.query('select display_name from public.employees where id = $1', [emp])).rows[0].display_name, 'Drew');
  assert.equal((await counts(T.business)).audits - start.audits, 1, 'only the demotion is audited');
  // (d) Reverse: the manager-employee's Team write commits first, then the demotion.
  await h.admin.query("update public.employees set role = 'manager' where id = $1", [mgr]);
  const ms2 = await T.pinLogin(mgr);
  start = await counts(T.business);
  holder = await h.hold(); await inService(holder);
  await holder.query(teamSql, teamArgs(writeEmployee(T, T.owner.id, emp, { display_name: 'Renamed first' }, { ...shared, p_actor_session_id: ms2.id }), await updatedAt(emp)));
  const late = teamRpc({ ...writeEmployee(T, T.owner.id, mgr, { role: 'employee' }), p_expected_updated_at: await updatedAt(mgr) });
  await h.blockedBy(holder.pid, 'm04_write_employee');
  await holder.commit();
  assert.equal((await late).error, null);
  const audits = (await h.admin.query('select subject_employee_id, effective_role from public.employee_management_actions where business_id = $1 order by recorded_at desc limit 2', [T.business])).rows;
  assert.deepEqual(audits.map(a => [a.subject_employee_id, a.effective_role]), [[mgr, 'owner'], [emp, 'manager']]);
  assert.equal((await counts(T.business)).audits - start.audits, 2);
  await h.invariants(T.business);
});

// ---- 9. Management mutation vs target promotion --------------------------------------
test('9. manager correction / resolution / Team write vs target promotion: hierarchy re-checked under lock', async () => {
  const T = await h.tenant('Promote');
  const emp = await T.employee({ name: 'Emerson' });
  const s = await T.session(emp);
  const { ids, week, tue } = await lastWeekShift(T, emp);
  const issue = await reportIssue(T, s, 'Forgot to clock out on time');
  assert.equal(issue.status, 201);
  const body = { ...(await base(T, T.manager, emp, [{ op: 'REPLACE', target: ids.out, occurredAt: iso(tue + 16 * H) }])), weekStart: week };
  const start = await counts(T.business);
  const holder = await h.hold(); await inService(holder);
  await holder.query(teamSql, teamArgs(writeEmployee(T, T.owner.id, emp, { role: 'manager' }), await updatedAt(emp)));
  const correction = commit(T, T.manager, emp, body);
  const resolution = resolve(T, T.manager, issue.body.issue.id, 'Reviewed with the employee');
  const team = teamRpc({ ...writeEmployee(T, T.manager.id, emp, { display_name: 'Manager rename' }, { p_expected_account_role: 'manager' }), p_expected_updated_at: await updatedAt(emp) });
  await h.blockedBy(holder.pid, 'm06_correct_employee_time');
  await h.blockedBy(holder.pid, 'm06_resolve_time_issue');
  await h.blockedBy(holder.pid, 'm04_write_employee');
  await holder.commit();
  const [c, r, w] = await Promise.all([correction, resolution, team]);
  assert.equal(c.status, 403); assert.equal(c.body.code, 'ROLE_FORBIDDEN');
  assert.equal(r.status, 403); assert.equal(r.body.code, 'ROLE_FORBIDDEN');
  assert.equal(w.error?.code, '42501');
  const after = await counts(T.business);
  assert.equal(after.corrections, start.corrections); assert.equal(after.resolutions, start.resolutions);
  assert.equal(after.audits - start.audits, 1, 'only the promotion is audited');
  // Owner may still act on the promoted employee.
  const owner = await commit(T, T.owner, emp, { ...(await base(T, T.owner, emp, [{ op: 'REPLACE', target: ids.out, occurredAt: iso(tue + 16 * H) }])), weekStart: week });
  assert.equal(owner.status, 201);
  await h.invariants(T.business);
});

test('9b. report export vs actor demotion: no CSV and no export audit once authority is gone', async () => {
  const T = await h.tenant('Export');
  const emp = await T.employee({ name: 'Ellis' });
  const { week } = await lastWeekShift(T, emp);
  const exportReq = () => reports.EXPORT(new Request('https://zude.test/api/management/reports/export', { method: 'POST', headers: acct(T, T.manager), body: JSON.stringify({ startDate: week, endDate: day(Date.now()) }) })).then(json);
  const start = await counts(T.business);
  const holder = await h.hold("update public.business_members set role = 'staff' where business_id = $1 and user_id = $2", [T.business, T.manager.id]);
  const pending = exportReq();
  await h.blockedBy(holder.pid, 'm06_record_time_export');
  await holder.commit();
  const r = await pending;
  assert.equal(r.status, 403); assert.equal(r.body.code, 'ROLE_FORBIDDEN');
  assert.ok(!('csv' in r.body), 'no CSV returned');
  assert.deepEqual(await counts(T.business), start, 'no export audit');
  await h.admin.query("update public.business_members set role = 'manager' where business_id = $1 and user_id = $2", [T.business, T.manager.id]);
  const ok = await exportReq();
  assert.equal(ok.status, 200); assert.equal(typeof ok.body.csv, 'string');
  assert.equal((await counts(T.business)).audits - start.audits, 1, 'exactly one export audit');
});

// ---- 10-12. Identity revocation/generation during protected operations ---------------
test('10. session revocation during shared-device correction and real clock action', async () => {
  const T = await h.tenant('Session');
  const emp = await T.employee({ name: 'Harper' });
  const mgr = await T.employee({ role: 'manager', name: 'Shift Lead' });
  const { ids, tue } = await lastWeekShift(T, emp);
  const ms = await T.session(mgr), es = await T.session(emp);
  const body = await base(T, T.owner, emp, [{ op: 'REPLACE', target: ids.out, occurredAt: iso(tue + 16 * H) }], ms);
  const start = await counts(T.business);
  const holder = await h.hold('update public.employee_sessions set revoked_at = now() where id = any($1)', [[ms.id, es.id]]);
  const correction = commit(T, T.owner, emp, body, { session: ms });
  const clockIn = act(T, es, 'CLOCK_IN');
  await h.blockedBy(holder.pid, 'm06_correct_employee_time');
  await h.blockedBy(holder.pid, 'm05_record_time_event');
  await holder.commit();
  const [c, k] = await Promise.all([correction, clockIn]);
  assert.equal(c.status, 401); assert.equal(c.body.code, 'IDENTITY_UNAUTHORIZED');
  assert.equal(k.status, 401); assert.equal(k.body.code, 'IDENTITY_UNAUTHORIZED');
  assert.deepEqual(await counts(T.business), start, 'no clock event, correction or audit');
  await h.invariants(T.business);
});

test('11. device revocation and device PIN-generation change during protected operations', async () => {
  for (const change of ['revoked_at = now()', 'updated_at = clock_timestamp()']) {
    const T = await h.tenant('Device');
    const emp = await T.employee({ name: 'Rowan' });
    const mgr = await T.employee({ role: 'manager', name: 'Lead' });
    const { ids, tue } = await lastWeekShift(T, emp);
    const ms = await T.session(mgr), es = await T.session(emp);
    const body = await base(T, T.owner, emp, [{ op: 'REPLACE', target: ids.out, occurredAt: iso(tue + 16 * H) }], ms);
    const start = await counts(T.business);
    const holder = await h.hold(`update public.zude_devices set ${change} where id = $1`, [T.device.id]);
    const correction = commit(T, T.owner, emp, body, { session: ms });
    const clockIn = act(T, es, 'CLOCK_IN');
    await h.blockedBy(holder.pid, 'm06_correct_employee_time');
    await h.blockedBy(holder.pid, 'm05_record_time_event');
    await holder.commit();
    const [c, k] = await Promise.all([correction, clockIn]);
    assert.equal(c.status, 401, change); assert.equal(c.body.code, 'IDENTITY_UNAUTHORIZED');
    assert.equal(k.status, 401, change); assert.equal(k.body.code, 'IDENTITY_UNAUTHORIZED');
    assert.deepEqual(await counts(T.business), start, change);
    await h.invariants(T.business);
  }
});

test('12. employee generation change (PIN/role/active write) during clock action and shared-device correction', async () => {
  const T = await h.tenant('Generation');
  const emp = await T.employee({ name: 'Sage' });
  const mgr = await T.employee({ role: 'manager', name: 'Lead' });
  const { ids, tue } = await lastWeekShift(T, emp);
  // (a) Generation-only bump (no session revocation): the 202610060001 check alone must refuse.
  let es = await T.session(emp);
  let start = await counts(T.business);
  let holder = await h.hold('update public.employees set updated_at = clock_timestamp() where id = $1', [emp]);
  const clockIn = act(T, es, 'CLOCK_IN');
  await h.blockedBy(holder.pid, 'm05_record_time_event');
  await holder.commit();
  const k = await clockIn;
  assert.equal(k.status, 401); assert.equal(k.body.code, 'IDENTITY_UNAUTHORIZED');
  assert.deepEqual(await counts(T.business), start);
  // (b) Real audited Team write on the acting manager-employee during their correction.
  const ms = await T.session(mgr);
  const body = await base(T, T.owner, emp, [{ op: 'REPLACE', target: ids.out, occurredAt: iso(tue + 16 * H) }], ms);
  start = await counts(T.business);
  holder = await h.hold(); await inService(holder);
  await holder.query(teamSql, teamArgs(writeEmployee(T, T.owner.id, mgr, { display_name: 'Lead (renamed)' }), await updatedAt(mgr)));
  const correction = commit(T, T.owner, emp, body, { session: ms });
  await h.blockedBy(holder.pid, 'm06_correct_employee_time');
  await holder.commit();
  const c = await correction;
  assert.equal(c.status, 401); assert.equal(c.body.code, 'IDENTITY_UNAUTHORIZED');
  const after = await counts(T.business);
  assert.equal(after.corrections, start.corrections); assert.equal(after.audits - start.audits, 1, 'only the Team write is audited');
  // A fresh PIN session at the new generation works again.
  es = await T.pinLogin(emp);
  assert.equal((await act(T, es, 'CLOCK_IN')).status, 200);
  await h.invariants(T.business);
});

// ---- 13. Duplicate issue resolution ---------------------------------------------------
test('13. duplicate issue resolution: one immutable resolution + audit; replay/conflict exact', async () => {
  const T = await h.tenant('Resolve');
  const emp = await T.employee({ name: 'Blake' });
  const s = await T.session(emp);
  const issue = (await reportIssue(T, s, 'Missed my clock out')).body.issue;
  const key = uuid();
  const start = await counts(T.business);
  const holder = await h.hold('select 1 from public.employee_time_issues where id = $1 for update', [issue.id]);
  const racing = [
    ...[1, 2, 3].map(() => resolve(T, T.owner, issue.id, 'Fixed in timesheet', { key })),
    ...[1, 2, 3].map(() => resolve(T, T.owner, issue.id, 'Fixed in timesheet')),
  ];
  await h.blockedBy(holder.pid, 'm06_resolve_time_issue', 6);
  await holder.rollback();
  const results = await Promise.all(racing);
  assert.equal(results.filter(r => r.status === 201).length, 1);
  const sameKeyWon = results.slice(0, 3).some(r => r.status === 201);
  for (const [i, r] of results.entries()) {
    if (r.status === 201) continue;
    if (i < 3 && sameKeyWon) { assert.equal(r.status, 200); assert.equal(r.body.resolution.replayed, true); }
    else { assert.equal(r.status, 409); assert.equal(r.body.code, 'ISSUE_ALREADY_RESOLVED'); }
  }
  const after = await counts(T.business);
  assert.equal(after.resolutions - start.resolutions, 1); assert.equal(after.audits - start.audits, 1);
  // Same key on two different issues at once: one wins, the other rolls back fully (unique key).
  const i1 = (await reportIssue(T, s, 'Issue one')).body.issue, i2 = (await reportIssue(T, s, 'Issue two')).body.issue, shared = uuid();
  const before = await counts(T.business);
  const h2 = await h.hold('select 1 from public.employee_time_issues where id = any($1) for update', [[i1.id, i2.id]]);
  const both = [resolve(T, T.owner, i1.id, 'Handled', { key: shared }), resolve(T, T.owner, i2.id, 'Handled', { key: shared })];
  await h.blockedBy(h2.pid, 'm06_resolve_time_issue', 2);
  await h2.rollback();
  const pair = await Promise.all(both);
  assert.deepEqual(pair.map(r => r.status).sort(), [201, 409]);
  assert.equal(pair.find(r => r.status === 409).body.code, 'TIME_REQUEST_CONFLICT');
  const end = await counts(T.business);
  assert.equal(end.resolutions - before.resolutions, 1); assert.equal(end.audits - before.audits, 1, 'loser left no audit');
  assert.equal((await h.admin.query("select count(*)::int n from public.employee_time_issues where id = any($1) and status = 'open'", [[i1.id, i2.id]])).rows[0].n, 1);
  await h.invariants(T.business);
});

// ---- 14. Correction-linked issue resolution races ------------------------------------
test('14. correction-linked resolution vs uncommitted/committed/foreign corrections and competing links', async () => {
  const T = await h.tenant('Linked');
  const emp = await T.employee({ name: 'Kai' });
  const other = await T.employee({ name: 'Other' });
  const s = await T.session(emp);
  const { ids, tue } = await lastWeekShift(T, emp);
  const o = await lastWeekShift(T, other);
  const issue = (await reportIssue(T, s, 'Clock out was late')).body.issue;
  // (a) Link to a correction still uncommitted on another connection: safe refusal, nothing written.
  const holder = await h.hold(); await inService(holder);
  const v = await h.ledgerVersion(T.business, emp);
  const pending = (await holder.query(h.correctionSql, [T.business, emp, T.owner.id, 'account', 'owner', null, null, null, JSON.stringify([{ op: 'REPLACE', target: ids.out, occurredAt: iso(tue + 16 * H) }]), 'Linked fix', uuid(), v.revision, v.watermark])).rows[0].r;
  let start = await counts(T.business);
  const early = await resolve(T, T.owner, issue.id, 'Corrected the clock out', { correctionId: pending.correction_id });
  assert.equal(early.status, 400);
  assert.deepEqual(await counts(T.business), start);
  await holder.commit();
  // (b) Foreign-employee and foreign-tenant corrections are refused.
  const c2 = await h.connect();
  const otherCorrection = await h.commitCorrection(c2, T, other, [{ op: 'REPLACE', target: o.ids.out, occurredAt: iso(o.tue + 16 * H) }]);
  const F = await h.tenant('Foreign');
  const femp = await F.employee({ name: 'Foreign' });
  const f = await lastWeekShift(F, femp);
  const foreign = await h.commitCorrection(c2, F, femp, [{ op: 'REPLACE', target: f.ids.out, occurredAt: iso(f.tue + 16 * H) }]);
  for (const id of [otherCorrection.correction_id, foreign.correction_id]) {
    assert.equal((await resolve(T, T.owner, issue.id, 'Wrong link', { correctionId: id })).status, 400);
  }
  // (c) Two managers link different committed corrections at once: exactly one resolution.
  const second = await h.commitCorrection(c2, T, emp, [{ op: 'REPLACE', target: ids.out, occurredAt: iso(tue + 16 * H + 5 * M) }]);
  start = await counts(T.business);
  const h2 = await h.hold('select 1 from public.employee_time_issues where id = $1 for update', [issue.id]);
  const racing = [resolve(T, T.owner, issue.id, 'Linked first', { correctionId: pending.correction_id }), resolve(T, T.manager, issue.id, 'Linked second', { correctionId: second.correction_id })];
  await h.blockedBy(h2.pid, 'm06_resolve_time_issue', 2);
  await h2.rollback();
  const results = await Promise.all(racing);
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
  const row = (await h.admin.query('select correction_id from public.employee_time_issue_resolutions where issue_id = $1', [issue.id])).rows;
  assert.equal(row.length, 1);
  assert.ok([pending.correction_id, second.correction_id].includes(row[0].correction_id));
  const end = await counts(T.business);
  assert.equal(end.resolutions - start.resolutions, 1); assert.equal(end.audits - start.audits, 1);
  // (d) A resolution racing a new correction for the same employee: both commit independently.
  const issue2 = (await reportIssue(T, s, 'Break was wrong')).body.issue;
  const body = await base(T, T.owner, emp, [{ op: 'REPLACE', target: ids.breakEnd, occurredAt: iso(tue + 12 * H + 20 * M) }]);
  const [cr, rr] = await Promise.all([commit(T, T.owner, emp, body), resolve(T, T.owner, issue2.id, 'Break fixed', { correctionId: second.correction_id })]);
  assert.equal(cr.status, 201); assert.equal(rr.status, 201);
  await h.invariants(T.business); await h.invariants(F.business);
});

// ---- Cross-cutting security on the real stack ------------------------------------------
test('tenant isolation, role hierarchy, browser-role denial and immutable originals', async () => {
  const A = await h.tenant('Alpha'), B = await h.tenant('Beta');
  const ea = await A.employee({ name: 'Alpha Employee' }), ma = await A.employee({ role: 'manager', name: 'Alpha Manager' });
  const a = await lastWeekShift(A, ea);
  await lastWeekShift(A, ma);
  const eb = await B.employee({ name: 'Beta Employee' });
  await lastWeekShift(B, eb);
  // Tenant isolation through real auth + membership RLS.
  const crossSelect = await timesheet(A, B.owner, ea, a.week);
  assert.ok([403, 404].includes(crossSelect.status), JSON.stringify(crossSelect.body));
  assert.ok(!('events' in crossSelect.body));
  const crossTarget = await timesheet(B, B.owner, ea, a.week);
  assert.equal(crossTarget.status, 404);
  const crossCorrect = await preview(B, B.owner, ea, { operations: [{ op: 'VOID', target: a.ids.out }] });
  assert.equal(crossCorrect.status, 404);
  const bs = await B.session(eb);
  const mismatch = await json(await ts.GET(new Request(`https://zude.test/api/management/timesheets/${ea}?weekStart=${a.week}`, { headers: { ...acct(A, A.owner), 'x-zude-device': B.device.value, 'x-zude-employee-session': bs.value } })));
  assert.equal(mismatch.status, 403); assert.equal(mismatch.body.code, 'DEVICE_BUSINESS_MISMATCH');
  const rep = await report(A, A.owner, a.week, day(Date.now()));
  assert.equal(rep.status, 200);
  assert.ok(rep.body.rows.every(r => [ea, ma].includes(r.employeeId)), 'report contains only tenant A');
  // Hierarchy: managers act on employees only; owners on anyone.
  assert.equal((await timesheet(A, A.manager, ma, a.week)).status, 403);
  assert.equal((await preview(A, A.manager, ma, { operations: [{ op: 'VOID', target: a.ids.out }] })).status, 403);
  assert.equal((await timesheet(A, A.owner, ma, a.week)).status, 200);
  // Browser roles cannot reach protected tables or service RPCs through PostgREST.
  const fns = (await h.admin.query("select proname, proargnames from pg_proc where pronamespace = 'public'::regnamespace and proname = any($1) and proargnames is not null order by proname", [['m06_correct_employee_time', 'm06_ledger_read_versions', 'm06_resolve_time_issue', 'm06_report_dataset', 'm05_record_time_event', 'm04_write_employee', 'm06_audit_page', 'm06_time_issues_page', 'm06_record_time_export']])).rows;
  assert.equal(fns.length, 9);
  const rest = (key, bearer, pathname, init = {}) => fetch(`${h.api}/rest/v1/${pathname}`, { ...init, headers: { apikey: key, Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  for (const [key, bearer] of [[h.anonKey, h.anonKey], [h.anonKey, A.owner.accessToken]]) {
    for (const table of ['employee_time_events', 'employee_time_effective_events', 'employee_time_corrections', 'employee_management_actions', 'employee_time_issue_resolutions', 'employees', 'zude_devices', 'employee_sessions']) {
      const r = await rest(key, bearer, `${table}?select=*&limit=1`);
      assert.ok([401, 403].includes(r.status), `${table} readable by browser role (${r.status})`);
    }
    // Exact argument names, so PostgREST resolves the function and the denial is a privilege denial.
    for (const { proname, proargnames } of fns) {
      const r = await rest(key, bearer, `rpc/${proname}`, { method: 'POST', body: JSON.stringify(Object.fromEntries(proargnames.map(n => [n, null]))) });
      const body = await r.json();
      assert.ok([401, 403].includes(r.status) && body.code === '42501', `${proname} callable by browser role (${r.status} ${body.code})`);
    }
  }
  // Immutable originals: no role can rewrite them (owner postgres hits the trigger; service_role lacks privilege).
  for (const sql of ['update public.employee_time_events set occurred_at = occurred_at where id = $1', 'delete from public.employee_time_events where id = $1']) {
    await assert.rejects(h.admin.query(sql, [a.ids.in]), (e) => e.code === '42501');
    const c = await h.connect();
    await assert.rejects(h.serviceCall(c, sql, [a.ids.in]), (e) => e.code === '42501');
  }
  await assert.rejects(h.admin.query('truncate public.employee_time_events'), (e) => ['42501', '0A000'].includes(e.code));
  await h.invariants(A.business); await h.invariants(B.business);
});
