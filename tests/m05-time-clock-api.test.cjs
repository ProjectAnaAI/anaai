// M05 Time Clock API end to end: real M04 device/PIN/Lock handlers, real M05
// handlers, real SQL (M04 + M05 migrations) on PGlite. Skipped when PGlite is
// unavailable; see tests/support/pglite-db.cjs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ts = require('typescript');
const { loadPGlite, openDatabase, serviceClient } = require('./support/pglite-db.cjs');
const lib = loadPGlite();
const skip = lib ? false : 'PGlite not installed (set ZUDE_PGLITE_MODULE)';
const H = 3600_000, M = 60_000;

// A timezone where it is currently at least 06:00 locally, so fixtures placed
// up to 5 hours ago fall on today's local date and inside this week.
function daytimeZone() {
  for (const zone of ['UTC', 'Asia/Tokyo', 'America/New_York', 'Europe/London', 'America/Los_Angeles', 'Asia/Kolkata', 'Pacific/Auckland']) {
    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
    if (hour >= 6) return zone;
  }
  throw new Error('No daytime zone');
}

async function harness() {
  const db = await openDatabase(lib);
  const base = serviceClient(db), hooks = {};
  // hooks.beforeRpc runs between the handler's identity check and the SQL write.
  const service = { from: (table) => base.from(table), rpc: async (name, args) => { await hooks.beforeRpc?.(); return base.rpc(name, args); } };
  const cache = {};
  function load(file) {
    file = path.resolve(file); if (cache[file]) return cache[file];
    const exports = {}; cache[file] = exports;
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText,
      { exports, Buffer, Request, Response, URL, Date, Intl, console: { error() {}, log() {}, warn() {} }, require(name) {
        if (name === '@/lib/supabase-server') return { createSupabaseServiceClient: () => service };
        if (name === '@/lib/appointment-actions') return { isUuid: v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) };
        if (name === '@/lib/business-context') return { resolveBusinessContext: async () => ({ success: false, status: 401, code: 'UNAUTHORIZED', error: 'No' }) };
        if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name + '.ts'));
        return require(name);
      } }, { filename: file });
    return exports;
  }
  const devices = load('server/handlers/devices.ts'), time = load('server/handlers/time-clock.ts'), security = load('server/device-security.ts');
  const A = crypto.randomUUID(), B = crypto.randomUUID();
  const zone = daytimeZone();
  await db.query(`insert into public.businesses (id, name, timezone) values ($1, 'A', $2), ($3, 'B', 'UTC')`, [A, zone, B]);
  async function employee(business, role, pin) {
    const salt = crypto.randomBytes(16), id = crypto.randomUUID();
    await db.query(`insert into public.employees (id, business_id, display_name, role, pin_hash, pin_salt) values ($1, $2, $3, $4, $5, $6)`,
      [id, business, `${role} ${pin}`, role, crypto.scryptSync(pin, salt, 32).toString('base64'), salt.toString('base64')]);
    return id;
  }
  async function device(business) {
    const issued = security.issueCredential();
    await db.query(`insert into public.zude_devices (id, business_id, name, credential_hash, credential_salt) values ($1, $2, 'iPad', $3, $4)`, [issued.id, business, issued.hash, issued.salt]);
    return issued.credential;
  }
  const json = (r) => r.json().then(body => ({ status: r.status, body }));
  async function unlock(credential, pin) {
    const r = await json(await devices.PIN(new Request('https://zude.test/api/device/pin', { method: 'POST', headers: { Authorization: `ZudeDevice ${credential}` }, body: JSON.stringify({ pin }) })));
    assert.equal(r.status, 201, JSON.stringify(r.body)); return { credential, session: r.body.session };
  }
  async function lock(who) {
    return json(await devices.LOCK(new Request('https://zude.test/api/employee-session/lock', { method: 'POST', headers: { Authorization: `ZudeDevice ${who.credential}` }, body: JSON.stringify({ session: who.session }) })));
  }
  function headers(who, extra = {}) {
    return { ...(who ? { Authorization: `ZudeDevice ${who.credential}`, 'x-zude-employee-session': who.session } : {}), ...extra };
  }
  async function get(handler, route, who, extra) {
    return json(await handler(new Request('https://zude.test/api/' + route, { headers: headers(who, extra) })));
  }
  async function post(handler, route, who, body = {}, key = crypto.randomUUID(), extra = {}) {
    return json(await handler(new Request('https://zude.test/api/' + route, { method: 'POST', headers: { ...headers(who, extra), ...(key ? { 'Idempotency-Key': key } : {}), 'Content-Type': 'application/json' }, body: JSON.stringify(body) })));
  }
  const count = async () => (await db.query('select count(*) as n from public.employee_time_events')).rows[0].n;
  const types = async (employeeId) => (await db.query('select event_type from public.employee_time_events where employee_id = $1 order by seq', [employeeId])).rows.map(r => r.event_type);
  return { db, hooks, A, B, zone, devices, time, employee, device, unlock, lock, get, post, count, types };
}

test('PIN unlock does not clock in; the employee clocks themselves in with a database timestamp', { skip }, async () => {
  const h = await harness(); const staff = await h.employee(h.A, 'employee', '1111');
  const me = await h.unlock(await h.device(h.A), '1111');
  const before = await h.get(h.time.STATE, 'time-clock', me);
  assert.equal(before.status, 200); assert.equal(before.body.state, 'OFF_CLOCK'); assert.equal(before.body.shift, null);
  assert.equal(before.body.employee.id, staff); assert.equal(before.body.businessId, h.A); assert.equal(before.body.timezone, h.zone);
  assert.equal(await h.count(), 0, 'unlocking wrote nothing');
  const t0 = Date.now();
  const r = await h.post(h.time.CLOCK_IN, 'time-clock/clock-in', me);
  assert.equal(r.status, 200); assert.equal(r.body.state, 'WORKING'); assert.equal(r.body.replayed, false);
  assert.ok(Math.abs(Date.parse(r.body.shift.clockInAt) - t0) < 60_000);
  const text = JSON.stringify(r.body);
  for (const secret of [me.session, me.credential, 'pin_hash', 'token_hash', 'credential_hash']) assert.ok(!text.includes(secret), 'no secrets in responses');
});
test('client-supplied identity, business, role, timestamps and selectors are refused', { skip }, async () => {
  const h = await harness(); await h.employee(h.A, 'employee', '1111'); const other = await h.employee(h.A, 'manager', '2222');
  const me = await h.unlock(await h.device(h.A), '1111');
  for (const body of [{ employeeId: other }, { businessId: h.B }, { role: 'owner' }, { occurredAt: '2020-01-01T00:00:00Z' }, { workedMs: 1 }]) {
    const r = await h.post(h.time.CLOCK_IN, 'time-clock/clock-in', me, body);
    assert.equal(r.status, 400, JSON.stringify(body)); assert.equal(r.body.code, 'INVALID_REQUEST');
  }
  assert.equal((await h.post(h.time.CLOCK_IN, 'time-clock/clock-in', me, {}, null)).status, 400, 'Idempotency-Key required');
  assert.equal((await h.post(h.time.CLOCK_IN, 'time-clock/clock-in', me, {}, 'not-a-uuid')).status, 400);
  assert.equal((await h.post(h.time.BREAK_START, 'time-clock/break-start', me, { breakType: 'LUNCH' })).status, 400);
  // Selectors on the device credential boundary are refused outright.
  assert.equal((await h.get(h.time.MY_TIME, `my-time?employeeId=${other}`, me)).body.code, 'IDENTITY_UNAUTHORIZED');
  assert.equal((await h.get(h.time.MY_TIME, 'my-time', me, { 'x-anaai-business-id': h.B })).body.code, 'IDENTITY_UNAUTHORIZED');
  assert.equal(await h.count(), 0);
});
test('an account token alone, or a device without a session, cannot read or write time', { skip }, async () => {
  const h = await harness(); await h.employee(h.A, 'owner', '3333'); const credential = await h.device(h.A);
  const account = await h.post(h.time.CLOCK_IN, 'time-clock/clock-in', null, {}, undefined, { Authorization: 'Bearer owner-account-token' });
  assert.equal(account.status, 401); assert.equal(account.body.code, 'IDENTITY_UNAUTHORIZED');
  const noSession = await h.post(h.time.CLOCK_IN, 'time-clock/clock-in', null, {}, undefined, { Authorization: `ZudeDevice ${credential}` });
  assert.equal(noSession.status, 401); assert.equal(noSession.body.code, 'IDENTITY_UNAUTHORIZED');
  assert.equal(await h.count(), 0);
});
test('invalid transitions return 409 TIME_INVALID_TRANSITION (not an identity code); timeout retry is replayed once', { skip }, async () => {
  const h = await harness(); const staff = await h.employee(h.A, 'employee', '1111');
  const me = await h.unlock(await h.device(h.A), '1111');
  const end = await h.post(h.time.BREAK_END, 'time-clock/break-end', me);
  assert.equal(end.status, 409); assert.equal(end.body.code, 'TIME_INVALID_TRANSITION'); assert.equal(end.body.state, 'OFF_CLOCK');
  const key = crypto.randomUUID();
  const first = await h.post(h.time.CLOCK_IN, 'time-clock/clock-in', me, {}, key);
  const retry = await h.post(h.time.CLOCK_IN, 'time-clock/clock-in', me, {}, key);
  assert.equal(first.body.replayed, false); assert.equal(retry.status, 200); assert.equal(retry.body.replayed, true);
  assert.deepEqual(await h.types(staff), ['CLOCK_IN']);
  const both = await Promise.all([h.post(h.time.CLOCK_IN, 'time-clock/clock-in', me), h.post(h.time.CLOCK_IN, 'time-clock/clock-in', me)]);
  assert.deepEqual(both.map(r => r.status), [409, 409]);
});
test('paid break, meal break, and clock-out from a break end the break atomically', { skip }, async () => {
  const h = await harness(); const staff = await h.employee(h.A, 'employee', '1111');
  const me = await h.unlock(await h.device(h.A), '1111');
  await h.post(h.time.CLOCK_IN, 'time-clock/clock-in', me);
  const paid = await h.post(h.time.BREAK_START, 'time-clock/break-start', me, { breakType: 'PAID' });
  assert.equal(paid.body.state, 'ON_PAID_BREAK'); assert.deepEqual([paid.body.shift.break.type, paid.body.shift.break.intendedMinutes], ['PAID', 10]);
  assert.equal((await h.post(h.time.BREAK_END, 'time-clock/break-end', me)).body.state, 'WORKING');
  const meal = await h.post(h.time.BREAK_START, 'time-clock/break-start', me, { breakType: 'MEAL' });
  assert.deepEqual([meal.body.state, meal.body.shift.break.intendedMinutes], ['ON_MEAL_BREAK', 30]);
  const out = await h.post(h.time.CLOCK_OUT, 'time-clock/clock-out', me);
  assert.equal(out.body.state, 'OFF_CLOCK'); assert.equal(out.body.shift, null);
  assert.deepEqual(await h.types(staff), ['CLOCK_IN', 'BREAK_START', 'BREAK_END', 'BREAK_START', 'BREAK_END', 'CLOCK_OUT']);
});
test('Lock, session expiry and a new PIN session never clock out; state follows the employee', { skip }, async () => {
  const h = await harness(); const staff = await h.employee(h.A, 'employee', '1111'); const credential = await h.device(h.A);
  let me = await h.unlock(credential, '1111');
  await h.post(h.time.CLOCK_IN, 'time-clock/clock-in', me);
  assert.equal((await h.lock(me)).status, 200);
  assert.equal((await h.get(h.time.STATE, 'time-clock', me)).body.code, 'IDENTITY_UNAUTHORIZED', 'locked session is refused');
  me = await h.unlock(credential, '1111');
  assert.equal((await h.get(h.time.STATE, 'time-clock', me)).body.state, 'WORKING', 'still working after Lock + PIN');
  await h.db.query(`update public.employee_sessions set expires_at = created_at + interval '1 millisecond'`);
  assert.equal((await h.get(h.time.STATE, 'time-clock', me)).body.code, 'IDENTITY_UNAUTHORIZED', 'expired session');
  me = await h.unlock(credential, '1111');
  assert.equal((await h.get(h.time.STATE, 'time-clock', me)).body.state, 'WORKING', 'still working after expiry + PIN');
  assert.deepEqual(await h.types(staff), ['CLOCK_IN']);
});
test('device revocation keeps DEVICE_REVOKED / DEVICE_INVALID and never fabricates a clock-out; another device continues the shift', { skip }, async () => {
  const h = await harness(); const staff = await h.employee(h.A, 'employee', '1111');
  const first = await h.device(h.A); const me = await h.unlock(first, '1111');
  await h.post(h.time.CLOCK_IN, 'time-clock/clock-in', me);
  await h.db.query(`update public.zude_devices set revoked_at = now() where id = $1`, [first.slice(0, 36)]);
  const revoked = await h.post(h.time.CLOCK_OUT, 'time-clock/clock-out', me);
  assert.equal(revoked.status, 401); assert.equal(revoked.body.code, 'DEVICE_REVOKED');
  const forged = await h.get(h.time.STATE, 'time-clock', { credential: first.slice(0, -4) + 'AAAA', session: me.session });
  assert.equal(forged.status, 401); assert.equal(forged.body.code, 'DEVICE_INVALID');
  assert.deepEqual(await h.types(staff), ['CLOCK_IN'], 'revocation is not a clock-out');
  const elsewhere = await h.unlock(await h.device(h.A), '1111');
  assert.equal((await h.get(h.time.STATE, 'time-clock', elsewhere)).body.state, 'WORKING');
  assert.equal((await h.post(h.time.CLOCK_OUT, 'time-clock/clock-out', elsewhere)).body.state, 'OFF_CLOCK');
});
test('My Time is self only for employee, manager and owner PINs, and tenant-isolated', { skip }, async () => {
  const h = await harness(); const credential = await h.device(h.A);
  const ids = { staff: await h.employee(h.A, 'employee', '1111'), manager: await h.employee(h.A, 'manager', '2222'), owner: await h.employee(h.A, 'owner', '3333') };
  const other = await h.employee(h.B, 'employee', '1111');
  const now = Date.now();
  // Another employee's and another business's shifts exist this week.
  await h.db.query(`insert into public.employee_time_events (business_id, employee_id, device_id, event_type, occurred_at, request_id) values ($1, $2, $3, 'CLOCK_IN', $4, gen_random_uuid())`, [h.A, ids.staff, credential.slice(0, 36), new Date(now - 2 * H).toISOString()]);
  const bDevice = await h.device(h.B);
  await h.db.query(`insert into public.employee_time_events (business_id, employee_id, device_id, event_type, occurred_at, request_id) values ($1, $2, $3, 'CLOCK_IN', $4, gen_random_uuid())`, [h.B, other, bDevice.slice(0, 36), new Date(now - 3 * H).toISOString()]);
  for (const [role, pin] of [['manager', '2222'], ['owner', '3333']]) {
    const me = await h.unlock(credential, pin);
    const r = await h.get(h.time.MY_TIME, 'my-time', me);
    assert.equal(r.status, 200); assert.equal(r.body.employee.id, ids[role]); assert.equal(r.body.state, 'OFF_CLOCK');
    assert.equal(r.body.week.workedMs, 0); assert.ok(r.body.days.every(d => d.shifts.length === 0), `${role} sees no one else's shifts`);
  }
  const staff = await h.get(h.time.MY_TIME, 'my-time', await h.unlock(credential, '1111'));
  assert.equal(staff.body.state, 'WORKING'); assert.ok(staff.body.week.workedMs >= 2 * H - M);
  const fromB = await h.get(h.time.MY_TIME, 'my-time', await h.unlock(bDevice, '1111'));
  assert.equal(fromB.body.businessId, h.B); assert.equal(fromB.body.employee.id, other);
  assert.ok(fromB.body.week.workedMs >= 3 * H - M && fromB.body.week.workedMs < 4 * H, 'same PIN in B sees only B');
});
test('My Time totals: meal subtracted, paid break kept, open shift to server now, current week only', { skip }, async () => {
  const h = await harness(); const staff = await h.employee(h.A, 'employee', '1111'); const credential = await h.device(h.A);
  const device = credential.slice(0, 36), now = Date.now();
  const at = (ms) => new Date(now - ms).toISOString();
  const rows = [['CLOCK_IN', null, 5 * H], ['BREAK_START', 'PAID', 4 * H], ['BREAK_END', 'PAID', 4 * H - 10 * M], ['BREAK_START', 'MEAL', 3 * H], ['BREAK_END', 'MEAL', 2.5 * H], ['CLOCK_OUT', null, 1 * H],
    ['CLOCK_IN', null, 30 * M]];
  for (const [type, brk, ago] of rows) await h.db.query(`insert into public.employee_time_events (business_id, employee_id, device_id, event_type, break_type, occurred_at, request_id) values ($1, $2, $3, $4, $5, $6, gen_random_uuid())`, [h.A, staff, device, type, brk, at(ago)]);
  // Last week's shift is not part of this week.
  await h.db.query(`insert into public.employee_time_events (business_id, employee_id, device_id, event_type, occurred_at, request_id) values ($1, $2, $3, 'CLOCK_IN', $4, gen_random_uuid()), ($1, $2, $3, 'CLOCK_OUT', $5, gen_random_uuid())`, [h.A, staff, device, at(10 * 24 * H), at(10 * 24 * H - H)]);
  const r = await h.get(h.time.MY_TIME, 'my-time', await h.unlock(credential, '1111'));
  assert.equal(r.status, 200);
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 5000, `${actual} ≈ ${expected}`);
  near(r.body.week.workedMs, 4 * H - 30 * M + 30 * M); near(r.body.week.paidBreakMs, 10 * M); near(r.body.week.mealBreakMs, 30 * M);
  const today = r.body.days.find(d => d.date === r.body.week.today);
  assert.equal(today.shifts.length, 2); assert.equal(today.shifts[1].open, true); assert.equal(r.body.state, 'WORKING');
  assert.deepEqual(today.shifts[0].breaks.map(b => [b.type, b.intendedMinutes]), [['PAID', 10], ['MEAL', 30]]);
  near(r.body.today.workedMs, 4 * H);
  assert.ok(r.body.days.every(d => d.date >= r.body.week.startDate && d.date <= r.body.week.today), 'no future or previous-week days');
  assert.ok(Date.parse(r.body.serverNow) >= now);
});
test('Report a time issue: own current week only, idempotent, never edits the ledger', { skip }, async () => {
  const h = await harness(); const staff = await h.employee(h.A, 'employee', '1111');
  const me = await h.unlock(await h.device(h.A), '1111');
  await h.post(h.time.CLOCK_IN, 'time-clock/clock-in', me);
  const week = (await h.get(h.time.MY_TIME, 'my-time', me)).body.week;
  const key = crypto.randomUUID();
  const r = await h.post(h.time.REPORT_ISSUE, 'my-time/issues', me, { note: 'Forgot to clock out yesterday', workDate: week.today }, key);
  assert.equal(r.status, 201); assert.equal(r.body.issue.status, 'open');
  assert.equal((await h.post(h.time.REPORT_ISSUE, 'my-time/issues', me, { note: 'Forgot to clock out yesterday', workDate: week.today }, key)).body.issue.id, r.body.issue.id);
  for (const body of [{ note: ' ' }, { note: 'x'.repeat(1001) }, { note: 'old', workDate: '2020-01-06' }, { note: 'spoof', employeeId: staff }, { note: 'x', occurredAt: 'now' }]) {
    assert.equal((await h.post(h.time.REPORT_ISSUE, 'my-time/issues', me, body)).status, 400, JSON.stringify(body).slice(0, 40));
  }
  const view = await h.get(h.time.MY_TIME, 'my-time', me);
  assert.deepEqual(view.body.issues.map(i => i.note), ['Forgot to clock out yesterday']);
  assert.deepEqual(await h.types(staff), ['CLOCK_IN'], 'ledger unchanged');
});
test('deactivation preserves an open shift honestly; the employee can no longer act', { skip }, async () => {
  const h = await harness(); const staff = await h.employee(h.A, 'employee', '1111');
  const me = await h.unlock(await h.device(h.A), '1111');
  await h.post(h.time.CLOCK_IN, 'time-clock/clock-in', me);
  await h.db.query(`update public.employees set is_active = false, updated_at = now() where id = $1`, [staff]);
  assert.equal((await h.post(h.time.CLOCK_OUT, 'time-clock/clock-out', me)).body.code, 'IDENTITY_UNAUTHORIZED');
  assert.deepEqual(await h.types(staff), ['CLOCK_IN'], 'no fabricated CLOCK_OUT');
});
test('an identity change during the write is IDENTITY_UNAUTHORIZED (never a device-forgetting code) and writes nothing', { skip }, async () => {
  const h = await harness(); const staff = await h.employee(h.A, 'employee', '1111'); const credential = await h.device(h.A);
  const me = await h.unlock(credential, '1111');
  h.hooks.beforeRpc = () => h.db.query(`update public.zude_devices set revoked_at = now() where id = $1`, [credential.slice(0, 36)]);
  const r = await h.post(h.time.CLOCK_IN, 'time-clock/clock-in', me);
  assert.equal(r.status, 401); assert.equal(r.body.code, 'IDENTITY_UNAUTHORIZED');
  assert.deepEqual(await h.types(staff), []);
});
test('a shift still open from last week is carried into this week from the week start only', { skip }, async () => {
  const h = await harness(); const staff = await h.employee(h.A, 'employee', '1111'); const credential = await h.device(h.A);
  const me = await h.unlock(credential, '1111');
  const startsAt = Date.parse((await h.get(h.time.MY_TIME, 'my-time', me)).body.week.startsAt);
  await h.db.query(`insert into public.employee_time_events (business_id, employee_id, device_id, event_type, occurred_at, request_id) values ($1, $2, $3, 'CLOCK_IN', $4, gen_random_uuid())`, [h.A, staff, credential.slice(0, 36), new Date(startsAt - 2 * H).toISOString()]);
  const r = (await h.get(h.time.MY_TIME, 'my-time', me)).body;
  const now = Date.parse(r.serverNow);
  assert.equal(r.state, 'WORKING');
  assert.ok(Math.abs(r.week.workedMs - (now - startsAt)) < 5000, 'only the in-week part counts');
  assert.equal(r.days[0].shifts[0].continuesFromPreviousDay, true); assert.equal(r.days[0].shifts[0].open, true);
  assert.ok(Math.abs(r.shift.elapsedMs - (now - startsAt + 2 * H)) < 5000, 'Time Clock shows the whole open shift');
});
test('Report a time issue request keys: exact replay 200, changed note/day/event 409 TIME_REQUEST_CONFLICT, one row', { skip }, async () => {
  const h = await harness(); const staff = await h.employee(h.A, 'employee', '1111');
  const me = await h.unlock(await h.device(h.A), '1111');
  await h.post(h.time.CLOCK_IN, 'time-clock/clock-in', me); await h.post(h.time.CLOCK_OUT, 'time-clock/clock-out', me); await h.post(h.time.CLOCK_IN, 'time-clock/clock-in', me);
  const view = (await h.get(h.time.MY_TIME, 'my-time', me)).body;
  const [first, second] = view.days.flatMap(d => d.shifts).map(s => s.id);
  const days = view.days.map(d => d.date);
  const key = crypto.randomUUID();
  const body = { note: 'Forgot to clock out', workDate: view.week.today, eventId: first };
  const created = await h.post(h.time.REPORT_ISSUE, 'my-time/issues', me, body, key);
  assert.equal(created.status, 201); assert.equal(created.body.replayed, false);
  const replay = await h.post(h.time.REPORT_ISSUE, 'my-time/issues', me, { ...body }, key);
  assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true); assert.equal(replay.body.issue.id, created.body.issue.id);
  const otherDay = days.find(d => d !== view.week.today);
  const changes = [['note', { ...body, note: 'Something else' }], ['event ID', { ...body, eventId: second }], ['event removed', { note: body.note, workDate: body.workDate }], ['day removed', { note: body.note, eventId: first }]];
  if (otherDay) changes.push(['work date', { ...body, workDate: otherDay }]);
  for (const [label, changed] of changes) {
    const r = await h.post(h.time.REPORT_ISSUE, 'my-time/issues', me, changed, key);
    assert.equal(r.status, 409, label); assert.equal(r.body.code, 'TIME_REQUEST_CONFLICT', label);
  }
  const rows = (await h.db.query('select note, work_date, time_event_id from public.employee_time_issues where employee_id = $1', [staff])).rows;
  assert.deepEqual(rows, [{ note: 'Forgot to clock out', work_date: view.week.today, time_event_id: first }]);
});
