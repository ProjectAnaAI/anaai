// M05 ledger + state machine against REAL PostgreSQL (PGlite) with the real
// M04 and M05 migrations applied. Skipped (and reported) when PGlite is not
// installed; see tests/support/pglite-db.cjs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { loadPGlite, openDatabase, as } = require('./support/pglite-db.cjs');
const lib = loadPGlite();
const skip = lib ? false : 'PGlite not installed (set ZUDE_PGLITE_MODULE)';
const id = () => crypto.randomUUID();

async function fixture() {
  const db = await openDatabase(lib);
  const A = id(), B = id();
  await db.query(`insert into public.businesses (id, name, timezone) values ($1, 'A', 'America/New_York'), ($2, 'B', 'UTC')`, [A, B]);
  async function employee(business, role = 'employee') {
    const e = id();
    await db.query(`insert into public.employees (id, business_id, display_name, role, pin_hash, pin_salt, updated_at) values ($1, $2, 'E', $3, 'h', 's', now() - interval '10 hours')`, [e, business, role]);
    return e;
  }
  async function device(business) {
    const d = id();
    await db.query(`insert into public.zude_devices (id, business_id, name, credential_hash, credential_salt, updated_at) values ($1, $2, 'iPad', 'h', 's', now() - interval '9 hours')`, [d, business]);
    return d;
  }
  async function session(business, dev, emp, expires = "now() + interval '8 hours'") {
    const s = id();
    // As M04 issues it: created at the device's current PIN generation.
    await db.query(`insert into public.employee_sessions (id, business_id, device_id, employee_id, token_hash, token_salt, expires_at, created_at) values ($1, $2, $3, $4, 'h', 's', ${expires}, (select updated_at from public.zude_devices where id = $3))`, [s, business, dev, emp]);
    return s;
  }
  const a = { business: A, employee: await employee(A) };
  a.device = await device(A); a.session = await session(A, a.device, a.employee);
  // service_role, exactly as the server's service client calls it.
  async function record(who, action, breakType = null, key = id()) {
    const r = await as(db, 'service_role', `select public.m05_record_time_event($1, $2, $3, $4, $5, $6, $7) as r`, [who.business, who.employee, who.device, who.session, action, breakType, key]);
    return r.rows[0].r;
  }
  async function rejects(promise) { try { await promise; } catch (error) { return error.code; } assert.fail('expected a database error'); }
  const events = async (who = a) => (await db.query(`select event_type, break_type, occurred_at, seq, request_id, device_id from public.employee_time_events where business_id = $1 and employee_id = $2 order by seq`, [who.business, who.employee])).rows;
  return { db, A, B, a, employee, device, session, record, rejects, events };
}

test('first clock-in writes one database-stamped CLOCK_IN; replay is idempotent', { skip }, async () => {
  const f = await fixture(); const key = id();
  const before = Date.now();
  assert.deepEqual(await f.record(f.a, 'CLOCK_IN', null, key), { ok: true, replayed: false, state: 'WORKING' });
  assert.deepEqual(await f.record(f.a, 'CLOCK_IN', null, key), { ok: true, replayed: true, state: 'WORKING' });
  const rows = await f.events();
  assert.equal(rows.length, 1); assert.equal(rows[0].event_type, 'CLOCK_IN'); assert.equal(rows[0].device_id, f.a.device);
  assert.ok(Math.abs(Date.parse(rows[0].occurred_at) - before) < 60_000, 'server clock, not a client value');
});
test('double clock-in with a new key is an invalid transition and writes nothing', { skip }, async () => {
  const f = await fixture(); await f.record(f.a, 'CLOCK_IN');
  assert.deepEqual(await f.record(f.a, 'CLOCK_IN'), { ok: false, code: 'TIME_INVALID_TRANSITION', state: 'WORKING' });
  assert.equal((await f.events()).length, 1);
});
test('paid and meal breaks start and end; BREAK_END carries the break type', { skip }, async () => {
  const f = await fixture(); await f.record(f.a, 'CLOCK_IN');
  assert.equal((await f.record(f.a, 'BREAK_START', 'PAID')).state, 'ON_PAID_BREAK');
  assert.equal((await f.record(f.a, 'BREAK_END')).state, 'WORKING');
  assert.equal((await f.record(f.a, 'BREAK_START', 'MEAL')).state, 'ON_MEAL_BREAK');
  assert.equal((await f.record(f.a, 'BREAK_END')).state, 'WORKING');
  assert.equal((await f.record(f.a, 'CLOCK_OUT')).state, 'OFF_CLOCK');
  assert.deepEqual((await f.events()).map(e => [e.event_type, e.break_type]),
    [['CLOCK_IN', null], ['BREAK_START', 'PAID'], ['BREAK_END', 'PAID'], ['BREAK_START', 'MEAL'], ['BREAK_END', 'MEAL'], ['CLOCK_OUT', null]]);
});
test('invalid transitions are rejected without writes', { skip }, async () => {
  const f = await fixture();
  for (const [action, type] of [['BREAK_START', 'PAID'], ['BREAK_END', null], ['CLOCK_OUT', null]]) assert.equal((await f.record(f.a, action, type)).code, 'TIME_INVALID_TRANSITION', `${action} while off-clock`);
  await f.record(f.a, 'CLOCK_IN');
  assert.equal((await f.record(f.a, 'BREAK_END')).code, 'TIME_INVALID_TRANSITION', 'BREAK_END while working');
  await f.record(f.a, 'BREAK_START', 'PAID');
  for (const type of ['PAID', 'MEAL']) assert.equal((await f.record(f.a, 'BREAK_START', type)).code, 'TIME_INVALID_TRANSITION', 'nested break');
  assert.equal((await f.record(f.a, 'CLOCK_IN')).code, 'TIME_INVALID_TRANSITION');
  assert.equal((await f.events()).length, 2);
});
for (const type of ['PAID', 'MEAL']) {
  test(`clock out from a ${type} break writes BREAK_END then CLOCK_OUT atomically at one instant`, { skip }, async () => {
    const f = await fixture(); await f.record(f.a, 'CLOCK_IN'); await f.record(f.a, 'BREAK_START', type);
    const key = id();
    assert.deepEqual(await f.record(f.a, 'CLOCK_OUT', null, key), { ok: true, replayed: false, state: 'OFF_CLOCK' });
    const [, , end, out] = await f.events();
    assert.equal(end.event_type, 'BREAK_END'); assert.equal(end.break_type, type); assert.equal(out.event_type, 'CLOCK_OUT');
    assert.equal(end.occurred_at, out.occurred_at); assert.equal(out.seq, end.seq + 1); assert.equal(end.request_id, key); assert.equal(out.request_id, key);
    assert.deepEqual(await f.record(f.a, 'CLOCK_OUT', null, key), { ok: true, replayed: true, state: 'OFF_CLOCK' }, 'retry of the paired clock-out is a replay');
    assert.equal((await f.events()).length, 4);
  });
}
test('a request key reused for a different action is refused', { skip }, async () => {
  const f = await fixture(); const key = id(); await f.record(f.a, 'CLOCK_IN', null, key);
  assert.equal((await f.record(f.a, 'BREAK_START', 'PAID', key)).code, 'TIME_REQUEST_CONFLICT');
  await f.record(f.a, 'BREAK_START', 'PAID', id());
  const k2 = id(); await f.record(f.a, 'BREAK_END', null, k2); await f.record(f.a, 'BREAK_START', 'MEAL', id());
  // The same key + same action is always the ORIGINAL request: a late retry
  // never ends the newer meal break.
  assert.deepEqual(await f.record(f.a, 'BREAK_END', null, k2), { ok: true, replayed: true, state: 'ON_MEAL_BREAK' });
  assert.equal((await f.events()).at(-1).event_type, 'BREAK_START');
});
test('malformed actions raise 22023', { skip }, async () => {
  const f = await fixture();
  for (const [action, type] of [['BREAK_START', null], ['CLOCK_IN', 'PAID'], ['BREAK_START', 'LUNCH'], ['NAP', null], ['BREAK_END', 'PAID']]) {
    assert.equal(await f.rejects(f.record(f.a, action, type)), '22023', `${action}/${type}`);
  }
});
test('identity is re-verified in the transaction: inactive, revoked, locked, expired, foreign', { skip }, async () => {
  const f = await fixture(); const { db } = f;
  const other = { business: f.A, employee: await f.employee(f.A) }; other.device = f.a.device; other.session = await f.session(f.A, f.a.device, other.employee);
  assert.equal(await f.rejects(f.record({ ...f.a, session: other.session }, 'CLOCK_IN')), '42501', "another employee's session");
  const foreignDevice = await f.device(f.B);
  assert.equal(await f.rejects(f.record({ ...f.a, device: foreignDevice }, 'CLOCK_IN')), '42501', 'device of another business');
  assert.equal(await f.rejects(f.record({ ...f.a, business: f.B }, 'CLOCK_IN')), '42501', 'business mismatch');
  const expired = await f.session(f.A, f.a.device, f.a.employee, "now() - interval '1 minute'");
  assert.equal(await f.rejects(f.record({ ...f.a, session: expired }, 'CLOCK_IN')), '42501', 'expired session');
  await db.query(`update public.employee_sessions set revoked_at = now() where id = $1`, [other.session]);
  assert.equal(await f.rejects(f.record(other, 'CLOCK_IN')), '42501', 'locked (revoked) session');
  // M04: a later PIN attempt on the device starts a new generation and
  // invalidates older sessions, even if their Lock never arrived.
  const before = (await db.query(`select updated_at from public.zude_devices where id = $1`, [f.a.device])).rows[0].updated_at;
  await db.query(`update public.zude_devices set updated_at = now() where id = $1`, [f.a.device]);
  assert.equal(await f.rejects(f.record(f.a, 'CLOCK_IN')), '42501', 'superseded PIN generation');
  await db.query(`update public.zude_devices set updated_at = $2 where id = $1`, [f.a.device, before]);
  await db.query(`update public.zude_devices set revoked_at = now() where id = $1`, [f.a.device]);
  assert.equal(await f.rejects(f.record(f.a, 'CLOCK_IN')), '42501', 'revoked device');
  await db.query(`update public.zude_devices set revoked_at = null where id = $1`, [f.a.device]);
  await db.query(`update public.employees set is_active = false where id = $1`, [f.a.employee]);
  assert.equal(await f.rejects(f.record(f.a, 'CLOCK_IN')), '42501', 'inactive employee');
  assert.equal((await db.query('select count(*) as n from public.employee_time_events')).rows[0].n, 0);
});
test('session turnover, lock, device revocation and deactivation never write CLOCK_OUT', { skip }, async () => {
  const f = await fixture(); const { db } = f;
  await f.record(f.a, 'CLOCK_IN');
  await db.query(`update public.employee_sessions set revoked_at = now() where id = $1`, [f.a.session]);   // Lock
  await db.query(`update public.employee_sessions set expires_at = created_at + interval '1 second'`);    // expiry
  await db.query(`update public.zude_devices set revoked_at = now() where id = $1`, [f.a.device]);         // revocation
  assert.deepEqual((await f.events()).map(e => e.event_type), ['CLOCK_IN']);
  // A new PIN session on another registered device of the same business continues the shift.
  const next = { ...f.a, device: await f.device(f.A) }; next.session = await f.session(f.A, next.device, f.a.employee);
  assert.equal((await f.record(next, 'CLOCK_IN')).code, 'TIME_INVALID_TRANSITION', 'still WORKING after turnover');
  assert.equal((await f.record(next, 'BREAK_START', 'MEAL')).state, 'ON_MEAL_BREAK');
  await db.query(`update public.employees set is_active = false where id = $1`, [f.a.employee]);
  assert.deepEqual((await f.events()).map(e => e.event_type), ['CLOCK_IN', 'BREAK_START'], 'deactivation leaves the open shift honest');
});
test('concurrent clock-ins and break starts cannot create an impossible state', { skip }, async () => {
  const f = await fixture();
  const ins = await Promise.all(Array.from({ length: 8 }, () => f.record(f.a, 'CLOCK_IN')));
  assert.equal(ins.filter(r => r.ok).length, 1);
  const breaks = await Promise.all(['PAID', 'MEAL', 'PAID', 'MEAL'].map(t => f.record(f.a, 'BREAK_START', t)));
  assert.equal(breaks.filter(r => r.ok).length, 1);
  const outs = await Promise.all([f.record(f.a, 'CLOCK_OUT'), f.record(f.a, 'BREAK_END'), f.record(f.a, 'CLOCK_OUT')]);
  assert.equal(outs.filter(r => r.ok).length, 1);
  const types = (await f.events()).map(e => e.event_type);
  assert.equal(types.filter(t => t === 'CLOCK_IN').length, 1); assert.equal(types.filter(t => t === 'BREAK_START').length, 1);
  assert.equal(types.filter(t => t === 'BREAK_END').length, 1);
  const source = require('node:fs').readFileSync('supabase/migrations/202610010001_m05_time_clock.sql', 'utf8');
  assert.match(source, /pg_advisory_xact_lock\(\s*hashtextextended\('zude:m05:time:' \|\| p_business_id::text \|\| ':' \|\| p_employee_id::text/);
});
test('ledger is append-only, tenant-safe and structurally constrained', { skip }, async () => {
  const f = await fixture(); const { db } = f;
  await f.record(f.a, 'CLOCK_IN');
  assert.equal(await f.rejects(db.query(`update public.employee_time_events set occurred_at = now() - interval '1 hour'`)), '42501', 'even the owner cannot update');
  assert.equal(await f.rejects(db.query(`truncate public.employee_time_events cascade`)), '42501');
  for (const sql of [`update public.employee_time_events set break_type = null`, `delete from public.employee_time_events`,
    `insert into public.employee_time_events (business_id, employee_id, device_id, event_type, occurred_at, request_id) values ('${f.A}', '${f.a.employee}', '${f.a.device}', 'CLOCK_OUT', now(), gen_random_uuid())`]) {
    assert.equal(await f.rejects(as(db, 'service_role', sql)), '42501', 'service_role: ' + sql.slice(0, 30));
  }
  for (const role of ['anon', 'authenticated']) {
    for (const table of ['employee_time_events', 'employee_time_issues']) assert.equal(await f.rejects(as(db, role, `select * from public.${table}`)), '42501');
    assert.equal(await f.rejects(as(db, role, `select public.m05_record_time_event($1, $2, $3, $4, 'CLOCK_OUT', null, gen_random_uuid())`, [f.A, f.a.employee, f.a.device, f.a.session])), '42501');
  }
  assert.equal(await f.rejects(as(db, 'service_role', `select public.m05_assert_employee_identity($1, $2, $3, $4)`, [f.A, f.a.employee, f.a.device, f.a.session])), '42501', 'helper is internal');
  assert.equal((await as(db, 'service_role', 'select count(*) as n from public.employee_time_events')).rows[0].n, 1, 'service_role can read');
  const foreign = await f.device(f.B);
  const insert = (dev, type, brk) => db.query(`insert into public.employee_time_events (business_id, employee_id, device_id, event_type, break_type, occurred_at, request_id) values ($1, $2, $3, $4, $5, now(), gen_random_uuid())`, [f.A, f.a.employee, dev, type, brk]);
  assert.equal(await f.rejects(insert(foreign, 'CLOCK_OUT', null)), '23503', 'employee of A with device of B');
  assert.equal(await f.rejects(insert(f.a.device, 'BREAK_START', null)), '23514', 'BREAK_START requires a type');
  assert.equal(await f.rejects(insert(f.a.device, 'CLOCK_IN', 'PAID')), '23514', 'CLOCK_IN never has a type');
  assert.equal(await f.rejects(insert(null, 'CLOCK_OUT', null)), '23514', 'device required for device_pin events');
  assert.equal(await f.rejects(db.query(`delete from public.employees where id = $1`, [f.a.employee])), '23503', 'history blocks hard-deleting the employee');
  assert.equal(await f.rejects(db.query(`delete from public.zude_devices where id = $1`, [f.a.device])), '23503', 'history blocks hard-deleting the device');
  await db.query(`delete from public.businesses where id = $1`, [f.A]);
  assert.equal((await db.query('select count(*) as n from public.employee_time_events')).rows[0].n, 0, 'business deletion still removes tenant data');
});
test('time issue reports: own events only, bounded note, never touch the ledger', { skip }, async () => {
  const f = await fixture(); const { db } = f;
  await f.record(f.a, 'CLOCK_IN');
  const [event] = (await db.query(`select id from public.employee_time_events`)).rows;
  const report = (who, key, note, eventId = null, day = '2026-09-28') => as(db, 'service_role', `select public.m05_report_time_issue($1, $2, $3, $4, $5, $6, $7, $8) as r`, [who.business, who.employee, who.device, who.session, key, day, eventId, note]).then(r => r.rows[0].r);
  const first = await report(f.a, id(), '  Forgot to clock out  ', event.id);
  assert.equal(first.ok, true); assert.equal(first.replayed, false);
  assert.equal(first.issue.note, 'Forgot to clock out'); assert.equal(first.issue.status, 'open'); assert.equal(first.issue.time_event_id, event.id);
  const other = { business: f.A, employee: await f.employee(f.A), device: f.a.device }; other.session = await f.session(f.A, f.a.device, other.employee);
  assert.equal(await f.rejects(report(other, id(), 'not mine', event.id)), '22023', "another employee's event");
  for (const note of ['   ', 'x'.repeat(1001)]) assert.equal(await f.rejects(report(f.a, id(), note)), '22023');
  assert.equal(await f.rejects(report({ ...f.a, session: other.session }, id(), 'spoof')), '42501');
  assert.equal((await db.query('select count(*) as n from public.employee_time_issues')).rows[0].n, 1);
  assert.equal((await f.events()).length, 1, 'ledger unchanged');
  assert.equal(await f.rejects(db.query(`update public.employee_time_issues set status = 'resolved'`)), '42501', 'resolution requires the audited management transaction');
});
test('time issue request keys: exact replay is idempotent; any changed payload is a conflict with no write', { skip }, async () => {
  const f = await fixture(); const { db } = f;
  await f.record(f.a, 'CLOCK_IN'); await f.record(f.a, 'CLOCK_OUT');
  const [inEvent, outEvent] = (await db.query(`select id from public.employee_time_events order by seq`)).rows.map(r => r.id);
  const report = (key, note, day, eventId) => as(db, 'service_role', `select public.m05_report_time_issue($1, $2, $3, $4, $5, $6, $7, $8) as r`, [f.A, f.a.employee, f.a.device, f.a.session, key, day, eventId, note]).then(r => r.rows[0].r);
  const key = id();
  const original = await report(key, 'Forgot to clock out', '2026-09-28', inEvent);
  assert.equal(original.replayed, false);
  const replay = await report(key, '  Forgot to clock out ', '2026-09-28', inEvent);
  assert.deepEqual([replay.ok, replay.replayed, replay.issue.id], [true, true, original.issue.id], 'exact replay (same trimmed note)');
  for (const [label, args] of [['changed note', ['Different note', '2026-09-28', inEvent]], ['changed work date', ['Forgot to clock out', '2026-09-29', inEvent]],
    ['work date removed', ['Forgot to clock out', null, inEvent]], ['changed event', ['Forgot to clock out', '2026-09-28', outEvent]], ['event removed', ['Forgot to clock out', '2026-09-28', null]]]) {
    assert.deepEqual(await report(key, ...args), { ok: false, code: 'TIME_REQUEST_CONFLICT' }, label);
  }
  const rows = (await db.query('select note, work_date, time_event_id from public.employee_time_issues')).rows;
  assert.deepEqual(rows, [{ note: 'Forgot to clock out', work_date: '2026-09-28', time_event_id: inEvent }], 'one row, never modified');
  const nulls = id();
  await report(nulls, 'General issue', null, null);
  assert.equal((await report(nulls, 'General issue', null, null)).replayed, true, 'NULL day/event compare as equal');
  assert.equal((await db.query('select count(*) as n from public.employee_time_issues')).rows[0].n, 2);
});
test('DELETE: direct deletes are refused for every role, even with future grants; whole-business deletion still cascades', { skip }, async () => {
  const f = await fixture(); const { db } = f;
  await f.record(f.a, 'CLOCK_IN'); await f.record(f.a, 'BREAK_START', 'PAID');
  const b = { business: f.B, employee: await f.employee(f.B) }; b.device = await f.device(f.B); b.session = await f.session(f.B, b.device, b.employee);
  await f.record(b, 'CLOCK_IN');
  await as(db, 'service_role', `select public.m05_report_time_issue($1, $2, $3, $4, gen_random_uuid(), null, (select id from public.employee_time_events where business_id = $1 limit 1), 'check')`, [f.A, f.a.employee, f.a.device, f.a.session]);
  const total = async () => (await db.query('select count(*) as n from public.employee_time_events')).rows[0].n;
  // Owner/superuser (bypasses privileges and RLS): blocked by the trigger.
  assert.equal(await f.rejects(db.query(`delete from public.employee_time_events where business_id = $1`, [f.A])), '42501', 'owner direct delete');
  assert.equal(await f.rejects(db.query(`delete from public.employee_time_events`)), '42501', 'owner unfiltered delete');
  // service_role today: no privilege at all.
  assert.equal(await f.rejects(as(db, 'service_role', `delete from public.employee_time_events`)), '42501', 'service_role delete');
  for (const role of ['anon', 'authenticated']) assert.equal(await f.rejects(as(db, role, `delete from public.employee_time_events`)), '42501', role);
  // Accidental future privilege expansion: the trigger still refuses.
  await db.exec(`grant delete, update, truncate on public.employee_time_events to service_role`);
  for (const sql of ['delete from public.employee_time_events', `update public.employee_time_events set device_id = device_id`, 'truncate public.employee_time_events cascade']) {
    assert.equal(await f.rejects(as(db, 'service_role', sql)), '42501', 'granted service_role: ' + sql.split(' ')[0]);
  }
  await db.exec(`revoke delete, update, truncate on public.employee_time_events from service_role`);
  assert.equal(await f.rejects(as(db, 'service_role', `select public.m05_time_events_delete_guard()`)), '42501', 'guard not callable');
  assert.equal(await total(), 3, 'nothing was deleted');
  // Tenant deletion contract: deleting business A removes all of A's tenant data, including the ledger and reports.
  await db.query(`delete from public.businesses where id = $1`, [f.A]);
  for (const table of ['employee_time_events', 'employee_time_issues', 'employees', 'zude_devices', 'employee_sessions']) {
    assert.equal((await db.query(`select count(*) as n from public.${table} where business_id = $1`, [f.A])).rows[0].n, 0, table);
  }
  assert.equal(await total(), 1, "business B's ledger untouched");
  assert.deepEqual((await db.query('select event_type from public.employee_time_events where business_id = $1', [f.B])).rows, [{ event_type: 'CLOCK_IN' }]);
});
test('function privileges: internal M05 functions are executable by no client role; service_role executes only the two write RPCs', { skip }, async () => {
  const f = await fixture(); const { db } = f;
  const internal = ['public.m05_time_events_immutable()', 'public.m05_time_events_delete_guard()', 'public.m05_assert_employee_identity(uuid, uuid, uuid, uuid)'];
  const rpcs = ['public.m05_record_time_event(uuid, uuid, uuid, uuid, text, text, uuid)', 'public.m05_report_time_issue(uuid, uuid, uuid, uuid, uuid, date, uuid, text)'];
  // PUBLIC (grantee 0) in the effective ACL, including PostgreSQL's default when proacl is NULL.
  const publicExecute = async (fn) => (await db.query(`select exists (select 1 from aclexplode(coalesce((select proacl from pg_proc where oid = $1::regprocedure), acldefault('f', (select proowner from pg_proc where oid = $1::regprocedure)))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as granted`, [fn])).rows[0].granted;
  const can = async (role, fn) => (await db.query(`select has_function_privilege($1, $2, 'EXECUTE') as granted`, [role, fn])).rows[0].granted;
  for (const fn of internal) {
    assert.equal(await publicExecute(fn), false, `PUBLIC cannot execute ${fn}`);
    for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await can(role, fn), false, `${role} cannot execute ${fn}`);
  }
  for (const fn of rpcs) {
    assert.equal(await publicExecute(fn), false, `PUBLIC cannot execute ${fn}`);
    for (const role of ['anon', 'authenticated']) assert.equal(await can(role, fn), false, `${role} cannot execute ${fn}`);
    assert.equal(await can('service_role', fn), true, `service_role executes ${fn}`);
  }
  // Exactly the intended set, across every m05_ function the migration creates.
  const executable = (await db.query(`select p.oid::regprocedure::text as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'm05\\_%' and has_function_privilege('service_role', p.oid, 'EXECUTE') order by 1`)).rows.map(r => r.fn);
  assert.deepEqual(executable, ['m05_record_time_event(uuid,uuid,uuid,uuid,text,text,uuid)', 'm05_report_time_issue(uuid,uuid,uuid,uuid,uuid,date,uuid,text)']);
  const all = (await db.query(`select count(*) as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'm05\\_%'`)).rows[0].n;
  assert.equal(all, 5, 'the test covers every M05 function');
  // Executable proof, not only catalog inspection.
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.equal(await f.rejects(as(db, role, `select public.m05_assert_employee_identity($1, $2, $3, $4)`, [f.A, f.a.employee, f.a.device, f.a.session])), '42501', `${role} calling the identity helper`);
  }
  for (const role of ['anon', 'authenticated']) {
    assert.equal(await f.rejects(as(db, role, `select public.m05_record_time_event($1, $2, $3, $4, 'CLOCK_IN', null, gen_random_uuid())`, [f.A, f.a.employee, f.a.device, f.a.session])), '42501', `${role} calling the clock RPC`);
    assert.equal(await f.rejects(as(db, role, `select public.m05_report_time_issue($1, $2, $3, $4, gen_random_uuid(), null, null, 'x')`, [f.A, f.a.employee, f.a.device, f.a.session])), '42501', `${role} calling the issue RPC`);
  }
  assert.equal((await f.record(f.a, 'CLOCK_IN')).ok, true, 'service_role calls the clock RPC');
});
