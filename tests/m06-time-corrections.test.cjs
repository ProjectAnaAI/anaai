// M06 Slice 4 — immutable time corrections. Real M04/M05/M06 migrations on
// PGlite (required: fails, never skips, without ZUDE_PGLITE_MODULE), real
// identity verification, real handlers. PGlite runs one connection, so the
// "concurrent" tests below prove serialized outcomes and lock placement, not
// true multi-connection interleaving (see docs/m06-slice-4-corrections.md).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { fixture } = require('./support/working-fixture.cjs');
const { as } = require('./support/pglite-db.cjs');
const H = 3600000, M = 60000, uuid = () => crypto.randomUUID();
const calc = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('server/time-calculation.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports: calc, Intl, Date, Math, Number, Map, Array, String });
const TZ = 'America/Los_Angeles';
const iso = (ms) => new Date(ms).toISOString();

async function setup(t) {
  const h = await fixture(t);
  const timesheets = h.load('server/handlers/timesheets.ts'), clock = h.load('server/handlers/time-clock.ts'), working = h.load('server/handlers/working.ts');
  // Optional hook between HTTP authorization and the SQL write.
  const rpc = h.service.rpc.bind(h.service);
  h.service.rpc = async (name, args) => { await h.hooks.beforeRpc?.(name, args); return rpc(name, args); };
  const json = async (r) => ({ status: r.status, body: await r.json() });
  const headers = (shared, extra = {}) => ({ Authorization: 'Bearer synthetic-account', 'Content-Type': 'application/json',
    ...(shared ? { 'x-zude-device': h.deviceCredential, 'x-zude-employee-session': h.sessionCredential } : {}), ...extra });
  const sheet = async (id, week, shared = false) => json(await timesheets.GET(new Request(`https://zude.test/api/management/timesheets/${id}${week ? '?weekStart=' + week : ''}`, { headers: headers(shared) })));
  const preview = async (id, body, { shared = false } = {}) => json(await timesheets.PREVIEW_CORRECTION(new Request(`https://zude.test/api/management/timesheets/${id}/corrections/preview`, { method: 'POST', headers: headers(shared), body: JSON.stringify(body) })));
  const commit = async (id, body, { shared = false, key = uuid() } = {}) => json(await timesheets.COMMIT_CORRECTION(new Request(`https://zude.test/api/management/timesheets/${id}/corrections`, { method: 'POST', headers: headers(shared, key ? { 'Idempotency-Key': key } : {}), body: JSON.stringify(body) })));
  // Preview first, then commit with its revision/watermark (the real flow).
  const correct = async (id, operations, { reason = 'Missed punch', weekStart, shared = false, key } = {}) => {
    const p = await preview(id, { operations, ...(weekStart ? { weekStart } : {}) }, { shared });
    if (p.status !== 200) return p;
    return commit(id, { operations, reason, expectedRevision: p.body.correction.basedOnRevision, expectedWatermark: p.body.correction.basedOnWatermark, ...(weekStart ? { weekStart } : {}) }, { shared, key });
  };
  const timeReq = (session, path, method = 'GET', body) => new Request('https://zude.test/api/' + path, { method,
    headers: { Authorization: `ZudeDevice ${h.deviceCredential}`, 'x-zude-employee-session': session, ...(method === 'POST' ? { 'Idempotency-Key': uuid(), 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const state = async (session) => json(await clock.STATE(timeReq(session, 'time-clock')));
  const myTime = async (session) => json(await clock.MY_TIME(timeReq(session, 'my-time')));
  const act = async (session, action, body = {}) => json(await clock[action](timeReq(session, 'time-clock/x', 'POST', body)));
  const roster = async () => json(await working.GET(new Request('https://zude.test/api/management/working', { headers: headers(false) })));
  const originals = async (id) => (await h.db.query('select id,seq,event_type,break_type,occurred_at from public.employee_time_events where employee_id=$1 order by seq', [id])).rows;
  const effective = async (id) => (await h.db.query('select id,seq,event_type,break_type,occurred_at,origin,replaced,correction_revision from public.employee_time_effective_events where employee_id=$1 order by seq', [id])).rows;
  const counts = async () => Object.fromEntries(await Promise.all(['employee_time_corrections', 'employee_time_correction_entries'].map(async t => [t, (await h.db.query(`select count(*)::int n from public.${t}`)).rows[0].n]))
    .then(async e => [...e, ['audit', (await h.db.query("select count(*)::int n from public.employee_management_actions where action='time.corrected'")).rows[0].n]]));
  // The projection must always equal the fold of immutable history.
  const consistent = async (id) => {
    const fold = (await h.db.query('select ids, vals, voided from public.m06_time_fold($1,$2)', [h.business, id])).rows[0];
    const live = fold.ids.filter(x => !fold.voided.includes(x));
    const rows = await effective(id);
    assert.deepEqual(rows.map(r => r.id), live, 'projection order = fold order');
    for (const r of rows) {
      const v = fold.vals[r.id];
      assert.equal(r.event_type, v.event_type); assert.equal(r.break_type, v.break_type);
      assert.equal(Date.parse(r.occurred_at), Date.parse(v.occurred_at)); assert.equal(r.origin, v.origin);
    }
    return rows;
  };
  const target = await h.employee({ name: 'Riley' });
  return { ...h, timesheets, clock, sheet, preview, commit, correct, state, myTime, act, roster, originals, effective, counts, consistent, target };
}
// Direct SQL calls of the RPC (account-mode owner unless overridden).
async function rpc(h, employee, operations, o = {}) {
  const revision = o.revision ?? (await h.db.query('select coalesce(max(revision),0)::int r from public.employee_time_corrections where employee_id=$1', [employee])).rows[0].r;
  const watermark = o.watermark ?? (await h.db.query('select coalesce(max(seq),0)::bigint w from public.employee_time_events where employee_id=$1', [employee])).rows[0].w;
  const actor = o.actor ?? { p_actor_id: h.account, p_authority_mode: 'account', p_expected_account_role: 'owner', p_actor_employee_id: null, p_actor_device_id: null, p_actor_session_id: null };
  const r = await as(h.db, 'service_role', `select public.m06_correct_employee_time($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,null,null) as r`,
    [h.business, employee, actor.p_actor_id, actor.p_authority_mode, actor.p_expected_account_role, actor.p_actor_employee_id, actor.p_actor_device_id, actor.p_actor_session_id,
     JSON.stringify(operations), o.reason ?? 'Correction', o.key ?? uuid(), revision, watermark, o.commit ?? true]);
  return r.rows[0].r;
}
async function rejects(promise, code, reason) {
  try { await promise; } catch (e) { assert.equal(e.code, code, e.message); if (reason) assert.equal(e.message, reason); return e; }
  assert.fail('expected ' + code);
}
const shift = async (h, id, start, end, extra = []) => {
  const rows = [await h.event(id, 'CLOCK_IN', start)];
  for (const [type, at, b] of extra) rows.push(await h.event(id, type, at, b));
  if (end) rows.push(await h.event(id, 'CLOCK_OUT', end));
  return rows;
};

// ---- Critical acceptance lifecycle (46–51, 41–45) ------------------------------------------
test('46-51/41-45. raw CLOCK_IN + inserted historical CLOCK_OUT: every read is OFF_CLOCK, then a real CLOCK_IN succeeds', async t => {
  const h = await setup(t);
  const now = Date.now(), week = calc.businessWeek(now, TZ);
  const start = Math.max(now - 10 * H, week.startsAt + M), span = Math.min(8 * H, now - start - 2 * M);
  const [clockIn] = await shift(h, h.target, start, null);
  const session = await h.sessionFor(h.target);
  assert.equal((await h.state(session.value)).body.state, 'WORKING', 'raw ledger ends with CLOCK_IN');
  const r = await h.correct(h.target, [{ op: 'INSERT', type: 'CLOCK_OUT', occurredAt: iso(start + span), after: clockIn.id }]);
  assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(r.body.correction.revision, 1);
  // All four authoritative reads agree.
  const clockView = await h.state(session.value), mine = await h.myTime(session.value), sheet = await h.sheet(h.target), working = await h.roster();
  assert.equal(clockView.body.state, 'OFF_CLOCK'); assert.equal(clockView.body.shift, null);
  assert.equal(mine.body.state, 'OFF_CLOCK'); assert.equal(working.body.employees.find(e => e.employee.id === h.target).state, 'OFF_CLOCK');
  assert.equal(sheet.body.totals.hasOpenShift, false);
  assert.equal(sheet.body.totals.workedMs, span); assert.equal(mine.body.week.workedMs, span, 'My Time and Timesheet agree');
  assert.deepEqual(sheet.body.events.map(e => [e.type, e.origin]), [['CLOCK_IN', 'original'], ['CLOCK_OUT', 'inserted']]);
  assert.equal(sheet.body.events[1].correctionRevision, 1);
  // The original is untouched; the real next CLOCK_IN is accepted and stored as an original.
  assert.deepEqual((await h.originals(h.target)).map(e => e.event_type), ['CLOCK_IN']);
  const next = await h.act(session.value, 'CLOCK_IN');
  assert.equal(next.status, 200, JSON.stringify(next.body)); assert.equal(next.body.state, 'WORKING');
  assert.deepEqual((await h.originals(h.target)).map(e => e.event_type), ['CLOCK_IN', 'CLOCK_IN'], 'new real event in employee_time_events');
  const rows = await h.consistent(h.target);
  assert.deepEqual(rows.map(e => [e.event_type, e.origin]), [['CLOCK_IN', 'original'], ['CLOCK_OUT', 'inserted'], ['CLOCK_IN', 'original']]);
  assert.equal((await h.state(session.value)).body.state, 'WORKING');
  assert.equal((await h.roster()).body.employees.find(e => e.employee.id === h.target).state, 'WORKING');
});
test('52-54. a correction closing an open break governs the next real action; clock-out auto break closure stays M05-compatible', async t => {
  const h = await setup(t), now = Date.now(), session = await h.sessionFor(h.target);
  const [, breakStart] = await shift(h, h.target, now - 3 * H, null, [['BREAK_START', now - 2 * H, 'MEAL']]);
  assert.equal((await h.state(session.value)).body.state, 'ON_MEAL_BREAK');
  assert.equal((await h.correct(h.target, [{ op: 'INSERT', type: 'BREAK_END', breakType: 'MEAL', occurredAt: iso(now - 90 * M), after: breakStart.id }])).status, 201);
  assert.equal((await h.state(session.value)).body.state, 'WORKING');
  assert.equal((await h.act(session.value, 'BREAK_END')).body.code, 'TIME_INVALID_TRANSITION', 'validated against the corrected break state');
  assert.equal((await h.act(session.value, 'CLOCK_OUT')).body.state, 'OFF_CLOCK');
  assert.deepEqual((await h.originals(h.target)).map(e => e.event_type), ['CLOCK_IN', 'BREAK_START', 'CLOCK_OUT'], 'one CLOCK_OUT, no extra BREAK_END');
  await h.consistent(h.target);
  // Re-opening a break by VOIDing its end: a real CLOCK_OUT ends it first, M05-style.
  const other = await h.employee({ name: 'Sam' }), s2 = await h.sessionFor(other);
  const [, , paidEnd] = await shift(h, other, now - 3 * H, null, [['BREAK_START', now - 2 * H, 'PAID'], ['BREAK_END', now - 110 * M, 'PAID']]);
  assert.equal((await h.correct(other, [{ op: 'VOID', target: paidEnd.id }])).status, 201);
  assert.equal((await h.state(s2.value)).body.state, 'ON_PAID_BREAK');
  assert.equal((await h.act(s2.value, 'CLOCK_OUT')).body.state, 'OFF_CLOCK');
  const tail = (await h.originals(other)).slice(-2);
  assert.deepEqual(tail.map(e => [e.event_type, e.break_type]), [['BREAK_END', 'PAID'], ['CLOCK_OUT', null]]); assert.equal(tail[0].occurred_at, tail[1].occurred_at);
  await h.consistent(other);
});

// ---- Schema / security (1–7) -----------------------------------------------------------------
test('1-5. originals, corrections, entries and the projection reject direct mutation by every role, even after grants; business deletion cascades', async t => {
  const h = await setup(t), now = Date.now();
  const [clockIn] = await shift(h, h.target, now - 5 * H, null);
  await rpc(h, h.target, [{ op: 'INSERT', type: 'CLOCK_OUT', occurredAt: iso(now - H), after: clockIn.id }]);
  const tables = ['employee_time_events', 'employee_time_corrections', 'employee_time_correction_entries', 'employee_time_effective_events'];
  for (const table of tables) {
    await rejects(h.db.query(`update public.${table} set business_id = business_id`), '42501');
    await rejects(h.db.query(`delete from public.${table}`), '42501');
    await rejects(h.db.query(`truncate public.${table} cascade`), '42501');
    for (const role of ['anon', 'authenticated']) await rejects(as(h.db, role, `select * from public.${table}`), '42501');
    for (const sql of [`delete from public.${table}`, `update public.${table} set business_id = business_id`]) await rejects(as(h.db, 'service_role', sql), '42501');
  }
  await rejects(as(h.db, 'service_role', `insert into public.employee_time_corrections (business_id, employee_id, revision, base_watermark, request_id, request_hash, reason) values ($1, $2, 9, 0, gen_random_uuid(), repeat('a',64), 'x')`, [h.business, h.target]), '42501');
  await rejects(h.db.query(`insert into public.employee_time_effective_events (id, business_id, employee_id, seq, event_type, occurred_at, origin, original_event_id) values (gen_random_uuid(), $1, $2, 999, 'CLOCK_IN', now(), 'inserted', null)`, [h.business, h.target]), '42501');
  // Accidental future privilege expansion: triggers still refuse.
  for (const table of tables) await h.db.exec(`grant insert, update, delete, truncate on public.${table} to service_role`);
  for (const table of tables) {
    await rejects(as(h.db, 'service_role', `delete from public.${table}`), '42501');
    await rejects(as(h.db, 'service_role', `update public.${table} set business_id = business_id`), '42501');
  }
  for (const table of tables) await h.db.exec(`revoke insert, update, delete, truncate on public.${table} from service_role`);
  await h.consistent(h.target);
  // Tenant deletion contract still removes everything for that business only.
  await h.db.query('delete from public.businesses where id = $1', [h.business]);
  for (const table of [...tables, 'employee_management_actions']) assert.equal((await h.db.query(`select count(*)::int n from public.${table} where business_id = $1`, [h.business])).rows[0].n, 0, table);
});
test('5. M06 correction and read-version RPCs are service-only; helpers are not callable', async t => {
  const h = await setup(t);
  const can = async (role, fn) => (await h.db.query(`select has_function_privilege($1, p.oid, 'EXECUTE') g from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$2`, [role, fn])).rows.every(r => r.g);
  const helpers = ['m06_time_next_state', 'm06_time_fold_apply', 'm06_time_fold', 'm06_time_validate', 'm06_time_write_projection', 'm06_effective_window', 'm06_time_history_immutable', 'm06_effective_events_guard', 'm06_effective_events_append'];
  for (const fn of helpers) for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await can(role, fn), false, `${role} ${fn}`);
  for (const role of ['anon', 'authenticated']) assert.equal(await can(role, 'm06_correct_employee_time'), false);
  assert.equal(await can('service_role', 'm06_correct_employee_time'), true);
  const executable = (await h.db.query(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname ~ '^m0[456]_' and has_function_privilege('service_role', p.oid, 'EXECUTE') order by 1`)).rows.map(r => r.proname);
  assert.deepEqual(executable, ['m04_write_employee', 'm05_record_time_event', 'm05_report_time_issue', 'm06_audit_page', 'm06_correct_employee_time', 'm06_ledger_read_versions', 'm06_record_time_export', 'm06_report_dataset', 'm06_resolve_time_issue', 'm06_time_issues_page']);
  for (const role of ['anon', 'authenticated']) await rejects(as(h.db, role, `select public.m06_correct_employee_time(null,null,null,null,null,null,null,null,'[]'::jsonb,null,null,null,null,false,null,null)`), '42501');
});
test('6. cross-business targets, events and history references fail', async t => {
  const h = await setup(t), now = Date.now();
  const foreign = await h.employee({ tenant: h.other, name: 'Elsewhere' });
  await rejects(rpc(h, foreign, [{ op: 'VOID', target: uuid() }]), 'Z0003');
  assert.equal((await h.preview(foreign, { operations: [{ op: 'VOID', target: uuid() }] })).status, 404);
  const [mine] = await shift(h, h.target, now - 5 * H, null);
  const other = await h.employee({ name: 'Other' });
  await rejects(rpc(h, other, [{ op: 'VOID', target: mine.id }]), 'Z0001', 'TARGET_NOT_FOUND');
  await rejects(rpc(h, other, [{ op: 'INSERT', type: 'CLOCK_IN', occurredAt: iso(now - 6 * H), after: mine.id }]), 'Z0001', 'ANCHOR_NOT_FOUND');
  const c = await rpc(h, h.target, [{ op: 'INSERT', type: 'CLOCK_OUT', occurredAt: iso(now - H), after: mine.id }]);
  await rejects(h.db.query(`insert into public.employee_management_actions (business_id, subject_employee_id, actor_user_id, authority_mode, account_role, effective_role, action, before_value, after_value, reason, correction_id) values ($1, $2, $3, 'account', 'owner', 'owner', 'time.corrected', '{}', '{}', 'x', $4)`, [h.other, foreign, h.account, c.correction_id]), '23503');
});
test('7/65. correction history and audit contain no credential, session or PIN material', async t => {
  const h = await setup(t), now = Date.now();
  const [clockIn] = await shift(h, h.target, now - 5 * H, null);
  const r = await h.correct(h.target, [{ op: 'INSERT', type: 'CLOCK_OUT', occurredAt: iso(now - H), after: clockIn.id }], { shared: true });
  assert.equal(r.status, 201);
  const secrets = [h.deviceCredential, h.sessionCredential, 'synthetic-hash', 'synthetic-salt', 'synthetic-account'];
  const dump = JSON.stringify([
    (await h.db.query('select * from public.employee_time_corrections')).rows, (await h.db.query('select * from public.employee_time_correction_entries')).rows,
    (await h.db.query("select * from public.employee_management_actions where action='time.corrected'")).rows, r.body]);
  for (const secret of secrets) assert.ok(!dump.includes(secret), 'no secret material');
  for (const column of ['token', 'hash', 'salt', 'credential', 'pin']) {
    const cols = (await h.db.query(`select table_name, column_name from information_schema.columns where table_name in ('employee_time_corrections','employee_time_correction_entries','employee_time_effective_events') and column_name like $1`, [`%${column}%`])).rows;
    assert.deepEqual(cols.filter(c => c.column_name !== 'request_hash'), [], column);
  }
});

// ---- Authority (8–15) -------------------------------------------------------------------------
test('8-12. employee PIN forbidden; manager corrects regular employees only; owner corrects every role', async t => {
  const h = await setup(t), now = Date.now();
  const make = async (role) => { const id = await h.employee({ role, name: role }); const [e] = await shift(h, id, now - 5 * H, null); return { id, op: [{ op: 'INSERT', type: 'CLOCK_OUT', occurredAt: iso(now - H), after: e.id }] }; };
  const staff = await make('employee'), mgr = await make('manager'), own = await make('owner');
  // Shared manager PIN (account owner narrowed to manager).
  assert.equal((await h.correct(staff.id, staff.op, { shared: true })).status, 201, 'manager → employee');
  for (const t2 of [mgr, own]) {
    assert.equal((await h.preview(t2.id, { operations: t2.op }, { shared: true })).status, 403);
    assert.equal((await h.commit(t2.id, { operations: t2.op, reason: 'x', expectedRevision: 0, expectedWatermark: 1 }, { shared: true })).status, 403);
  }
  // Transactional, not only HTTP: manager authority in SQL cannot target a manager.
  const managerActor = { p_actor_id: h.account, p_authority_mode: 'shared-device', p_expected_account_role: 'owner', p_actor_employee_id: h.actor, p_actor_device_id: h.device, p_actor_session_id: h.session };
  await rejects(rpc(h, mgr.id, mgr.op, { actor: managerActor }), '42501');
  await rejects(rpc(h, own.id, own.op, { actor: managerActor }), '42501');
  // Owner account corrects manager and owner employees.
  for (const t2 of [mgr, own]) assert.equal((await h.correct(t2.id, t2.op)).status, 201);
  // Employee PIN: actor demoted to a regular employee.
  await h.db.query("update public.employees set role='employee' where id=$1", [h.actor]);
  const e2 = await make('employee');
  assert.equal((await h.preview(e2.id, { operations: e2.op }, { shared: true })).status, 403);
  assert.equal((await h.commit(e2.id, { operations: e2.op, reason: 'x', expectedRevision: 0, expectedWatermark: 1 }, { shared: true })).status, 403);
  // Staff account.
  await h.db.query("update public.business_members set role='staff'");
  assert.equal((await h.preview(e2.id, { operations: e2.op })).status, 403);
  assert.deepEqual(await h.counts(), { employee_time_corrections: 3, employee_time_correction_entries: 3, audit: 3 });
});
for (const [name, change, status] of [
  ['13. actor demotion', h => h.db.query("update public.business_members set role='staff'"), 403],
  ['13. actor manager PIN demoted', h => h.db.query("update public.employees set role='employee' where id=$1", [h.actor]), 403],
  ['14. session revoked', h => h.db.query('update public.employee_sessions set revoked_at=now() where id=$1', [h.session]), 401],
  ['14. device revoked', h => h.db.query('update public.zude_devices set revoked_at=now() where id=$1', [h.device]), 401],
  ['15. target promoted', h => h.db.query("update public.employees set role='manager' where id=$1", [h.target]), 403],
]) test(`${name} between HTTP authorization and commit fails with no history`, async t => {
  const h = await setup(t), now = Date.now();
  const [clockIn] = await shift(h, h.target, now - 5 * H, null);
  const before = await h.effective(h.target);
  h.hooks.beforeRpc = async (fn) => { if (fn === 'm06_correct_employee_time') { h.hooks.beforeRpc = null; await change(h); } };
  const r = await h.commit(h.target, { operations: [{ op: 'INSERT', type: 'CLOCK_OUT', occurredAt: iso(now - H), after: clockIn.id }], reason: 'x', expectedRevision: 0, expectedWatermark: clockIn.seq }, { shared: true });
  assert.equal(r.status, status, JSON.stringify(r.body));
  assert.deepEqual(await h.counts(), { employee_time_corrections: 0, employee_time_correction_entries: 0, audit: 0 });
  assert.deepEqual(await h.effective(h.target), before);
});

// ---- Revision / watermark / idempotency (16–21) ------------------------------------------------
test('16/17. stale revision and a moved original-ledger watermark fail explicitly with no write', async t => {
  const h = await setup(t), now = Date.now(), session = await h.sessionFor(h.target);
  const [clockIn] = await shift(h, h.target, now - 6 * H, null);
  const op = [{ op: 'INSERT', type: 'CLOCK_OUT', occurredAt: iso(now - 5 * H), after: clockIn.id }];
  const p = (await h.preview(h.target, { operations: op })).body.correction;
  assert.deepEqual([p.basedOnRevision, p.basedOnWatermark], [0, clockIn.seq]);
  const stale = await h.commit(h.target, { operations: op, reason: 'x', expectedRevision: 1, expectedWatermark: p.basedOnWatermark });
  assert.equal(stale.status, 409); assert.equal(stale.body.code, 'TIME_CORRECTION_STALE');
  // A real clock action after the preview moves the watermark.
  assert.equal((await h.act(session.value, 'BREAK_START', { breakType: 'PAID' })).status, 200);
  const moved = await h.commit(h.target, { operations: op, reason: 'x', expectedRevision: 0, expectedWatermark: p.basedOnWatermark });
  assert.equal(moved.status, 409); assert.equal(moved.body.code, 'TIME_CORRECTION_STALE'); assert.ok(moved.body.watermark > p.basedOnWatermark);
  assert.deepEqual(await h.counts(), { employee_time_corrections: 0, employee_time_correction_entries: 0, audit: 0 });
});
test('18/19. concurrent corrections and a racing clock action serialize to one valid ledger (PGlite: serialized proof only)', async t => {
  const h = await setup(t), now = Date.now();
  const [clockIn] = await shift(h, h.target, now - 6 * H, null);
  const body = (at) => ({ operations: [{ op: 'INSERT', type: 'CLOCK_OUT', occurredAt: iso(at), after: clockIn.id }], reason: 'x', expectedRevision: 0, expectedWatermark: clockIn.seq });
  const both = await Promise.all([h.commit(h.target, body(now - 5 * H)), h.commit(h.target, body(now - 4 * H))]);
  assert.deepEqual(both.map(r => r.status).sort(), [201, 409]);
  // Clock action vs correction against the same base.
  const other = await h.employee({ name: 'Racer' }), s2 = await h.sessionFor(other);
  const [in2] = await shift(h, other, now - 6 * H, null);
  const race = await Promise.all([h.commit(other, { ...body(now - 5 * H), operations: [{ op: 'INSERT', type: 'CLOCK_OUT', occurredAt: iso(now - 5 * H), after: in2.id }], expectedWatermark: in2.seq }), h.act(s2.value, 'CLOCK_OUT')]);
  const rows = await h.consistent(other);
  assert.equal(rows.filter(e => e.event_type === 'CLOCK_OUT').length, 1, 'exactly one effective clock-out');
  // Whichever commits first wins; the other is refused (stale watermark, or an
  // invalid transition against the corrected state). Never both, never neither.
  assert.equal(race.filter(r => r.status === 409).length, 1); assert.equal(race.filter(r => r.status < 300).length, 1);
  assert.deepEqual(rows.map(e => e.event_type), ['CLOCK_IN', 'CLOCK_OUT']);
  const source = fs.readFileSync('supabase/migrations/202610050001_m06_time_corrections.sql', 'utf8');
  assert.equal((source.match(/hashtextextended\('zude:m05:time:' \|\| p_business_id::text \|\| ':' \|\| p_employee_id::text, 505\)/g) || []).length, 2, 'corrections and clock actions share the per-employee lock');
});
test('20/21. idempotent replay creates one correction; same key with a different payload conflicts; replay after a lost response', async t => {
  const h = await setup(t), now = Date.now();
  const [clockIn] = await shift(h, h.target, now - 6 * H, null);
  const key = uuid(), body = { operations: [{ op: 'INSERT', type: 'CLOCK_OUT', occurredAt: iso(now - 5 * H), after: clockIn.id }], reason: 'Missed punch', expectedRevision: 0, expectedWatermark: clockIn.seq };
  const first = await h.commit(h.target, body, { key });
  // "Response lost": the retry carries the now-stale revision and still replays.
  const retry = await h.commit(h.target, body, { key });
  assert.equal(first.status, 201); assert.equal(retry.status, 200); assert.equal(retry.body.correction.replayed, true); assert.equal(retry.body.correction.id, first.body.correction.id);
  for (const changed of [{ ...body, reason: 'Other reason' }, { ...body, operations: [{ ...body.operations[0], occurredAt: iso(now - 4 * H) }] }]) {
    const r = await h.commit(h.target, changed, { key });
    assert.equal(r.status, 409); assert.equal(r.body.code, 'TIME_REQUEST_CONFLICT');
  }
  assert.deepEqual(await h.counts(), { employee_time_corrections: 1, employee_time_correction_entries: 1, audit: 1 });
  assert.equal((await h.commit(h.target, body, { key: null })).status, 400, 'Idempotency-Key required');
});

// ---- Operations (22–28) and ordering (37–40) ---------------------------------------------------
test('22-24/38. INSERT missing CLOCK_OUT, a missing whole shift, and same-instant break events in deterministic order', async t => {
  const h = await setup(t), now = Date.now(), base = now - 30 * H;
  const [in1] = await shift(h, h.target, base, base + 4 * H);
  await rpc(h, h.target, [
    { op: 'INSERT', type: 'CLOCK_IN', occurredAt: iso(base - 6 * H), atStart: true, ref: 'in0' },
    { op: 'INSERT', type: 'CLOCK_OUT', occurredAt: iso(base - 2 * H), afterRef: 'in0', ref: 'out0' },
    { op: 'INSERT', type: 'BREAK_START', breakType: 'PAID', occurredAt: iso(base + H), after: in1.id, ref: 'b1' },
    { op: 'INSERT', type: 'BREAK_END', breakType: 'PAID', occurredAt: iso(base + H), afterRef: 'b1' },
  ]);
  const rows = await h.consistent(h.target);
  assert.deepEqual(rows.map(e => e.event_type), ['CLOCK_IN', 'CLOCK_OUT', 'CLOCK_IN', 'BREAK_START', 'BREAK_END', 'CLOCK_OUT']);
  assert.equal(rows[3].occurred_at, rows[4].occurred_at, 'same instant, deterministic order');
  assert.deepEqual(rows.map(e => e.origin), ['inserted', 'inserted', 'original', 'inserted', 'inserted', 'original']);
  // Rebuilding from history again yields the identical order.
  const fold = (await h.db.query('select ids, voided from public.m06_time_fold($1,$2)', [h.business, h.target])).rows[0];
  assert.deepEqual(fold.ids, rows.map(r => r.id));
  // Inserting before an existing event works too.
  const r2 = await rpc(h, h.target, [{ op: 'INSERT', type: 'CLOCK_OUT', occurredAt: iso(base + 30 * M), before: rows[3].id, ref: 'x' }, { op: 'INSERT', type: 'CLOCK_IN', occurredAt: iso(base + 45 * M), afterRef: 'x' }]);
  assert.equal(r2.ok, true);
  assert.deepEqual((await h.consistent(h.target)).map(e => e.event_type), ['CLOCK_IN', 'CLOCK_OUT', 'CLOCK_IN', 'CLOCK_OUT', 'CLOCK_IN', 'BREAK_START', 'BREAK_END', 'CLOCK_OUT']);
});
test('25-28/39/40. VOID, REPLACE (time and break type), correcting an inserted event, and reversal by a later revision', async t => {
  const h = await setup(t), now = Date.now(), base = now - 30 * H;
  const [in1, bs, be, out1] = await shift(h, h.target, base, base + 8 * H, [['BREAK_START', base + 2 * H, 'PAID'], ['BREAK_END', base + 2 * H + 10 * M, 'PAID']]);
  const before = await h.effective(h.target);
  // 25. VOID a mistaken break (both ends); remaining order unchanged.
  await rpc(h, h.target, [{ op: 'VOID', target: bs.id }, { op: 'VOID', target: be.id }]);
  let rows = await h.consistent(h.target);
  assert.deepEqual(rows.map(r => r.id), [in1.id, out1.id], '40. void does not reorder');
  // 28. reversal: re-insert the break in its original slots.
  await rpc(h, h.target, [{ op: 'INSERT', type: 'BREAK_START', breakType: 'PAID', occurredAt: bs.occurred_at, after: bs.id, ref: 's' }, { op: 'INSERT', type: 'BREAK_END', breakType: 'PAID', occurredAt: be.occurred_at, afterRef: 's' }]);
  rows = await h.consistent(h.target);
  assert.deepEqual(rows.map(r => [r.event_type, r.break_type, Date.parse(r.occurred_at)]), before.map(r => [r.event_type, r.break_type, Date.parse(r.occurred_at)]), 'restored interpretation');
  // 26/39. REPLACE: clock-in earlier, break type PAID→MEAL on both ends; positions kept.
  await rpc(h, h.target, [{ op: 'REPLACE', target: in1.id, occurredAt: iso(base - 30 * M) },
    { op: 'REPLACE', target: rows[1].id, occurredAt: rows[1].occurred_at, breakType: 'MEAL' }, { op: 'REPLACE', target: rows[2].id, occurredAt: iso(base + 2 * H + 30 * M), breakType: 'MEAL' }]);
  const replaced = await h.consistent(h.target);
  assert.deepEqual(replaced.map(r => r.id), rows.map(r => r.id), '39. replace preserves logical position');
  assert.deepEqual(replaced.map(r => r.replaced), [true, true, true, false]);
  assert.equal(replaced[0].origin, 'original'); assert.equal(replaced[0].correction_revision, 3);
  // 27. correct an inserted event again (REPLACE then VOID).
  await rpc(h, h.target, [{ op: 'REPLACE', target: rows[1].id, occurredAt: iso(base + 2 * H + 5 * M) }]);
  assert.equal(Date.parse((await h.consistent(h.target))[1].occurred_at), base + 2 * H + 5 * M);
  // Originals were never modified.
  assert.deepEqual((await h.originals(h.target)).map(e => [e.id, e.event_type, e.occurred_at]), [in1, bs, be, out1].map(e => [e.id, e.event_type, e.occurred_at]));
  assert.equal((await h.db.query('select count(*)::int n from public.employee_time_corrections where employee_id=$1', [h.target])).rows[0].n, 4);
});
test('37. same-timestamp originals keep seq order through a correction elsewhere', async t => {
  const h = await setup(t), now = Date.now(), session = await h.sessionFor(h.target);
  const [in1] = await shift(h, h.target, now - 30 * H, now - 25 * H);
  await h.act(session.value, 'CLOCK_IN'); await h.act(session.value, 'BREAK_START', { breakType: 'PAID' }); await h.act(session.value, 'CLOCK_OUT');
  const tail = (await h.originals(h.target)).slice(-2);
  assert.equal(tail[0].occurred_at, tail[1].occurred_at);
  await rpc(h, h.target, [{ op: 'REPLACE', target: in1.id, occurredAt: iso(now - 31 * H) }]);
  const rows = await h.consistent(h.target);
  assert.deepEqual(rows.slice(-2).map(r => r.event_type), ['BREAK_END', 'CLOCK_OUT']);
  assert.equal((await h.state(session.value)).body.state, 'OFF_CLOCK');
});

// ---- Validation (29–36) --------------------------------------------------------------------------
test('29-36. invalid ledgers are rejected with safe reasons and nothing is written', async t => {
  const h = await setup(t), now = Date.now(), base = now - 30 * H;
  const [in1, bs, be, out1] = await shift(h, h.target, base, base + 8 * H, [['BREAK_START', base + 2 * H, 'PAID'], ['BREAK_END', base + 2 * H + 10 * M, 'PAID']]);
  const before = await h.effective(h.target);
  const cases = [
    ['29 CLOCK_OUT while off', [{ op: 'INSERT', type: 'CLOCK_OUT', occurredAt: iso(base + 9 * H), after: out1.id }], 'INVALID_TRANSITION'],
    ['30 duplicate CLOCK_IN', [{ op: 'INSERT', type: 'CLOCK_IN', occurredAt: iso(base + H), after: in1.id }], 'INVALID_TRANSITION'],
    ['31 BREAK_END while working', [{ op: 'INSERT', type: 'BREAK_END', breakType: 'PAID', occurredAt: iso(base + H), after: in1.id }], 'INVALID_TRANSITION'],
    ['32 nested break', [{ op: 'INSERT', type: 'BREAK_START', breakType: 'MEAL', occurredAt: iso(base + 2 * H + 5 * M), after: bs.id }], 'INVALID_TRANSITION'],
    ['33 mismatched break end', [{ op: 'REPLACE', target: be.id, occurredAt: be.occurred_at, breakType: 'MEAL' }], 'INVALID_TRANSITION'],
    ['34 decreasing time', [{ op: 'INSERT', type: 'BREAK_START', breakType: 'MEAL', occurredAt: iso(base + 3 * H), after: in1.id, ref: 'a' }, { op: 'INSERT', type: 'BREAK_END', breakType: 'MEAL', occurredAt: iso(base + 3 * H), afterRef: 'a' }], 'OUT_OF_ORDER'],
    ['34 replace past a neighbour', [{ op: 'REPLACE', target: bs.id, occurredAt: iso(base + 9 * H) }], 'OUT_OF_ORDER'],
    ['35 future event', [{ op: 'REPLACE', target: out1.id, occurredAt: iso(now + 10 * M) }, { op: 'INSERT', type: 'CLOCK_IN', occurredAt: iso(now + 20 * M), after: out1.id }], 'FUTURE_EVENT'],
    ['36 overlapping shift inside a shift', [{ op: 'INSERT', type: 'CLOCK_IN', occurredAt: iso(base + H), after: in1.id, ref: 'i2' }, { op: 'INSERT', type: 'CLOCK_OUT', occurredAt: iso(base + 90 * M), afterRef: 'i2' }], 'INVALID_TRANSITION'],
    ['36 overlapping shift by time', [{ op: 'INSERT', type: 'CLOCK_IN', occurredAt: iso(base + 7 * H), after: out1.id, ref: 'i' }, { op: 'INSERT', type: 'CLOCK_OUT', occurredAt: iso(base + 9 * H), afterRef: 'i' }], 'OUT_OF_ORDER'],
    ['void only one break end', [{ op: 'VOID', target: be.id }], 'INVALID_TRANSITION'],
    ['void twice', [{ op: 'VOID', target: bs.id }, { op: 'VOID', target: bs.id }], 'TARGET_VOIDED'],
    ['unknown target', [{ op: 'VOID', target: uuid() }], 'TARGET_NOT_FOUND'],
    ['unknown anchor', [{ op: 'INSERT', type: 'CLOCK_IN', occurredAt: iso(base - H), after: uuid() }], 'ANCHOR_NOT_FOUND'],
    ['break type on a clock event', [{ op: 'REPLACE', target: in1.id, occurredAt: in1.occurred_at, breakType: 'PAID' }], 'INVALID_OPERATION'],
  ];
  for (const [label, ops, reason] of cases) {
    await rejects(rpc(h, h.target, ops), 'Z0001', reason);
    const r = await h.preview(h.target, { operations: ops });
    assert.equal(r.status, 422, label); assert.equal(r.body.code, 'TIME_CORRECTION_INVALID'); assert.equal(r.body.reason, reason, label);
  }
  for (const ops of [[], [{ op: 'MOVE', target: in1.id }], [{ op: 'VOID', target: in1.id, extra: 1 }], [{ op: 'INSERT', type: 'CLOCK_IN', occurredAt: 'yesterday', atStart: true }],
    [{ op: 'INSERT', type: 'CLOCK_IN', occurredAt: iso(base - H) }], [{ op: 'INSERT', type: 'CLOCK_IN', occurredAt: iso(base - H), atStart: true, after: in1.id }],
    [{ op: 'INSERT', type: 'BREAK_START', occurredAt: iso(base - H), atStart: true }], [{ op: 'INSERT', type: 'CLOCK_IN', occurredAt: '2026-01-01T00:00:00', atStart: true }],
    Array.from({ length: 21 }, () => ({ op: 'VOID', target: in1.id }))]) {
    assert.equal((await h.preview(h.target, { operations: ops })).status, 400, JSON.stringify(ops).slice(0, 60));
  }
  assert.equal((await h.commit(h.target, { operations: [{ op: 'VOID', target: bs.id }, { op: 'VOID', target: be.id }], reason: '   ', expectedRevision: 0, expectedWatermark: out1.seq })).status, 400, 'reason required');
  assert.equal((await h.commit(h.target, { operations: [{ op: 'VOID', target: bs.id }, { op: 'VOID', target: be.id }], reason: 'x'.repeat(501), expectedRevision: 0, expectedWatermark: out1.seq })).status, 400, 'reason bounded');
  assert.deepEqual(await h.effective(h.target), before);
  assert.deepEqual(await h.counts(), { employee_time_corrections: 0, employee_time_correction_entries: 0, audit: 0 }, '63. failed corrections create no history');
});

// ---- Preview ---------------------------------------------------------------------------------------
test('preview returns the corrected week without writing anything, and equals the committed timesheet', async t => {
  const h = await setup(t), weekStart = '2026-03-02', start = Date.parse('2026-03-01T22:00:00-08:00');
  const [clockIn] = await shift(h, h.target, start, null);
  // Sunday-night shift left open: carried into Monday's week until corrected.
  const ops = [{ op: 'INSERT', type: 'CLOCK_OUT', occurredAt: '2026-03-02T02:00:00-08:00', after: clockIn.id }];
  const before = await h.effective(h.target), raw = await h.sheet(h.target, weekStart);
  assert.equal(raw.body.totals.hasOpenShift, true);
  const p = await h.preview(h.target, { operations: ops, weekStart });
  assert.equal(p.status, 200); assert.equal(p.body.preview, true); assert.equal(p.body.correction.resultingState, 'OFF_CLOCK');
  assert.equal(p.body.totals.workedMs, 2 * H, '58. only the Monday part counts in this week'); assert.equal(p.body.totals.hasOpenShift, false);
  assert.deepEqual(await h.effective(h.target), before, 'preview wrote nothing'); assert.deepEqual(await h.counts(), { employee_time_corrections: 0, employee_time_correction_entries: 0, audit: 0 });
  const c = await h.commit(h.target, { operations: ops, weekStart, reason: 'Forgot to clock out', expectedRevision: p.body.correction.basedOnRevision, expectedWatermark: p.body.correction.basedOnWatermark });
  assert.equal(c.status, 201);
  // Inserted events get their permanent logical id at commit; preview ids are provisional.
  const strip = (b) => ({ totals: b.totals, days: b.days, week: b.week, events: b.events.map(e => e.origin === 'inserted' ? { ...e, id: 'provisional' } : e) });
  assert.deepEqual(strip(p.body), strip(c.body), 'preview == committed result');
  assert.deepEqual(strip(c.body), strip((await h.sheet(h.target, weekStart)).body));
  const prior = await h.sheet(h.target, '2026-02-23');
  assert.equal(prior.body.totals.workedMs, 2 * H, 'previous week keeps the Sunday part');
});

// ---- Calculation regression with corrections (55–61) -------------------------------------------
test('55-61. paid/meal totals, overnight split, DST spring/fall and open-shift snapshots over corrected ledgers', async t => {
  const h = await setup(t);
  // 55/56: no correction → original totals; then inserted breaks change totals exactly.
  const day = Date.parse('2026-03-17T09:00:00-07:00');
  const [in1, out1] = await shift(h, h.target, day, day + 8 * H);
  const plain = await h.sheet(h.target, '2026-03-16');
  assert.equal(plain.body.totals.workedMs, 8 * H);
  await rpc(h, h.target, [{ op: 'INSERT', type: 'BREAK_START', breakType: 'PAID', occurredAt: iso(day + H), after: in1.id, ref: 'p' },
    { op: 'INSERT', type: 'BREAK_END', breakType: 'PAID', occurredAt: iso(day + H + 10 * M), afterRef: 'p', ref: 'pe' },
    { op: 'INSERT', type: 'BREAK_START', breakType: 'MEAL', occurredAt: iso(day + 4 * H), afterRef: 'pe', ref: 'm' },
    { op: 'INSERT', type: 'BREAK_END', breakType: 'MEAL', occurredAt: iso(day + 4 * H + 30 * M), afterRef: 'm' }]);
  const corrected = (await h.sheet(h.target, '2026-03-16')).body.totals;
  assert.deepEqual([corrected.workedMs, corrected.paidBreakMs, corrected.mealBreakMs], [7.5 * H, 10 * M, 30 * M]);
  assert.ok(out1);
  // 59: DST spring (LA, Sun 2026-03-08): Sat 22:00 → Sun 06:00 local is 7 real hours.
  const sp = await h.employee({ name: 'Spring' }), [spIn] = await shift(h, sp, Date.parse('2026-03-07T22:00:00-08:00'), null);
  await rpc(h, sp, [{ op: 'INSERT', type: 'CLOCK_OUT', occurredAt: '2026-03-08T06:00:00-07:00', after: spIn.id }]);
  const spring = (await h.sheet(sp, '2026-03-02')).body;
  assert.equal(spring.totals.workedMs, 7 * H); assert.deepEqual(spring.days.slice(5).map(d => d.workedMs), [2 * H, 5 * H], '57. overnight split by local day');
  // 60: DST fall (LA, Sun 2025-11-02): Sat 22:00 → Sun 06:00 local is 9 real hours.
  const fa = await h.employee({ name: 'Fall' }), [faIn] = await shift(h, fa, Date.parse('2025-11-01T22:00:00-07:00'), null);
  await rpc(h, fa, [{ op: 'INSERT', type: 'CLOCK_OUT', occurredAt: '2025-11-02T06:00:00-08:00', after: faIn.id }]);
  assert.equal((await h.sheet(fa, '2025-10-27')).body.totals.workedMs, 9 * H);
  // 61: VOIDing a clock-out re-opens the shift; totals run to the snapshot.
  const op = await h.employee({ name: 'Open' }), now = Date.now(), wk = calc.businessWeek(now, TZ), st = Math.max(now - 3 * H, wk.startsAt + M);
  const [, opOut] = await shift(h, op, st, st + M);
  await rpc(h, op, [{ op: 'VOID', target: opOut.id }]);
  const open = (await h.sheet(op)).body;
  assert.equal(open.totals.hasOpenShift, true);
  assert.equal(open.totals.workedMs, Date.parse(open.snapshotAt) - st);
});
test('55. without corrections the effective ledger is the original ledger (ids, seq, values), including the migration backfill', async t => {
  const { loadPGlite, openDatabase } = require('./support/pglite-db.cjs');
  const db = await openDatabase(loadPGlite(), { m06: false }); t.after(() => db.close());
  const b = uuid(), e = uuid(), d = uuid();
  await db.query("insert into public.businesses(id,name) values ($1,'B')", [b]);
  await db.query("insert into public.employees(id,business_id,display_name,pin_hash,pin_salt) values ($1,$2,'E','h','s')", [e, b]);
  await db.query("insert into public.zude_devices(id,business_id,name,credential_hash,credential_salt) values ($1,$2,'i','h','s')", [d, b]);
  for (const [type, brk, ago] of [['CLOCK_IN', null, 5], ['BREAK_START', 'PAID', 4], ['BREAK_END', 'PAID', 4], ['CLOCK_OUT', null, 1]]) {
    await db.query("insert into public.employee_time_events(business_id,employee_id,device_id,event_type,break_type,occurred_at,request_id) values ($1,$2,$3,$4,$5,now()-($6||' hours')::interval,gen_random_uuid())", [b, e, d, type, brk, ago]);
  }
  for (const file of ['202610020001_m06_management_authority_audit.sql', '202610050001_m06_time_corrections.sql']) await db.exec(fs.readFileSync('supabase/migrations/' + file, 'utf8'));
  const cols = 'id,seq,event_type,break_type,occurred_at';
  await db.query("insert into public.employee_time_events(business_id,employee_id,device_id,event_type,occurred_at,request_id) values ($1,$2,$3,'CLOCK_IN',now(),gen_random_uuid())", [b, e, d]);
  const original = (await db.query(`select ${cols} from public.employee_time_events order by seq`)).rows;
  const effective = (await db.query(`select ${cols} from public.employee_time_effective_events order by seq`)).rows;
  assert.deepEqual(effective, original);
  assert.ok((await db.query('select bool_and(origin = $1 and not replaced and correction_id is null) ok from public.employee_time_effective_events', ['original'])).rows[0].ok);
});

// ---- Audit (62–66) ---------------------------------------------------------------------------------
test('62-66. one audit row per committed correction with reason, verified attribution and reconstructable provenance', async t => {
  const h = await setup(t), now = Date.now();
  const [clockIn] = await shift(h, h.target, now - 6 * H, null);
  const r = await h.correct(h.target, [{ op: 'INSERT', type: 'CLOCK_OUT', occurredAt: iso(now - 5 * H), after: clockIn.id }], { shared: true, reason: '  Forgot to clock out  ' });
  assert.equal(r.status, 201);
  const audit = (await h.db.query("select * from public.employee_management_actions where action='time.corrected'")).rows;
  assert.equal(audit.length, 1);
  const a = audit[0];
  assert.equal(a.reason, 'Forgot to clock out'); assert.equal(a.correction_id, r.body.correction.id); assert.equal(a.subject_employee_id, h.target);
  assert.deepEqual([a.actor_user_id, a.authority_mode, a.actor_employee_id, a.actor_device_id, a.actor_session_id, a.account_role, a.effective_role],
    [h.account, 'shared-device', h.actor, h.device, h.session, 'owner', 'manager']);
  assert.deepEqual(a.before_value, { revision: 0, watermark: clockIn.seq, state: 'WORKING', event_count: 1 });
  assert.deepEqual(a.after_value, { revision: 1, watermark: clockIn.seq, state: 'OFF_CLOCK', event_count: 2, operation_count: 1 });
  // Provenance: correction + entries + untouched originals rebuild exactly the effective ledger.
  const entries = (await h.db.query('select operation, after_event_id, event_type, occurred_at from public.employee_time_correction_entries where correction_id=$1', [a.correction_id])).rows;
  assert.deepEqual(entries.map(e => [e.operation, e.after_event_id, e.event_type]), [['INSERT', clockIn.id, 'CLOCK_OUT']]);
  await h.consistent(h.target);
  // A replay adds no audit; a failed correction adds none.
  await rejects(rpc(h, h.target, [{ op: 'VOID', target: clockIn.id }]), 'Z0001');
  assert.equal((await h.db.query("select count(*)::int n from public.employee_management_actions where action='time.corrected'")).rows[0].n, 1);
  // Account mode attribution has no operational IDs.
  const other = await h.employee({ name: 'Acct' }), [i2] = await shift(h, other, now - 6 * H, null);
  await h.correct(other, [{ op: 'INSERT', type: 'CLOCK_OUT', occurredAt: iso(now - 5 * H), after: i2.id }]);
  const acct = (await h.db.query("select authority_mode, actor_employee_id, actor_device_id, actor_session_id from public.employee_management_actions where subject_employee_id=$1", [other])).rows[0];
  assert.deepEqual(acct, { authority_mode: 'account', actor_employee_id: null, actor_device_id: null, actor_session_id: null });
});

// ---- Employee scope unchanged -------------------------------------------------------------------
test('corrections never broaden employee access: My Time stays self-only and current-week-only, with no provenance', async t => {
  const h = await setup(t), now = Date.now(), wk = calc.businessWeek(now, TZ), st = Math.max(now - 3 * H, wk.startsAt + M);
  const [clockIn] = await shift(h, h.target, st, null);
  const other = await h.employee({ name: 'Other' }); await shift(h, other, st, null);
  await rpc(h, h.target, [{ op: 'INSERT', type: 'CLOCK_OUT', occurredAt: iso(st + Math.floor((now - st) / 2)), after: clockIn.id }]);
  const mine = (await h.myTime((await h.sessionFor(h.target)).value)).body;
  assert.equal(mine.employee.id, h.target); assert.ok(!JSON.stringify(mine).includes(other));
  assert.ok(!/origin|correction|revision|inserted/.test(JSON.stringify(mine)), 'no correction provenance in employee views');
  assert.equal(mine.week.startDate, wk.startDate);
});
