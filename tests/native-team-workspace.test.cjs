// Native M04 Team workspace: API wrapper over the real transport, hierarchy
// presentation rules, and the rendered screen's behavior.
const { test } = require('node:test');
const strict = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
// Values cross vm realms; compare structurally.
const assert = Object.assign((...a) => strict(...a), strict, { deepEqual: (a, b, m) => strict.deepEqual(JSON.parse(JSON.stringify(a)), b, m) });
const root = 'apps/zude-mobile/src/';
function load(file, imports = {}, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(root + file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { exports, URL, URLSearchParams, AbortController, JSON, ...globals, require(name) { if (Object.hasOwn(imports, name)) return imports[name]; throw Error('Unexpected import ' + name); } });
  return exports;
}
class ApiError extends Error { constructor(status, code, message = 'private-provider-detail') { super(message); this.status = status; this.code = code; } }
const B = 'business-a';
const E1 = { id: 'e1', display_name: 'Avery Employee', role: 'employee', is_active: true };
const M1 = { id: 'm1', display_name: 'Morgan Manager', role: 'manager', is_active: true };
const O1 = { id: 'o1', display_name: 'Olive Owner', role: 'owner', is_active: true };

// ---- API wrapper through the real authenticated transport ---------------------------
function transport(respond) {
  const calls = [], logs = [];
  const api = load('lib/api.ts', { './supabase': { supabase: { auth: { async getSession() { return { data: { session: { access_token: 'PRIVATE_TEST_TOKEN', user: { id: 'account' } } }, error: null }; } } } } }, {
    __DEV__: false, process: { env: { EXPO_PUBLIC_ZUDE_API_URL: 'https://zude.invalid' } }, console: { log: (...a) => logs.push(a), error: (...a) => logs.push(a), warn: (...a) => logs.push(a) },
    async fetch(url, init) {
      const u = new URL(url); calls.push({ url: u, init, body: init.body ? JSON.parse(init.body) : undefined });
      const { status = 200, body } = respond(u, init);
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    },
  });
  const operational = load('lib/operational-identity.ts', { './api': api });
  return { calls, logs, operational, team: load('lib/team-api.ts', { './api': api, './operational-identity': operational }), devices: load('lib/devices-api.ts', { './api': api, './operational-identity': operational }) };
}
test('directory uses the selected business through the authenticated transport, only a status filter, no client authority', async () => {
  const h = transport(() => ({ body: { success: true, businessId: B, canManage: true, employees: [E1] } }));
  const employees = await h.team.getTeam(B, 'active', new AbortController().signal);
  assert.deepEqual(employees, [E1]);
  const { url, init } = h.calls[0];
  assert.equal(url.pathname, '/api/team'); assert.equal(url.search, '?status=active'); assert.equal(init.method, 'GET');
  assert.equal(init.headers['x-anaai-business-id'], B); assert.equal(init.headers.Authorization, 'Bearer PRIVATE_TEST_TOKEN');
});
test('directory strips anything but public fields and rejects another tenant or malformed rows', async () => {
  const leaky = transport(() => ({ body: { success: true, businessId: B, employees: [{ ...E1, pin_hash: 'HASH', pin_salt: 'SALT', business_id: B }] } }));
  const [row] = await leaky.team.getTeam(B, 'active', new AbortController().signal);
  assert.deepEqual(Object.keys(row).sort(), ['display_name', 'id', 'is_active', 'role']); assert.ok(!JSON.stringify(row).includes('HASH'));
  for (const body of [{ success: true, businessId: 'business-b', employees: [] }, { success: true, businessId: B, employees: [{ ...E1, role: 'admin' }] }, { success: true, businessId: B, employees: 'x' }]) {
    await assert.rejects(transport(() => ({ body })).team.getTeam(B, 'active', new AbortController().signal), e => e.code === 'INVALID_RESPONSE');
  }
});
test('create/update/deactivate/reset send exact bodies and methods to the existing Team API', async () => {
  const h = transport((u, init) => ({ status: init.method === 'POST' && u.pathname === '/api/team' ? 201 : 200, body: { success: true, businessId: B,
    employee: u.pathname.endsWith('/pin') || init.method === 'POST' ? E1 : { ...E1, ...(init.body.includes('"isActive":false') ? { is_active: false } : {}) } } }));
  await h.team.createEmployee(B, 'account', { name: '  Avery Employee ', role: 'employee', pin: '4821' });
  await h.team.updateEmployee(B, 'account', 'e1', { name: 'Avery E' });
  await h.team.deactivateEmployee(B, 'account', 'e1');
  await h.team.resetEmployeePin(B, 'account', 'e1', '5739');
  assert.deepEqual(h.calls.map(c => [c.init.method, c.url.pathname]), [['POST', '/api/team'], ['PATCH', '/api/team/e1'], ['PATCH', '/api/team/e1'], ['POST', '/api/team/e1/pin']]);
  assert.deepEqual(h.calls.map(c => c.body), [{ name: 'Avery Employee', role: 'employee', pin: '4821' }, { name: 'Avery E' }, { isActive: false }, { pin: '5739' }]);
  assert.ok(h.calls.every(c => c.init.headers['x-anaai-business-id'] === B && !('Idempotency-Key' in c.init.headers)));
  assert.ok(h.calls.every(c => !JSON.stringify(c.body).includes('business')), 'no client tenant claims');
  assert.equal(h.logs.length, 0, 'transport logs nothing');
});
test('writes refuse a changed account before sending', async () => {
  const h = transport(() => ({ body: {} }));
  await assert.rejects(h.team.createEmployee(B, 'previous-account', { name: 'X', role: 'employee', pin: '4821' }), e => e.code === 'SESSION_CHANGED');
  assert.equal(h.calls.length, 0);
});
test('server error codes survive; server text never does', async () => {
  const h = transport(() => ({ status: 409, body: { success: false, code: 'PIN_IN_USE', error: 'private-provider-detail' } }));
  await assert.rejects(h.team.createEmployee(B, 'account', { name: 'X', role: 'employee', pin: '4821' }), e => e.code === 'PIN_IN_USE' && !e.message.includes('private'));
});

// ---- Hierarchy and validation presentation ----------------------------------------
const apptState = load('features/appointments/state.ts', { '../../lib/api': { ZudeApiError: ApiError } });
const state = load('features/team/state.ts', { '../../lib/api': { ZudeApiError: ApiError }, '../appointments/state': apptState });
test('locked hierarchy: owner manages all, manager ordinary employees only, staff nothing', () => {
  assert.deepEqual(['owner', 'manager', 'staff'].map(r => state.canManageTeam(r)), [true, true, false]);
  assert.deepEqual(['employee', 'manager', 'owner'].map(r => state.canManageEmployee('owner', r)), [true, true, true]);
  assert.deepEqual(['employee', 'manager', 'owner'].map(r => state.canManageEmployee('manager', r)), [true, false, false]);
  assert.deepEqual(['employee', 'manager', 'owner'].map(r => state.canManageEmployee('staff', r)), [false, false, false]);
  assert.deepEqual(state.assignableRoles('owner'), ['employee', 'manager']); assert.deepEqual(state.assignableRoles('manager'), ['employee']); assert.deepEqual(state.assignableRoles('staff'), []);
});
test('PIN pair validation and change diffing', () => {
  assert.equal(state.pinProblem('4821', '4821'), null);
  for (const [pin, confirm] of [['123', '123'], ['1234567', '1234567'], ['12a4', '12a4'], ['', '']]) assert.match(state.pinProblem(pin, confirm), /4–6 digit/);
  assert.match(state.pinProblem('4821', '4822'), /does not match/);
  assert.deepEqual(state.employeeChanges(E1, { name: ' Avery Employee ', role: 'employee' }), {});
  assert.deepEqual(state.employeeChanges(E1, { name: 'New Name', role: 'manager' }), { name: 'New Name', role: 'manager' });
});
for (const [code, status, pattern] of [['PIN_IN_USE', 409, /different PIN/], ['ROLE_FORBIDDEN', 403, /role does not allow/], ['EMPLOYEE_NOT_FOUND', 404, /no longer available/], ['EMPLOYEE_INACTIVE', 409, /inactive/], ['INVALID_REQUEST', 400, /Check the name/], ['NETWORK_ERROR', 0, /not confirmed/], ['SERVICE_UNAVAILABLE', 503, /Refresh Team/], ['UNAUTHORIZED', 401, /session expired/], ['BUSINESS_ACCESS_DENIED', 403, /access/]]) test(`team message ${code} is safe`, () => {
  const message = state.teamMessage(new ApiError(status, code)); assert.match(message, pattern); assert.ok(!message.includes('private-provider-detail'));
});

// ---- Rendered Team screen ---------------------------------------------------------
const X1 = { id: 'x1', display_name: 'Ex Employee', role: 'employee', is_active: false };
const X2 = { id: 'x2', display_name: 'Ex Manager', role: 'manager', is_active: false };
function screen({ role = 'owner', managementRole = role, employees = [E1, M1, O1], inactive = [X1, X2], fail = {}, pending = false } = {}) {
  const states = [], effects = [], calls = [], logs = [];
  let cursor = 0, ec = 0, refreshes = 0, resourceKey, loaded, loadedStatus, release;
  const react = {
    useState(initial) { const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], v => { states[i] = typeof v === 'function' ? v(states[i]) : v; }]; },
    useRef(initial) { const i = cursor++; if (!(i in states)) states[i] = { current: initial }; return states[i]; },
    useEffect(fn, deps) { const i = ec++, old = effects[i]; if (!old || deps.some((v, j) => v !== old.deps[j])) effects[i] = { fn, deps, pending: true, cleanup: old?.cleanup }; },
  };
  const api = {};
  for (const name of ['createEmployee', 'updateEmployee', 'deactivateEmployee', 'resetEmployeePin', 'reactivateEmployee']) api[name] = async (...args) => {
    calls.push([name, ...args]);
    if (pending) await new Promise(r => { release = r; });
    if (fail[name]) throw fail[name];
    if (name === 'reactivateEmployee') return { ...X1, is_active: true };
    return name === 'createEmployee' ? { id: 'new', display_name: args[2].name, role: args[2].role, is_active: true } : { ...E1, is_active: name !== 'deactivateEmployee' };
  };
  api.getTeam = async (business, status) => { loaded = business; loadedStatus = status; return status === 'inactive' ? inactive : employees; };
  const jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'Fragment' };
  const tokens = load('theme/tokens.ts');
  const Screen = load('features/team/TeamScreen.tsx', {
    react, 'react/jsx-runtime': jsx, 'react-native': { Text: 'Text', View: 'View', useWindowDimensions: () => ({ width: 1024, height: 768, fontScale: 1 }) },
    '../../components/ui': { Badge: 'Badge', Button: 'Button', IconButton: 'IconButton', styles: {} },
    '../../components/workspace': { Feedback: 'Feedback', MasterDetail: 'MasterDetail', PaneTitle: 'PaneTitle', WorkspaceHeader: 'WorkspaceHeader', workspaceStyles: {} },
    '../../components/records': { LabeledField: 'LabeledField', ReadOnlyValue: 'ReadOnlyValue', RecordRow: 'RecordRow', recordStyles: {} },
    '../../lib/team-api': api, '../../navigation/WorkspaceContext': { useWorkspace: () => ({ setNavigationLocked() {} }) },
    '../../theme/tokens': tokens, '../../theme/layout': { workspaceLayout: () => ({ compact: false }) },
    '../business/BusinessContext': { useBusiness: () => ({ business: { id: B, name: 'Business', role }, userId: 'account' }) },
    '../identity/EmployeeIdentityContext': { useEmployeeIdentity: () => ({ managementRole }) },
    '../appointments/controls': { Notice: 'Notice' },
    '../appointments/useResource': { useResource(key, loader) { resourceKey = key; if (key) void loader(new AbortController().signal); return { data: !key ? undefined : key.endsWith(':inactive') ? inactive : employees, loading: false, error: undefined, refresh() { refreshes++; } }; } },
    './state': state,
  }, { console: { log: (...a) => logs.push(a), error: (...a) => logs.push(a), warn: (...a) => logs.push(a) } });
  function nodes(n) { if (!n || typeof n !== 'object') return []; if (Array.isArray(n)) return n.flatMap(nodes); return [n, ...['children', 'master', 'detail', 'action', 'trailing'].flatMap(k => nodes(n.props?.[k]))]; }
  let tree;
  const h = {
    calls, logs, get refreshes() { return refreshes; }, get resourceKey() { return resourceKey; }, get loaded() { return loaded; }, get loadedStatus() { return loadedStatus; },
    render() { cursor = 0; ec = 0; tree = Screen.TeamScreen(); for (const e of effects) if (e.pending) { e.cleanup?.(); e.cleanup = e.fn(); e.pending = false; } return tree; },
    all() { return nodes(tree); },
    button(label) { return h.all().find(n => n.type === 'Button' && n.props.label === label); },
    // Re-render first, as React does after any state change, so handlers are current.
    click(label) { h.render(); const n = h.button(label); assert.ok(n, 'Button ' + label); assert.ok(!n.props.disabled, 'Enabled ' + label); n.props.onPress(); h.render(); },
    open(label) { h.render(); const n = h.all().find(n => n.type === 'RecordRow' && n.props.label.startsWith(label + ',')); assert.ok(n, 'Row ' + label); n.props.onPress(); h.render(); },
    field(label) { return h.all().find(n => n.type === 'LabeledField' && n.props.label === label); },
    type(label, value) { h.render(); const n = h.field(label); assert.ok(n, 'Field ' + label); n.props.onChangeText(value); h.render(); },
    text() { return JSON.stringify(tree); },
    release() { release?.(); },
  };
  h.render();
  return h;
}
const flush = () => new Promise(r => setImmediate(r));
test('Team destination navigates to the real Team workspace', () => {
  const nav = load('navigation/items.ts');
  const team = nav.navigationGroups.find(g => g.title === 'Manage').items.find(i => i.label === 'Team');
  assert.equal(team.state, 'AVAILABLE_NATIVE'); assert.equal(team.route, '/team'); assert.deepEqual(team.roles, ['owner', 'manager']);
  assert.equal(nav.activeNavigationLabel('/team'), 'Team');
  assert.ok(!nav.visibleNavigation('staff').flatMap(g => g.items).some(i => i.label === 'Team'));
  assert.match(fs.readFileSync(root + 'app/team.tsx', 'utf8'), /TeamScreen as default/);
});
test('directory is keyed to the signed-in account and selected business', async () => {
  const h = screen(); await flush();
  assert.equal(h.resourceKey, `account:${B}:team:active`); assert.equal(h.loaded, B); assert.equal(h.loadedStatus, 'active');
  for (const name of ['Avery Employee', 'Morgan Manager', 'Olive Owner']) assert.ok(h.text().includes(name));
  assert.ok(h.all().some(n => n.type === 'Badge' && n.props.label === 'Active'));
});
test('staff account gets no Team administration and never requests the directory', () => {
  const h = screen({ role: 'staff' });
  assert.equal(h.resourceKey, null); assert.equal(h.button('Add Employee'), undefined); assert.match(h.text(), /Team is for owners and managers/);
});
test('empty directory is truthful', () => {
  const h = screen({ employees: [] }); assert.match(h.text(), /No active employees yet/);
});
test('owner creates a manager; PIN leaves state immediately; directory refreshes', async () => {
  const h = screen(); h.click('Add Employee');
  h.type('Display name', 'Riley New'); h.click('Manager'); h.type('PIN', '4821'); h.type('Confirm PIN', '4821');
  h.click('Create Employee'); assert.equal(h.field('PIN')?.props.value ?? '', '', 'PIN cleared before the request resolves');
  await flush(); h.render();
  assert.deepEqual(h.calls[0], ['createEmployee', B, 'account', { name: 'Riley New', role: 'manager', pin: '4821' }]);
  assert.equal(h.refreshes, 1); assert.match(h.text(), /Employee added/);
  assert.ok(!h.text().includes('4821'), 'PIN never rendered'); assert.equal(h.logs.length, 0, 'nothing logged');
});
test('PIN confirmation mismatch is caught client-side, sends nothing, and clears both PIN fields', () => {
  const h = screen(); h.click('Add Employee'); h.type('Display name', 'Riley'); h.type('PIN', '4821'); h.type('Confirm PIN', '4822');
  h.click('Create Employee');
  assert.equal(h.calls.length, 0); assert.match(h.text(), /does not match/);
  assert.equal(h.field('PIN').props.value, ''); assert.equal(h.field('Confirm PIN').props.value, '');
});
test('PIN inputs are secure, numeric and never autofilled', () => {
  const h = screen(); h.click('Add Employee');
  for (const label of ['PIN', 'Confirm PIN']) { const p = h.field(label).props; assert.equal(p.secureTextEntry, true); assert.equal(p.keyboardType, 'number-pad'); assert.equal(p.maxLength, 6); assert.equal(p.autoComplete, 'off'); }
  h.type('PIN', '48a2-1'); assert.equal(h.field('PIN').props.value, '4821', 'non-digits dropped');
});
test('manager account: creates employees only and cannot act on managers or owners', async () => {
  const h = screen({ role: 'manager' }); h.click('Add Employee');
  assert.equal(h.button('Manager'), undefined, 'no manager role option'); assert.ok(h.all().some(n => n.type === 'ReadOnlyValue' && n.props.value === 'Employee'));
  h.type('Display name', 'Sam'); h.type('PIN', '4821'); h.type('Confirm PIN', '4821'); h.click('Create Employee'); await flush();
  assert.equal(h.calls[0][3].role, 'employee');
  for (const name of ['Morgan Manager', 'Olive Owner']) {
    h.open(name); for (const label of ['Edit', 'Reset PIN', 'Deactivate']) assert.equal(h.button(label), undefined, `${label} hidden for ${name}`);
    assert.match(h.text(), /Only a business owner can manage managers and owners/);
  }
  h.open('Avery Employee'); for (const label of ['Edit', 'Reset PIN', 'Deactivate']) assert.ok(h.button(label));
  h.click('Edit'); assert.equal(h.button('Manager'), undefined, 'manager cannot promote');
});
test('owner edits only changed fields; owner-role employee keeps its role', async () => {
  const h = screen(); h.open('Avery Employee'); h.click('Edit'); h.type('Display name', 'Avery E'); h.click('Save Changes'); await flush();
  assert.deepEqual(h.calls[0], ['updateEmployee', B, 'account', 'e1', { name: 'Avery E' }]); assert.equal(h.refreshes, 1);
  h.open('Avery Employee'); h.click('Edit'); h.click('Manager'); h.click('Save Changes'); await flush();
  assert.deepEqual(h.calls[1][4], { role: 'manager' });
  h.open('Olive Owner'); h.click('Edit'); assert.equal(h.button('Manager'), undefined); assert.ok(h.all().some(n => n.type === 'ReadOnlyValue' && n.props.value === 'Owner'));
});
test('deactivate requires confirmation, calls the API, clears selection and refreshes', async () => {
  const h = screen(); h.open('Avery Employee'); h.click('Deactivate');
  assert.match(h.text(), /can no longer unlock ZUDE devices/); h.click('Keep Active'); assert.equal(h.calls.length, 0);
  h.click('Deactivate'); h.click('Yes, Deactivate'); await flush(); h.render();
  assert.deepEqual(h.calls[0], ['deactivateEmployee', B, 'account', 'e1']); assert.equal(h.refreshes, 1); assert.match(h.text(), /was deactivated/);
  assert.equal(h.button('Yes, Deactivate'), undefined);
});
test('reset PIN sends the new PIN, clears it, and refreshes', async () => {
  const h = screen(); h.open('Avery Employee'); h.click('Reset PIN');
  h.type('PIN', '5739'); h.type('Confirm PIN', '5739'); h.click('Reset PIN');
  await flush(); h.render();
  assert.deepEqual(h.calls[0], ['resetEmployeePin', B, 'account', 'e1', '5739']); assert.equal(h.refreshes, 1);
  assert.match(h.text(), /PIN reset/); assert.ok(!h.text().includes('5739'));
});
test('server errors are shown safely, keep the form, and do not refresh', async () => {
  const h = screen({ fail: { createEmployee: new ApiError(409, 'PIN_IN_USE') } }); h.click('Add Employee');
  h.type('Display name', 'Dup'); h.type('PIN', '4821'); h.type('Confirm PIN', '4821'); h.click('Create Employee'); await flush(); h.render();
  assert.match(h.text(), /different PIN/); assert.ok(!h.text().includes('private-provider-detail')); assert.equal(h.refreshes, 0);
  assert.equal(h.field('PIN').props.value, '', 'PIN not retained after failure'); assert.ok(h.button('Create Employee'), 'form stays open for correction');
  const d = screen({ fail: { deactivateEmployee: new ApiError(503, 'SERVICE_UNAVAILABLE') } }); d.open('Avery Employee'); d.click('Deactivate'); d.click('Yes, Deactivate'); await flush(); d.render();
  assert.match(d.text(), /Refresh Team/); assert.equal(d.refreshes, 0);
});
test('duplicate submits send one request', async () => {
  const h = screen({ pending: true }); h.open('Avery Employee'); h.click('Deactivate');
  const confirm = h.button('Yes, Deactivate'); confirm.props.onPress(); confirm.props.onPress(); h.render();
  assert.equal(h.calls.length, 1); assert.equal(h.button('Yes, Deactivate').props.disabled, true); h.release(); await flush();
});
test('Team sources never persist or log PINs', () => {
  for (const file of ['features/team/TeamScreen.tsx', 'features/team/state.ts', 'lib/team-api.ts']) {
    const code = fs.readFileSync(root + file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /async-storage|AsyncStorage|SecureStore|localStorage|sessionStorage|console\.|supabase/, file);
  }
});

// ---- Inactive directory and reactivation ------------------------------------------------
test('inactive directory requests ?status=inactive and rejects rows of the wrong state', async () => {
  const h = transport(() => ({ body: { success: true, businessId: B, employees: [X1] } }));
  assert.deepEqual(await h.team.getTeam(B, 'inactive', new AbortController().signal), [X1]);
  assert.equal(h.calls[0].url.search, '?status=inactive');
  await assert.rejects(transport(() => ({ body: { success: true, businessId: B, employees: [E1] } })).team.getTeam(B, 'inactive', new AbortController().signal), e => e.code === 'INVALID_RESPONSE');
});
test('reactivation uses the existing Team contract with a fresh PIN', async () => {
  const h = transport(() => ({ body: { success: true, businessId: B, employee: { ...X1, is_active: true } } }));
  await h.team.reactivateEmployee(B, 'account', 'x1', '8642');
  assert.equal(h.calls[0].init.method, 'PATCH'); assert.equal(h.calls[0].url.pathname, '/api/team/x1');
  assert.deepEqual(h.calls[0].body, { isActive: true, pin: '8642' });
  await assert.rejects(transport(() => ({ body: { success: true, businessId: B, employee: X1 } })).team.reactivateEmployee(B, 'account', 'x1', '8642'), e => e.code === 'INVALID_RESPONSE');
});
test('owner reactivates an inactive employee with a new PIN; directory returns to Active and refreshes', async () => {
  const h = screen(); h.click('Inactive');
  assert.equal(h.resourceKey, `account:${B}:team:inactive`); assert.match(h.text(), /Ex Employee/);
  h.open('Ex Employee'); assert.ok(h.all().some(n => n.type === 'Badge' && n.props.label === 'Inactive'));
  for (const label of ['Edit', 'Reset PIN', 'Deactivate']) assert.equal(h.button(label), undefined, `${label} not offered for inactive`);
  h.click('Reactivate'); assert.match(h.text(), /previous PIN is not restored/);
  h.type('PIN', '8642'); h.type('Confirm PIN', '8641'); h.click('Reactivate Employee'); assert.equal(h.calls.length, 0, 'mismatch caught locally');
  h.type('PIN', '8642'); h.type('Confirm PIN', '8642'); h.click('Reactivate Employee');
  assert.equal(h.field('PIN').props.value, '', 'PIN cleared immediately'); await flush(); h.render();
  assert.deepEqual(h.calls[0], ['reactivateEmployee', B, 'account', 'x1', '8642']);
  assert.equal(h.refreshes, 1); assert.equal(h.resourceKey, `account:${B}:team:active`); assert.match(h.text(), /was reactivated/);
});
test('manager cannot reactivate a manager; no delete action anywhere', () => {
  const h = screen({ role: 'manager' }); h.click('Inactive');
  h.open('Ex Manager'); assert.equal(h.button('Reactivate'), undefined); assert.match(h.text(), /Only a business owner/);
  h.open('Ex Employee'); assert.ok(h.button('Reactivate'));
  assert.ok(!h.all().some(n => n.type === 'Button' && /delete|remove/i.test(n.props.label)));
});
test('inactive empty state is truthful', () => {
  const h = screen({ inactive: [] }); h.click('Inactive'); assert.match(h.text(), /No inactive employees/);
});

// ---- Shared-device authority in the wrappers and the UI -------------------------------------
test('in shared-device mode every Team request carries the device and employee session; locked mode sends nothing', async () => {
  const h = transport(() => ({ body: { success: true, businessId: B, employees: [E1], employee: E1 } }));
  h.operational.publishOperationalIdentity(B, { mode: 'employee', credential: 'device-cred', session: 'employee-session' });
  await h.team.getTeam(B, 'active', new AbortController().signal); await h.team.updateEmployee(B, 'account', 'e1', { name: 'X' });
  for (const call of h.calls) { assert.equal(call.init.headers['x-zude-device'], 'device-cred'); assert.equal(call.init.headers['x-zude-employee-session'], 'employee-session'); assert.equal(call.init.headers.Authorization, 'Bearer PRIVATE_TEST_TOKEN'); }
  h.operational.publishOperationalIdentity(B, { mode: 'locked' });
  await assert.rejects(h.team.getTeam(B, 'active', new AbortController().signal), e => e.code === 'IDENTITY_REQUIRED');
  assert.equal(h.calls.length, 2, 'nothing sent while locked');
  h.operational.publishOperationalIdentity(B, { mode: 'account' }); await h.team.getTeam(B, 'active', new AbortController().signal);
  assert.equal(h.calls[2].init.headers['x-zude-device'], undefined, 'account mode adds no shared-device headers');
});
test('shared-device headers cannot override account authorization or the business header', async () => {
  const h = transport(() => ({ body: { success: true, businessId: B, employees: [] } }));
  h.operational.publishOperationalIdentity(B, { mode: 'employee', credential: 'device-cred', session: 'employee-session' });
  await h.team.getTeam(B, 'active', new AbortController().signal);
  assert.equal(h.calls[0].init.headers.Authorization, 'Bearer PRIVATE_TEST_TOKEN'); assert.equal(h.calls[0].init.headers['x-anaai-business-id'], B);
});
test('owner account narrowed to an employee PIN gets no Team administration in the UI', () => {
  const h = screen({ role: 'owner', managementRole: 'staff' });
  assert.equal(h.resourceKey, null); assert.equal(h.button('Add Employee'), undefined); assert.match(h.text(), /Team is for owners and managers/);
});
test('owner account narrowed to a manager PIN gets manager-level Team controls', () => {
  const h = screen({ role: 'owner', managementRole: 'manager' }); h.click('Add Employee');
  assert.equal(h.button('Manager'), undefined); h.open('Morgan Manager'); assert.equal(h.button('Edit'), undefined);
});

// ---- Registered Devices wrapper -------------------------------------------------------------------
const D1 = { id: 'd1', business_id: B, name: 'Front iPad', registered_at: '2026-09-01T16:00:00Z', last_seen_at: '2026-09-29T17:30:00Z', revoked_at: null, credential_hash: 'HASH', credential_salt: 'SALT' };
const D2 = { id: 'd2', business_id: B, name: 'Old iPad', registered_at: '2026-08-01T16:00:00Z', last_seen_at: null, revoked_at: '2026-09-02T10:00:00Z', revoked_by_user_id: 'actor' };
test('device directory: selected business, safe fields only, cross-business rejected', async () => {
  const h = transport(() => ({ body: { success: true, businessId: B, devices: [D1, D2] } }));
  const devices = await h.devices.getRegisteredDevices(B, new AbortController().signal);
  assert.equal(h.calls[0].url.pathname, '/api/devices'); assert.equal(h.calls[0].init.headers['x-anaai-business-id'], B);
  assert.deepEqual(Object.keys(devices[0]).sort(), ['id', 'lastSeenAt', 'name', 'registeredAt', 'revokedAt']);
  assert.ok(!JSON.stringify(devices).includes('HASH') && !JSON.stringify(devices).includes('SALT') && !JSON.stringify(devices).includes('actor'));
  for (const body of [{ success: true, businessId: 'business-b', devices: [] }, { success: true, businessId: B, devices: [{ ...D1, business_id: 'business-b' }] }, { success: true, devices: [] }, { success: true, businessId: B, devices: [{ ...D1, registered_at: 'yesterday' }] }])
    await assert.rejects(transport(() => ({ body })).devices.getRegisteredDevices(B, new AbortController().signal), e => e.code === 'INVALID_RESPONSE');
});
test('device revoke: POST /api/devices/:id with {} and a verified revoked result', async () => {
  const h = transport(() => ({ body: { success: true, device: { ...D1, revoked_at: '2026-09-30T12:00:00Z' } } }));
  const revoked = await h.devices.revokeRegisteredDevice(B, 'account', 'd1');
  assert.equal(h.calls[0].init.method, 'POST'); assert.equal(h.calls[0].url.pathname, '/api/devices/d1'); assert.deepEqual(h.calls[0].body, {});
  assert.ok(revoked.revokedAt);
  for (const device of [D1, { ...D1, id: 'other', revoked_at: '2026-09-30T12:00:00Z' }, { ...D1, business_id: 'business-b', revoked_at: '2026-09-30T12:00:00Z' }])
    await assert.rejects(transport(() => ({ body: { success: true, device } })).devices.revokeRegisteredDevice(B, 'account', 'd1'), e => e.code === 'INVALID_RESPONSE');
});

// ---- Registered Devices screen ---------------------------------------------------------------------
const deviceState = load('features/devices/state.ts', { '../../lib/api': { ZudeApiError: ApiError }, '../appointments/state': apptState }, { Intl, Date });
function devicesScreen({ managementRole = 'owner', devices = [D2, D1], fail, pending = false } = {}) {
  const states = [], effects = [], calls = [];
  let cursor = 0, ec = 0, refreshes = 0, resourceKey, release;
  const react = {
    useState(initial) { const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], v => { states[i] = typeof v === 'function' ? v(states[i]) : v; }]; },
    useRef(initial) { const i = cursor++; if (!(i in states)) states[i] = { current: initial }; return states[i]; },
    useEffect(fn, deps) { const i = ec++, old = effects[i]; if (!old || deps.some((v, j) => v !== old.deps[j])) effects[i] = { fn, deps, pending: true, cleanup: old?.cleanup }; },
  };
  const records = devices.map(d => ({ id: d.id, name: d.name, registeredAt: d.registered_at, lastSeenAt: d.last_seen_at, revokedAt: d.revoked_at }));
  const jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'Fragment' };
  const Screen = load('features/devices/DevicesScreen.tsx', {
    react, 'react/jsx-runtime': jsx, 'react-native': { Text: 'Text', View: 'View' },
    '../../components/ui': { Badge: 'Badge', Button: 'Button', IconButton: 'IconButton', styles: {} },
    '../../components/workspace': { DetailLine: 'DetailLine', Feedback: 'Feedback', MasterDetail: 'MasterDetail', PaneTitle: 'PaneTitle', WorkspaceHeader: 'WorkspaceHeader', workspaceStyles: {} },
    '../../components/records': { RecordRow: 'RecordRow', recordStyles: {} },
    '../../lib/devices-api': { getRegisteredDevices: async () => records, async revokeRegisteredDevice(...args) { calls.push(args); if (pending) await new Promise(r => { release = r; }); if (fail) throw fail; return { ...records.find(r => r.id === args[2]), revokedAt: '2026-09-30T12:00:00Z' }; } },
    '../../navigation/WorkspaceContext': { useWorkspace: () => ({ setNavigationLocked() {} }) },
    '../../theme/tokens': load('theme/tokens.ts'),
    '../business/BusinessContext': { useBusiness: () => ({ business: { id: B, name: 'Business', role: 'owner', timezone: 'America/Los_Angeles' }, userId: 'account' }) },
    '../identity/EmployeeIdentityContext': { useEmployeeIdentity: () => ({ managementRole }) },
    '../appointments/controls': { Notice: 'Notice' },
    '../appointments/useResource': { useResource(key) { resourceKey = key; return { data: key ? records : undefined, loading: false, error: undefined, refresh() { refreshes++; } }; } },
    './state': deviceState,
  });
  function nodes(n) { if (!n || typeof n !== 'object') return []; if (Array.isArray(n)) return n.flatMap(nodes); return [n, ...['children', 'master', 'detail', 'action', 'trailing'].flatMap(k => nodes(n.props?.[k]))]; }
  let tree;
  const h = {
    calls, get refreshes() { return refreshes; }, get resourceKey() { return resourceKey; },
    render() { cursor = 0; ec = 0; tree = Screen.RegisteredDevicesScreen(); for (const e of effects) if (e.pending) { e.cleanup?.(); e.cleanup = e.fn(); e.pending = false; } return tree; },
    all() { return nodes(tree); }, text() { return JSON.stringify(tree); },
    button(label) { return h.all().find(n => n.type === 'Button' && n.props.label === label); },
    click(label) { h.render(); const n = h.button(label); assert.ok(n, 'Button ' + label); assert.ok(!n.props.disabled, 'Enabled ' + label); n.props.onPress(); h.render(); },
    open(label) { h.render(); const n = h.all().find(n => n.type === 'RecordRow' && n.props.label.startsWith(label + ',')); assert.ok(n, 'Row ' + label); n.props.onPress(); h.render(); },
    release() { release?.(); },
  };
  h.render(); return h;
}
test('Registered Devices lists active first, keeps revoked history, readable times, no credentials', () => {
  const h = devicesScreen();
  assert.equal(h.resourceKey, `account:${B}:devices`);
  const rows = h.all().filter(n => n.type === 'RecordRow').map(n => n.props.label);
  assert.deepEqual(rows, ['Front iPad, active. Open device', 'Old iPad, revoked. Open device']);
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(h.text()), 'no raw ISO timestamps'); assert.match(h.text(), /Sep 1, 2026/);
  assert.ok(!/HASH|SALT|credential/i.test(h.text()));
});
test('revoke needs confirmation, sends once, explains consequences and refreshes', async () => {
  const h = devicesScreen({ pending: true }); h.open('Front iPad');
  h.click('Revoke Device'); assert.match(h.text(), /no longer unlock with employee PINs/); assert.match(h.text(), /registered again/);
  h.click('Keep Device'); assert.equal(h.calls.length, 0);
  h.click('Revoke Device'); const confirm = h.button('Yes, Revoke Device'); confirm.props.onPress(); confirm.props.onPress(); h.render();
  assert.equal(h.calls.length, 1, 'duplicate revoke blocked'); assert.deepEqual(h.calls[0], [B, 'account', 'd1']);
  h.release(); await flush(); h.render();
  assert.equal(h.refreshes, 1); assert.match(h.text(), /was revoked/);
});
test('a revoked device cannot be revoked again from the UI', () => {
  const h = devicesScreen(); h.open('Old iPad');
  assert.equal(h.button('Revoke Device'), undefined); assert.match(h.text(), /kept for history/);
  assert.ok(h.all().some(n => n.type === 'DetailLine' && n.props.label === 'Revoked'));
});
test('revoke errors are safe and do not refresh', async () => {
  const h = devicesScreen({ fail: new ApiError(403, 'EMPLOYEE_FORBIDDEN') }); h.open('Front iPad'); h.click('Revoke Device'); h.click('Yes, Revoke Device'); await flush(); h.render();
  assert.match(h.text(), /not allowed to manage registered devices/); assert.equal(h.refreshes, 0); assert.ok(!h.text().includes('private-provider-detail'));
});
test('staff (or an employee PIN narrowing the account) never loads Registered Devices', () => {
  for (const managementRole of ['staff']) { const h = devicesScreen({ managementRole }); assert.equal(h.resourceKey, null); assert.match(h.text(), /for owners and managers/); }
  assert.equal(devicesScreen({ managementRole: 'manager' }).resourceKey, `account:${B}:devices`);
});
test('Registered Devices navigation: owner/manager only, and shared-device permission aware', () => {
  const nav = load('navigation/items.ts');
  const item = nav.navigationGroups.find(g => g.title === 'Business').items.find(i => i.label === 'Registered Devices');
  assert.equal(item.route, '/devices'); assert.equal(item.state, 'AVAILABLE_NATIVE'); assert.equal(nav.activeNavigationLabel('/devices'), 'Registered Devices');
  const labels = (role, permissions) => nav.visibleNavigation(role, permissions).flatMap(g => g.items).map(i => i.label);
  assert.ok(labels('owner').includes('Registered Devices')); assert.ok(labels('manager').includes('Registered Devices')); assert.ok(!labels('staff').includes('Registered Devices'));
  assert.ok(!labels('owner', []).includes('Registered Devices') && !labels('owner', []).includes('Team'), 'employee PIN on owner account: no management destinations');
  assert.ok(labels('owner', ['team:manage-employees', 'devices:manage']).includes('Team'));
  assert.match(fs.readFileSync(root + 'app/devices.tsx', 'utf8'), /RegisteredDevicesScreen as default/);
});
test('Devices and Team sources never hold credentials or log', () => {
  for (const file of ['features/devices/DevicesScreen.tsx', 'features/devices/state.ts', 'lib/devices-api.ts', 'lib/operational-identity.ts']) {
    const code = fs.readFileSync(root + file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /async-storage|AsyncStorage|SecureStore|localStorage|console\.|credential_hash|credential_salt|pin_hash|pin_salt|supabase/, file);
  }
});
