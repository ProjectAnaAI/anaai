// Native M03 Customers/Services: typed clients (through the real transport),
// presentation state, navigation and the New Appointment handoff.
const { test } = require('node:test');
const strict = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
// Module values come from vm contexts; compare structurally across realms.
const assert = Object.assign((...a) => strict(...a), strict, { deepEqual: (a, b, m) => strict.deepEqual(JSON.parse(JSON.stringify(a)), b, m) });
const base = 'apps/zude-mobile/src/';
function load(file, imports = {}, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(base + file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { exports, URL, URLSearchParams, AbortController, ...globals, require(name) { if (Object.hasOwn(imports, name)) return imports[name]; throw Error(`Unexpected dependency ${name}`); } });
  return exports;
}
const A = 'business-a';
function clients(respond) {
  const calls = [];
  const api = load('lib/api.ts', { './supabase': { supabase: { auth: { async getSession() { return { data: { session: { access_token: 'PRIVATE_TEST_TOKEN', user: { id: 'user-a' } } }, error: null }; } } } } }, {
    __DEV__: false, process: { env: { EXPO_PUBLIC_ZUDE_API_URL: 'https://zude.invalid' } },
    async fetch(url, init) {
      calls.push({ url: new URL(url), init, body: init.body ? JSON.parse(init.body) : undefined });
      const { status = 200, body } = respond(new URL(url), init);
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    },
  });
  return { calls, api, customers: load('lib/customers-api.ts', { './api': api }), services: load('lib/services-api.ts', { './api': api }) };
}
const customer = { id: 'c1', full_name: 'Maya Chen', phone: null, email: null, notes: 'Prefers mornings', is_active: true };
const service = { id: 's1', name: 'Haircut', duration_minutes: 45, price: 40, description: null, is_active: true };

// ---- Customers client ---------------------------------------------------------
test('directory: encoded search/filter/page on the CRM route with tenant header', async () => {
  const h = clients(() => ({ body: { success: true, businessId: A, customers: [customer], total: 1, nextOffset: null, counts: { active: 1, archived: 0 } } }));
  const data = await h.customers.getCustomerDirectory(A, { q: 'a&b', status: 'active', offset: 50 }, new AbortController().signal);
  assert.equal(data.customers[0].id, 'c1');
  const { url, init } = h.calls[0];
  assert.equal(url.pathname, '/api/customers/directory'); assert.equal(url.searchParams.get('q'), 'a&b');
  assert.equal(url.searchParams.get('status'), 'active'); assert.equal(url.searchParams.get('offset'), '50');
  assert.equal(init.headers['x-anaai-business-id'], A); assert.equal(init.method, 'GET');
});
for (const [name, body] of [
  ['another tenant', { success: true, businessId: 'business-b', customers: [], counts: { active: 0, archived: 0 } }],
  ['filter mismatch', { success: true, businessId: A, customers: [{ ...customer, is_active: false }], counts: { active: 0, archived: 1 } }],
  ['malformed row', { success: true, businessId: A, customers: [{ id: 1 }], counts: { active: 0, archived: 0 } }],
]) test(`directory rejects unverifiable response: ${name}`, async () => {
  const h = clients(() => ({ body }));
  await assert.rejects(h.customers.getCustomerDirectory(A, { q: '', status: 'active', offset: 0 }, new AbortController().signal), e => e.code === 'INVALID_RESPONSE');
});
test('detail: history must belong to the requested customer', async () => {
  const detail = { success: true, businessId: A, customer, appointments: [{ id: 'p', customer_id: 'c1', appointment_date: '2026-09-28', status: 'Booked' }], summary: { total: 1, completed: 0, cancelled: 0, upcomingId: 'p', lastVisitId: null } };
  assert.equal((await clients(() => ({ body: detail })).customers.getCustomerDetail(A, 'c1', new AbortController().signal)).customer.id, 'c1');
  const leak = { ...detail, appointments: [{ id: 'x', customer_id: 'other', appointment_date: '2026-09-28', status: 'Booked' }] };
  await assert.rejects(clients(() => ({ body: leak })).customers.getCustomerDetail(A, 'c1', new AbortController().signal), e => e.code === 'INVALID_RESPONSE');
  await assert.rejects(clients(() => ({ body: { ...detail, customer: { ...customer, id: 'other' } } })).customers.getCustomerDetail(A, 'c1', new AbortController().signal), e => e.code === 'INVALID_RESPONSE');
});
test('create/update/archive: exact bodies, methods and paths; no tenant or idempotency fields sent', async () => {
  const h = clients((url, init) => ({ status: init.method === 'POST' ? 201 : 200, body: { success: true, businessId: A, customer: { ...customer, is_active: !(init.body.includes('"isActive":false')) } } }));
  await h.customers.createCustomer(A, 'user-a', { name: 'Maya Chen', phone: '  ', email: '', notes: ' note ' });
  await h.customers.updateCustomer(A, 'user-a', 'c1', { name: 'Maya', phone: '555 0100', email: 'm@example.invalid', notes: '' });
  await h.customers.setCustomerActive(A, 'user-a', 'c1', false);
  assert.deepEqual(h.calls.map(c => [c.init.method, c.url.pathname]), [['POST', '/api/customers'], ['PATCH', '/api/customers/c1'], ['PATCH', '/api/customers/c1']]);
  assert.deepEqual(h.calls[0].body, { name: 'Maya Chen', phone: null, email: null, notes: 'note' });
  assert.deepEqual(h.calls[1].body, { name: 'Maya', phone: '555 0100', email: 'm@example.invalid', notes: null });
  assert.deepEqual(h.calls[2].body, { isActive: false });
  assert.ok(h.calls.every(c => !('Idempotency-Key' in c.init.headers) && c.init.headers['x-anaai-business-id'] === A && !JSON.stringify(c.body).includes('business')));
});
test('write refuses a changed account before sending', async () => {
  const h = clients(() => ({ body: {} }));
  await assert.rejects(h.customers.createCustomer(A, 'previous-user', { name: 'X', phone: '', email: '', notes: '' }), e => e.code === 'SESSION_CHANGED');
  assert.equal(h.calls.length, 0);
});
test('server validation codes survive transport; server text never does', async () => {
  const h = clients(() => ({ status: 409, body: { success: false, code: 'DUPLICATE_PHONE', error: 'private-provider-detail' } }));
  await assert.rejects(h.customers.createCustomer(A, 'user-a', { name: 'X', phone: '5550100', email: '', notes: '' }), e => e.code === 'DUPLICATE_PHONE' && !e.message.includes('private'));
});

// ---- Services client ----------------------------------------------------------
test('catalog: scoped response with role capability', async () => {
  const h = clients(() => ({ body: { success: true, businessId: A, canManage: false, services: [service] } }));
  const data = await h.services.getServiceCatalog(A, new AbortController().signal);
  assert.equal(data.canManage, false); assert.equal(h.calls[0].url.pathname, '/api/services/catalog');
  await assert.rejects(clients(() => ({ body: { success: true, businessId: 'business-b', canManage: true, services: [] } })).services.getServiceCatalog(A, new AbortController().signal), e => e.code === 'INVALID_RESPONSE');
});
test('service create sends numbers; edits never send duration', async () => {
  const h = clients((url, init) => ({ body: { success: true, businessId: A, service: { ...service, is_active: !init.body.includes('"isActive":false') } } }));
  await h.services.createService(A, 'user-a', { name: 'Color', duration: '90', price: '', description: ' ', active: true });
  await h.services.updateService(A, 'user-a', 's1', { name: 'Haircut', duration: '999', price: '42.5', description: 'Wash', active: true });
  await h.services.setServiceActive(A, 'user-a', 's1', false);
  assert.deepEqual(h.calls[0].body, { name: 'Color', durationMinutes: 90, price: null, description: null, isActive: true });
  assert.deepEqual(h.calls[1].body, { name: 'Haircut', price: 42.5, description: 'Wash', isActive: true });
  assert.ok(!('durationMinutes' in h.calls[1].body)); assert.deepEqual(h.calls[2].body, { isActive: false });
  assert.deepEqual(h.calls.map(c => c.url.pathname), ['/api/services', '/api/services/s1', '/api/services/s1']);
});
test('non-numeric service input is left for the server to reject', async () => {
  const h = clients(() => ({ status: 400, body: { success: false, code: 'INVALID_REQUEST' } }));
  await assert.rejects(h.services.createService(A, 'user-a', { name: 'X', duration: 'abc', price: '', description: '', active: true }));
  assert.equal(h.calls[0].body.durationMinutes, 'abc');
});

// ---- Presentation state -------------------------------------------------------
class ZudeApiError extends Error { constructor(status, code, message = 'private-provider-detail') { super(message); this.status = status; this.code = code; } }
const apptState = load('features/appointments/state.ts', { '../../lib/api': { ZudeApiError } });
const customerState = load('features/customers/state.ts', { '../../lib/api': { ZudeApiError }, '../appointments/state': apptState });
const serviceState = load('features/services/state.ts', { '../../lib/api': { ZudeApiError }, '../appointments/state': apptState });
test('customer history: upcoming is the server-classified appointment; the rest is history', () => {
  const detail = { customer, appointments: [{ id: 'far' }, { id: 'next' }, { id: 'past' }], summary: { total: 3, completed: 1, cancelled: 0, upcomingId: 'next', lastVisitId: 'past' } };
  const view = customerState.historyPresentation(detail);
  assert.equal(view.upcoming.id, 'next'); assert.deepEqual(view.history.map(a => a.id), ['far', 'past']);
  assert.equal(customerState.historyPresentation({ ...detail, summary: { ...detail.summary, upcomingId: null } }).upcoming, null);
  assert.equal(customerState.historyCountLabel(detail), '3 appointments · 1 completed');
  assert.equal(customerState.historyCountLabel({ summary: { total: 0, completed: 0, cancelled: 0 } }), 'No appointments yet');
  assert.equal(customerState.historyCountLabel({ summary: { total: 1, completed: 0, cancelled: 1 } }), '1 appointment · 1 cancelled');
});
test('customer form round-trips authoritative fields; only active customers can be booked', () => {
  assert.deepEqual(customerState.customerFields({ ...customer, phone: null, email: 'e' }), { name: 'Maya Chen', phone: '', email: 'e', notes: 'Prefers mornings' });
  assert.deepEqual(customerState.emptyCustomerFields, { name: '', phone: '', email: '', notes: '' });
  assert.equal(customerState.canBook(customer), true); assert.equal(customerState.canBook({ ...customer, is_active: false }), false);
  assert.deepEqual(customerState.appointmentCustomer({ ...customer, phone: '555' }), { id: 'c1', full_name: 'Maya Chen', phone: '555' });
});
for (const [code, status, pattern] of [['CUSTOMER_NAME_INVALID', 400, /customer name/], ['CUSTOMER_PHONE_INVALID', 400, /7–15 digits/], ['CUSTOMER_EMAIL_INVALID', 400, /valid email/], ['DUPLICATE_PHONE', 409, /already exists/], ['CUSTOMER_NOT_FOUND', 404, /no longer available/], ['UNAUTHORIZED', 401, /session expired/], ['BUSINESS_ACCESS_DENIED', 403, /access/], ['NETWORK_ERROR', 0, /not confirmed/], ['SERVICE_UNAVAILABLE', 503, /Refresh the list/]]) test(`customer message ${code}`, () => {
  const message = customerState.customerMessage(new ZudeApiError(status, code));
  assert.match(message, pattern); assert.ok(!message.includes('private-provider-detail'));
});
test('service presentation matches the web Services page', () => {
  assert.equal(serviceState.serviceDuration(null), 'Not set'); assert.equal(serviceState.serviceDuration(45), '45 min');
  assert.equal(serviceState.serviceDuration(60), '1 hour'); assert.equal(serviceState.serviceDuration(120), '2 hours'); assert.equal(serviceState.serviceDuration(90), '90 min');
  assert.equal(serviceState.servicePrice(null), 'Not set'); assert.equal(serviceState.servicePrice(40), '$40.00'); assert.equal(serviceState.servicePrice(0), '$0.00');
  assert.deepEqual(serviceState.serviceFields({ ...service, price: null }), { name: 'Haircut', duration: '45', price: '', description: '', active: true });
  assert.equal(serviceState.emptyServiceFields.active, true);
});
for (const [code, status, pattern] of [['SERVICE_DURATION_INVALID', 400, /1 to 1440/], ['SERVICE_PRICE_INVALID', 400, /nonnegative/], ['DURATION_LOCKED', 400, /cannot be changed/], ['ROLE_FORBIDDEN', 403, /role does not allow/], ['SERVICE_NOT_FOUND', 404, /no longer available/]]) test(`service message ${code}`, () => {
  assert.match(serviceState.serviceMessage(new ZudeApiError(status, code)), pattern);
});

// ---- Navigation and New Appointment handoff ----------------------------------------
const { appointmentHandoff } = load('navigation/handoff.ts');
test('handoff releases the customer only to the matching business and route token', () => {
  const handoff = appointmentHandoff();
  assert.equal(handoff.customer(A, undefined), null);
  const token = handoff.start(A, { ...customer, email: 'private@example.invalid' });
  assert.deepEqual(handoff.customer(A, token), { id: 'c1', full_name: 'Maya Chen', phone: null }, 'only composer fields are held');
  assert.deepEqual(handoff.customer(A, token), { id: 'c1', full_name: 'Maya Chen', phone: null }, 'pure: safe on re-render');
  assert.equal(handoff.customer('business-b', token), null); assert.equal(handoff.customer(A, undefined), null);
  const second = handoff.start(A, { ...customer, id: 'c2' }); assert.equal(handoff.customer(A, token), null); assert.equal(handoff.customer(A, second).id, 'c2');
});
test('New Appointment reuses the existing composer with the customer preselected; no second booking path', () => {
  const screen = fs.readFileSync(base + 'features/appointments/AppointmentsScreen.tsx', 'utf8');
  const composer = fs.readFileSync(base + 'features/appointments/AppointmentComposer.tsx', 'utf8');
  assert.match(screen, /appointmentCustomer\(business\.id, params\.customer\)/);
  assert.match(screen, /initialCustomer=\{composer === "new" \? composeCustomer : null\}/, 'reschedule never receives a handoff customer');
  assert.match(composer, /\} : initialCustomer \|\| null\);/);
  for (const dir of ['features/customers', 'features/services']) for (const file of fs.readdirSync(base + dir)) {
    const source = fs.readFileSync(`${base}${dir}/${file}`, 'utf8');
    assert.doesNotMatch(source, /performAction|mutateAppointment|getAvailability|supabase|\.rpc\(/, `${dir}/${file} must not book or query the database directly`);
  }
  assert.match(fs.readFileSync(base + 'app/customers.tsx', 'utf8'), /CustomersScreen/);
  assert.match(fs.readFileSync(base + 'app/services.tsx', 'utf8'), /ServicesScreen/);
});
const { activeNavigationLabel } = load('navigation/items.ts');
test('active navigation label follows the native route', () => {
  assert.deepEqual(['/', '/appointments', '/customers', '/services', '/unknown'].map(activeNavigationLabel), ['Today', 'Appointments', 'Customers', 'Services', 'Today']);
});
