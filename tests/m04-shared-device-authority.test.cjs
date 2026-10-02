// M04 shared-device authority: an account-authenticated request that carries
// a registered device + employee session is authorized by the WEAKER of the
// account role and the PIN-verified employee. Real Team/devices/services
// handlers; real device registration, PIN and session issuance.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const crypto = require('node:crypto');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const epoch = '2020-01-01T00:00:00.000Z';
function harness({ accountRole = 'owner' } = {}) {
  const tables = { zude_devices: [], employee_sessions: [], employees: [], services: [{ id: crypto.randomUUID(), business_id: A, name: 'Cut', duration_minutes: 30, price: 20, description: null, is_active: true }] };
  const state = { role: accountRole, writes: [], rpc: [], service: 0 };
  const db = { from(table) {
    let op = 'select', values, fields = '*', filters = [], from = 0, to = Infinity, single = false;
    const q = {
      select(v) { fields = v; return q; }, insert(v) { op = 'insert'; values = v; return q; }, update(v) { op = 'update'; values = v; return q; },
      eq(k, v) { filters.push(r => r[k] === v); return q; }, is(k, v) { filters.push(r => (r[k] ?? null) === v); return q; },
      maybeSingle() { single = true; return q; }, single() { single = true; return q; }, order() { return q; }, range(a, b) { from = a; to = b; return q; },
      then(resolve, reject) { return Promise.resolve().then(() => {
        let rows = tables[table].filter(r => filters.every(f => f(r))).slice(from, to + 1);
        if (op === 'insert') { const row = { created_at: new Date().toISOString(), updated_at: epoch, registered_at: epoch, revoked_at: null, pin_locked_until: null, failed_pin_attempts: 0, ...values }; tables[table].push(row); rows = [row]; state.writes.push({ table, op, values }); }
        if (op === 'update') { for (const r of rows) Object.assign(r, values); if (rows.length) state.writes.push({ table, op, values }); }
        const safe = rows.map(r => fields === '*' ? { ...r } : Object.fromEntries(fields.split(',').map(k => k.trim()).map(k => [k, r[k]])));
        return { data: single ? (safe[0] ?? null) : safe, error: null };
      }).then(resolve, reject); },
    }; return q;
  },
  // m04_write_employee double: records the call; applies the write.
  rpc(name, args) {
    state.rpc.push({ name, args });
    const run = () => {
      if (!args.p_employee_id) { const row = { id: crypto.randomUUID(), business_id: args.p_business_id, display_name: args.p_values.display_name, role: args.p_values.role, is_active: true, pin_hash: args.p_values.pin_hash, pin_salt: args.p_values.pin_salt, created_at: epoch, updated_at: new Date().toISOString() }; tables.employees.push(row); return row; }
      const row = tables.employees.find(e => e.id === args.p_employee_id && e.business_id === args.p_business_id);
      Object.assign(row, Object.fromEntries(Object.entries({ display_name: args.p_values.display_name, role: args.p_values.role, is_active: args.p_values.is_active }).filter(([, v]) => v !== undefined)), { updated_at: new Date().toISOString() });
      return row;
    };
    // Projects the selected columns, as PostgREST does.
    return { select(fields) { return { async single() { const row = run(); return { data: Object.fromEntries(fields.split(',').map(k => k.trim()).map(k => [k, row[k]])), error: null }; } }; } };
  } };
  const cache = {};
  function load(file) {
    file = path.resolve(file); if (cache[file]) return cache[file];
    const exports = {}; cache[file] = exports;
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText,
      { exports, Buffer, Request, Response, URL, Date, console: { error() {}, log() {}, warn() {} }, require(name) {
        if (name === '@/lib/supabase-server') return { createSupabaseServiceClient() { state.service++; return db; } };
        if (name === '@/lib/appointment-actions') return { isUuid: v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) };
        if (name === '@/lib/business-context') return { resolveBusinessContext: async ({ accessToken, requestedBusinessId }) => accessToken === 'account' && (!requestedBusinessId || requestedBusinessId === A)
          ? { success: true, db, context: { businessId: A, userId: 'actor', role: state.role, businessName: 'A', timezone: 'UTC' } } : { success: false, status: 403, code: 'BUSINESS_ACCESS_DENIED', error: 'Denied' } };
        if (name.startsWith('@/')) return load(name.slice(2) + '.ts');
        if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name + '.ts'));
        return require(name);
      } }, { filename: file });
    return exports;
  }
  const devices = load('server/handlers/devices.ts'), team = load('server/handlers/team.ts'), services = load('server/handlers/services.ts');
  // Account-authenticated request, optionally in shared-device mode.
  async function call(handler, { route = 'team', method = 'GET', body, shared, extra = {} } = {}) {
    const headers = { Authorization: 'Bearer account', 'x-anaai-business-id': A, ...extra };
    if (shared?.device !== undefined) headers['x-zude-device'] = shared.device;
    if (shared?.session !== undefined) headers['x-zude-employee-session'] = shared.session;
    const r = await handler(new Request('https://zude.test/api/' + route, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    return { status: r.status, body: await r.json() };
  }
  function employee(role, pin, overrides = {}) { const salt = crypto.randomBytes(16); const e = { id: crypto.randomUUID(), business_id: A, display_name: role + ' ' + pin, role, is_active: true, created_at: epoch, updated_at: epoch, pin_salt: salt.toString('base64'), pin_hash: crypto.scryptSync(pin, salt, 32).toString('base64'), ...overrides }; tables.employees.push(e); return e; }
  async function register() { const r = await call(devices.REGISTER, { route: 'devices', method: 'POST', body: { name: 'Shared iPad' } }); assert.equal(r.status, 201); return r.body.credential; }
  async function unlock(device, pin) { const r = await devices.PIN(new Request('https://zude.test/api/device/pin', { method: 'POST', headers: { Authorization: `ZudeDevice ${device}` }, body: JSON.stringify({ pin }) })); assert.equal(r.status, 201); return (await r.json()).session; }
  return { tables, state, devices, team, services, call, employee, register, unlock };
}
// A registered shared iPad, account signed in as `accountRole`, with one
// employee per role so each test can unlock as whoever it needs.
async function sharedIpad(accountRole = 'owner') {
  const h = harness({ accountRole: 'owner' });
  const staff = h.employee('employee', '1111'), manager = h.employee('manager', '2222'), owner = h.employee('owner', '3333');
  const device = await h.register();
  h.state.role = accountRole;
  const as = async (pin) => ({ device, session: await h.unlock(device, pin) });
  return { h, device, staff, manager, owner, as };
}
const createBody = (role) => ({ name: 'New ' + role, role, pin: String(4000 + Math.floor(Math.random() * 999)) });

// ---- A. account/setup mode is unchanged (no deadlock) ------------------------------
test('setup: owner account with no device registers a device and manages Team', async () => {
  const h = harness();
  assert.equal((await h.call(h.team.CREATE, { method: 'POST', body: createBody('manager') })).status, 201);
  assert.equal((await h.call(h.devices.REGISTER, { route: 'devices', method: 'POST', body: { name: 'First iPad' } })).status, 201);
  assert.equal((await h.call(h.team.DIRECTORY)).status, 200);
});
test('setup: manager account creates employees but not managers; staff account denied', async () => {
  const h = harness({ accountRole: 'manager' });
  assert.equal((await h.call(h.team.CREATE, { method: 'POST', body: createBody('employee') })).status, 201);
  const manager = await h.call(h.team.CREATE, { method: 'POST', body: createBody('manager') });
  assert.equal(manager.status, 403); assert.equal(manager.body.code, 'ROLE_FORBIDDEN');
  h.state.role = 'staff';
  for (const [handler, route] of [[h.team.DIRECTORY, 'team'], [h.devices.DIRECTORY, 'devices']]) assert.equal((await h.call(handler, { route })).body.code, 'ROLE_FORBIDDEN');
});

// ---- B. shared-device mode narrows to the PIN-verified employee -------------------------
test('owner account + EMPLOYEE PIN cannot administer Team', async () => {
  const { h, as } = await sharedIpad('owner'); const shared = await as('1111'); const rpc = h.state.rpc.length;
  for (const req of [{}, { method: 'POST', body: createBody('employee') }]) {
    const r = await h.call(req.method ? h.team.CREATE : h.team.DIRECTORY, { ...req, shared });
    assert.equal(r.status, 403); assert.equal(r.body.code, 'EMPLOYEE_FORBIDDEN');
  }
  const target = h.tables.employees.find(e => e.role === 'employee');
  assert.equal((await h.call(h.team.UPDATE, { route: 'team/' + target.id, method: 'PATCH', body: { isActive: false }, shared })).status, 403);
  assert.equal((await h.call(h.team.RESET_PIN, { route: `team/${target.id}/pin`, method: 'POST', body: { pin: '9876' }, shared })).status, 403);
  assert.equal(h.state.rpc.length, rpc, 'no Team write reached the database');
});
test('owner account + EMPLOYEE PIN cannot administer Registered Devices', async () => {
  const { h, device, as } = await sharedIpad('owner'); const shared = await as('1111');
  const id = device.slice(0, 36);
  for (const [handler, route, method, body] of [[h.devices.DIRECTORY, 'devices', 'GET'], [h.devices.REGISTER, 'devices', 'POST', { name: 'Rogue' }], [h.devices.REVOKE, 'devices/' + id, 'POST', {}]]) {
    const r = await h.call(handler, { route, method, body, shared });
    assert.equal(r.status, 403); assert.equal(r.body.code, 'EMPLOYEE_FORBIDDEN');
  }
  assert.equal(h.tables.zude_devices.length, 1); assert.equal(h.tables.zude_devices[0].revoked_at, null);
});
test('owner account + EMPLOYEE PIN cannot manage the service catalog', async () => {
  const { h, as } = await sharedIpad('owner'); const shared = await as('1111');
  const catalog = await h.call(h.services.CATALOG, { route: 'services/catalog', shared });
  assert.equal(catalog.status, 200); assert.equal(catalog.body.canManage, false, 'reads stay open; management is off');
  const r = await h.call(h.services.CREATE, { route: 'services', method: 'POST', body: { name: 'Rogue', durationMinutes: 30, price: null, description: null }, shared });
  assert.equal(r.status, 403); assert.equal(r.body.code, 'EMPLOYEE_FORBIDDEN'); assert.equal(h.tables.services.length, 1);
});
test('owner account + MANAGER PIN gets manager capabilities only', async () => {
  const { h, device, manager, owner, as } = await sharedIpad('owner'); const shared = await as('2222');
  assert.equal((await h.call(h.team.DIRECTORY, { shared })).status, 200);
  assert.equal((await h.call(h.team.CREATE, { method: 'POST', body: createBody('employee'), shared })).status, 201);
  const promote = await h.call(h.team.CREATE, { method: 'POST', body: createBody('manager'), shared });
  assert.equal(promote.status, 403); assert.equal(promote.body.code, 'EMPLOYEE_FORBIDDEN');
  for (const target of [manager, owner]) assert.equal((await h.call(h.team.UPDATE, { route: 'team/' + target.id, method: 'PATCH', body: { name: 'Changed' }, shared })).status, 403);
  assert.equal((await h.call(h.devices.DIRECTORY, { route: 'devices', shared })).status, 200);
  assert.equal((await h.call(h.services.CATALOG, { route: 'services/catalog', shared })).body.canManage, true);
  assert.ok(device);
});
test('owner account + OWNER PIN gets owner capabilities', async () => {
  const { h, manager, as } = await sharedIpad('owner'); const shared = await as('3333');
  assert.equal((await h.call(h.team.CREATE, { method: 'POST', body: createBody('manager'), shared })).status, 201);
  assert.equal((await h.call(h.team.UPDATE, { route: 'team/' + manager.id, method: 'PATCH', body: { name: 'Renamed' }, shared })).status, 200);
});
test('MANAGER account + OWNER PIN is capped at the account role', async () => {
  const { h, as } = await sharedIpad('manager'); const shared = await as('3333');
  const r = await h.call(h.team.CREATE, { method: 'POST', body: createBody('manager'), shared });
  assert.equal(r.status, 403); assert.equal(r.body.code, 'ROLE_FORBIDDEN');
  assert.equal((await h.call(h.team.CREATE, { method: 'POST', body: createBody('employee'), shared })).status, 201);
});
test('STAFF account is refused before any device lookup, even with an owner PIN', async () => {
  const { h, as } = await sharedIpad('staff'); const shared = await as('3333'); const before = h.state.service;
  const r = await h.call(h.team.DIRECTORY, { shared });
  assert.equal(r.body.code, 'ROLE_FORBIDDEN'); assert.equal(h.state.service, before);
});

// ---- C. spoofing and invalid shared-device credentials ----------------------------------
test('client-declared role/employee fields cannot elevate authority', async () => {
  const { h, staff, as } = await sharedIpad('owner');
  // Manager PIN may create employees, so spoofed fields must be rejected, not ignored.
  const manager = await as('2222'); const writes = h.state.rpc.length;
  const spoofed = await h.call(h.team.CREATE, { method: 'POST', body: { ...createBody('manager'), employeeId: staff.id, permissions: ['team:manage-managers'] }, shared: manager });
  assert.equal(spoofed.status, 400); assert.equal(h.state.rpc.length, writes);
  const shared = await as('1111');
  const headerSpoof = await h.call(h.team.DIRECTORY, { shared, extra: { 'x-zude-role': 'owner', 'x-zude-employee-id': staff.id } });
  assert.equal(headerSpoof.status, 403); assert.equal(headerSpoof.body.code, 'EMPLOYEE_FORBIDDEN');
});
for (const [name, mutate, code] of [
  ['device without employee session', s => ({ device: s.device }), 'IDENTITY_UNAUTHORIZED'],
  ['employee session without device', s => ({ session: s.session }), 'IDENTITY_UNAUTHORIZED'],
  ['forged session', s => ({ ...s, session: s.session.slice(0, 37) + 'A'.repeat(43) }), 'IDENTITY_UNAUTHORIZED'],
  ['malformed device', s => ({ ...s, device: 'not-a-credential' }), 'DEVICE_INVALID'],
]) test(`shared-device request with ${name} fails closed (${code})`, async () => {
  const { h, as } = await sharedIpad('owner'); const shared = mutate(await as('3333'));
  const r = await h.call(h.team.DIRECTORY, { shared });
  assert.equal(r.status, 401); assert.equal(r.body.code, code); assert.ok(!('employees' in r.body));
});
for (const condition of ['expired', 'locked', 'employee-deactivated', 'device-revoked'])
  test(`shared-device management with ${condition} identity fails closed`, async () => {
    const { h, owner, as } = await sharedIpad('owner'); const shared = await as('3333');
    const session = h.tables.employee_sessions.at(-1);
    if (condition === 'expired') session.expires_at = epoch;
    if (condition === 'locked') session.revoked_at = new Date().toISOString();
    if (condition === 'employee-deactivated') owner.is_active = false;
    if (condition === 'device-revoked') h.tables.zude_devices[0].revoked_at = epoch;
    const r = await h.call(h.team.CREATE, { method: 'POST', body: createBody('manager'), shared });
    assert.equal(r.status, 401); assert.equal(r.body.code, condition === 'device-revoked' ? 'DEVICE_REVOKED' : 'IDENTITY_UNAUTHORIZED');
  });
test('a device registered to another business cannot authorize this business', async () => {
  const { h, as } = await sharedIpad('owner'); const shared = await as('3333');
  h.tables.zude_devices[0].business_id = B; for (const s of h.tables.employee_sessions) s.business_id = B; for (const e of h.tables.employees) e.business_id = B;
  const r = await h.call(h.team.DIRECTORY, { shared });
  assert.equal(r.status, 403); assert.equal(r.body.code, 'DEVICE_BUSINESS_MISMATCH');
});

// ---- D. tenancy -------------------------------------------------------------------------------
test('Team and device mutations never cross businesses', async () => {
  const h = harness(); const foreign = h.employee('employee', '5555', { business_id: B });
  assert.equal((await h.call(h.team.UPDATE, { route: 'team/' + foreign.id, method: 'PATCH', body: { name: 'X' } })).status, 404);
  assert.equal((await h.call(h.team.RESET_PIN, { route: `team/${foreign.id}/pin`, method: 'POST', body: { pin: '9876' } })).status, 404);
  const credential = await h.register(); h.tables.zude_devices[0].business_id = B;
  assert.equal((await h.call(h.devices.REVOKE, { route: 'devices/' + credential.slice(0, 36), method: 'POST', body: {} })).status, 404);
  const listed = await h.call(h.devices.DIRECTORY, { route: 'devices' });
  assert.equal(listed.body.businessId, A); assert.deepEqual(listed.body.devices, []);
  assert.ok(!JSON.stringify(listed.body).includes('credential'));
});
test('reactivation through the existing contract requires a new PIN and revokes nothing extra', async () => {
  const h = harness(); const former = h.employee('employee', '6666', { is_active: false });
  const missing = await h.call(h.team.UPDATE, { route: 'team/' + former.id, method: 'PATCH', body: { isActive: true } });
  assert.equal(missing.status, 409); assert.equal(missing.body.code, 'REACTIVATION_REQUIRES_PIN');
  const ok = await h.call(h.team.UPDATE, { route: 'team/' + former.id, method: 'PATCH', body: { isActive: true, pin: '7777' } });
  assert.equal(ok.status, 200); assert.equal(ok.body.employee.is_active, true);
  const write = h.state.rpc.at(-1).args; assert.equal(write.p_values.is_active, true); assert.ok(write.p_values.pin_hash && write.p_values.pin_hash !== former.pin_hash, 'fresh PIN hash, old PIN not restored');
  assert.ok(!JSON.stringify(ok.body).includes('pin_'));
});
test('owner account + MANAGER PIN cannot demote an owner-role employee or reset a manager PIN', async () => {
  const { h, manager, owner, as } = await sharedIpad('owner'); const shared = await as('2222'); const writes = h.state.rpc.length;
  // Assigning "employee" is within a manager's reach; modifying an owner-role record is not.
  const demote = await h.call(h.team.UPDATE, { route: 'team/' + owner.id, method: 'PATCH', body: { role: 'employee' }, shared });
  assert.equal(demote.status, 403); assert.equal(demote.body.code, 'EMPLOYEE_FORBIDDEN');
  const reset = await h.call(h.team.RESET_PIN, { route: `team/${manager.id}/pin`, method: 'POST', body: { pin: '9876' }, shared });
  assert.equal(reset.status, 403); assert.equal(reset.body.code, 'EMPLOYEE_FORBIDDEN');
  assert.equal(h.state.rpc.length, writes); assert.equal(owner.role, 'owner');
});
