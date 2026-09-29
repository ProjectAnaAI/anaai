// Run: NODE_PATH=<root node_modules> node --test tests/native-customers-services-api.test.cjs
// Native M03 Customers/Services API. Real handlers, real shared web validation
// (lib/customer-validation.ts, lib/service-validation.ts, lib/customer-insights.ts)
// and real business-context resolution over an in-memory member (RLS) client.
const { test } = require('node:test');
const strict = require('node:assert/strict');
// Handler values come from vm contexts; compare structurally across realms.
const assert = Object.assign((...a) => strict(...a), strict, { deepEqual: (a, b, m) => strict.deepEqual(JSON.parse(JSON.stringify(a)), b, m) });
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const S = '33333333-3333-4333-8333-333333333333';
const C = '44444444-4444-4444-8444-444444444444';
const X = '66666666-6666-4666-8666-666666666666';
const S2 = '77777777-7777-4777-8777-777777777777';
function harness(options = {}) {
  const queries = [], writes = [];
  let authenticated = false, nextId = 0;
  const tables = {
    business_members: [{ business_id: A, user_id: 'member', role: options.role || 'staff' }],
    businesses: [{ id: A, name: 'Business', timezone: 'Pacific/Auckland' }, { id: B, name: 'Other', timezone: 'UTC' }],
    customers: [
      { id: C, business_id: A, user_id: 'u', full_name: 'Maya Chen', phone: '(555) 010-0000', email: 'maya@example.invalid', notes: 'Prefers mornings', is_active: true },
      { id: X, business_id: A, user_id: 'u', full_name: 'Archived Person', phone: '555 222 3333', email: null, notes: null, is_active: false },
      { id: B, business_id: B, user_id: 'o', full_name: 'Other tenant', phone: '(555) 999-0000', email: null, notes: 'secret', is_active: true },
    ],
    services: [
      { id: S, business_id: A, user_id: 'u', name: 'Haircut', duration_minutes: 45, price: 40, description: null, is_active: true },
      { id: S2, business_id: A, user_id: 'u', name: 'Old service', duration_minutes: 30, price: null, description: 'Retired', is_active: false },
      { id: B, business_id: B, user_id: 'o', name: 'Other', duration_minutes: 30, price: 1, description: null, is_active: true },
    ],
    appointments: [
      { id: 'a-past', business_id: A, customer_id: C, service: 'Haircut', appointment_date: '2020-01-02', appointment_time: '09:00:00', status: 'Completed', duration_minutes: 45, notes: 'private' },
      { id: 'a-cancel', business_id: A, customer_id: C, service: 'Haircut', appointment_date: '2020-02-02', appointment_time: '09:00:00', status: 'Cancelled', duration_minutes: 45, notes: null },
      { id: 'a-far', business_id: A, customer_id: C, service: 'Haircut', appointment_date: '2099-05-01', appointment_time: '10:00:00', status: 'Booked', duration_minutes: 45, notes: null },
      { id: 'a-next', business_id: A, customer_id: C, service: 'Haircut', appointment_date: '2099-01-01', appointment_time: '10:00:00', status: 'Confirmed', duration_minutes: 45, notes: null },
      { id: 'a-other-customer', business_id: A, customer_id: X, appointment_date: '2099-01-01', status: 'Booked' },
      { id: 'a-other-tenant', business_id: B, customer_id: C, appointment_date: '2099-01-01', status: 'Booked' },
    ],
    ...options.tables,
  };
  const db = {
    auth: { async getUser(token) { authenticated = token === 'valid'; return { data: { user: authenticated ? { id: 'member' } : null }, error: authenticated ? null : {} }; } },
    from(table) {
      assert.ok(authenticated, 'identity must be verified before any domain access');
      const call = { table, filters: [] }; queries.push(call);
      const query = {
        select(fields) { call.fields = fields.split(/,\s*/); return query; },
        eq(k, v) { call.filters.push([k, v]); return query; },
        order() { return query; },
        range(start, end) { call.range = [start, end]; return query; },
        insert(values) { call.insert = values; writes.push({ table, insert: values }); return query; },
        update(values) { call.update = values; writes.push({ table, update: values, filters: call.filters }); return query; },
        async execute(single = false) {
          if (options.dbError === table) return { data: null, error: { message: 'private-provider-detail' } };
          let rows;
          if (call.insert) { const row = { id: `new-${++nextId}`, ...call.insert }; tables[table].push(row); rows = [row]; }
          else {
            rows = tables[table].filter(r => call.filters.every(([k, v]) => r[k] === v));
            if (call.update) rows.forEach(r => Object.assign(r, call.update));
          }
          if (call.range) rows = rows.slice(call.range[0], call.range[1] + 1);
          rows = rows.map(row => Object.fromEntries(call.fields.map(k => [k, row[k]])));
          return { data: single ? rows[0] ?? null : rows, error: null };
        },
        maybeSingle() { return query.execute(true); }, single() { return query.execute(true); },
        then(resolve, reject) { return query.execute().then(resolve, reject); },
      }; return query;
    },
    rpc() { throw new Error('CRM/catalog routes must not call scheduling RPCs'); },
  };
  const cache = new Map();
  function load(file) {
    file = path.resolve(file); if (cache.has(file)) return cache.get(file);
    const exports = {}; cache.set(file, exports);
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
      exports, Request, Response, URL, Intl, Date,
      console: { error() {} },
      process: { env: { NEXT_PUBLIC_SUPABASE_URL: 'https://fixture.invalid', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fixture' } },
      require(name) {
        if (name === '@supabase/supabase-js') return { createClient: () => db };
        if (name === '@/lib/appointment-actions') return { isUuid: value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) };
        if (name === '@/lib/supabase-server') throw new Error('service-role client must never be loaded');
        return load(name.startsWith('@/') ? name.slice(2) + '.ts' : path.resolve(path.dirname(file), name + '.ts'));
      },
    }); return exports;
  }
  return { tables, queries, writes, async call(file, kind, { url = '', method = 'GET', body, token = 'valid', business = A } = {}) {
    const headers = { 'x-anaai-business-id': business }; if (token) headers.authorization = `Bearer ${token}`;
    const request = new Request(`https://api.invalid/api${url}`, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const response = await load(`server/handlers/${file}.ts`)[kind](request);
    return { status: response.status, body: await response.json(), headers: response.headers };
  } };
}
const routes = [
  ['customers', 'DIRECTORY', { url: '/customers/directory' }],
  ['customers', 'DETAIL', { url: `/customers/${C}` }],
  ['customers', 'CREATE', { url: '/customers', method: 'POST', body: { name: 'New', phone: '' } }],
  ['customers', 'UPDATE', { url: `/customers/${C}`, method: 'PATCH', body: { isActive: false } }],
  ['services', 'CATALOG', { url: '/services/catalog' }],
  ['services', 'CREATE', { url: '/services', method: 'POST', body: { name: 'New', durationMinutes: 30, price: null, description: null } }],
  ['services', 'UPDATE', { url: `/services/${S}`, method: 'PATCH', body: { isActive: false } }],
];
for (const [file, kind, request] of routes) {
  for (const token of [null, 'invalid']) test(`${file}.${kind}: unauthenticated access rejected before any data access (${token})`, async () => {
    const h = harness({ role: 'owner' }); const r = await h.call(file, kind, { ...request, token });
    assert.equal(r.status, 401); assert.equal(h.queries.length, 0); assert.equal(h.writes.length, 0);
  });
  test(`${file}.${kind}: forged business header is not authorization`, async () => {
    const h = harness({ role: 'owner' }); const r = await h.call(file, kind, { ...request, business: B });
    assert.equal(r.status, 403); assert.equal(r.body.code, 'BUSINESS_ACCESS_DENIED');
    assert.ok(h.queries.every(q => ['business_members'].includes(q.table))); assert.equal(h.writes.length, 0);
  });
}

// ---- Customers --------------------------------------------------------------
test('directory: current business only, web sort/filter, no notes in list, no-store', async () => {
  const h = harness(); const r = await h.call('customers', 'DIRECTORY', { url: '/customers/directory' });
  assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual(r.body.customers.map(c => c.id), [C]); assert.deepEqual(r.body.counts, { active: 1, archived: 1 });
  assert.equal(r.body.customers[0].notes, undefined);
  assert.ok(h.queries.filter(q => q.table === 'customers').every(q => q.filters.some(([k, v]) => k === 'business_id' && v === A)));
  const all = await h.call('customers', 'DIRECTORY', { url: '/customers/directory?status=all' });
  assert.deepEqual(all.body.customers.map(c => c.full_name), ['Maya Chen', 'Archived Person'], 'active first');
  const archived = await h.call('customers', 'DIRECTORY', { url: '/customers/directory?status=archived' });
  assert.deepEqual(archived.body.customers.map(c => c.id), [X]);
});
for (const [q, expected] of [['maya', [C]], ['MAYA@EXAMPLE', [C]], ['010-0000', [C]], ['other tenant', []], ['%', []]]) test(`directory search matches web semantics: ${q}`, async () => {
  const r = await harness().call('customers', 'DIRECTORY', { url: `/customers/directory?status=all&q=${encodeURIComponent(q)}` });
  assert.deepEqual(r.body.customers.map(c => c.id), expected);
});
test('directory empty business returns truthful empty state', async () => {
  const r = await harness({ tables: { customers: [] } }).call('customers', 'DIRECTORY', { url: '/customers/directory' });
  assert.equal(r.status, 200); assert.deepEqual(r.body.customers, []); assert.equal(r.body.nextOffset, null); assert.deepEqual(r.body.counts, { active: 0, archived: 0 });
});
test('directory paginates in pages of 50', async () => {
  const many = Array.from({ length: 120 }, (_, i) => ({ id: `c-${String(i).padStart(3, '0')}`, business_id: A, full_name: `Customer ${String(i).padStart(3, '0')}`, phone: null, email: null, is_active: true }));
  const h = harness({ tables: { customers: many } });
  const first = await h.call('customers', 'DIRECTORY', { url: '/customers/directory' }); assert.equal(first.body.customers.length, 50); assert.equal(first.body.nextOffset, 50); assert.equal(first.body.total, 120);
  const last = await h.call('customers', 'DIRECTORY', { url: '/customers/directory?offset=100' }); assert.equal(last.body.customers.length, 20); assert.equal(last.body.nextOffset, null);
});
for (const query of ['?business_id=' + B, '?status=deleted', '?offset=-1', '?q=' + 'x'.repeat(101), '?q=a&q=b']) test(`directory rejects invalid/override query ${query.slice(0, 30)}`, async () => {
  assert.equal((await harness().call('customers', 'DIRECTORY', { url: '/customers/directory' + query })).status, 400);
});
test('detail: notes and history for this customer only, using web upcoming/last-visit rules', async () => {
  const h = harness(); const r = await h.call('customers', 'DETAIL', { url: `/customers/${C}` });
  assert.equal(r.status, 200); assert.equal(r.body.customer.notes, 'Prefers mornings');
  assert.deepEqual(r.body.appointments.map(a => a.id), ['a-far', 'a-next', 'a-cancel', 'a-past'], 'newest first, own tenant/customer only');
  assert.deepEqual(r.body.summary, { total: 4, completed: 1, cancelled: 1, upcomingId: 'a-next', lastVisitId: 'a-past' });
  assert.ok(r.body.appointments.every(a => a.notes === undefined), 'appointment notes are not exposed in customer history');
  assert.ok(h.queries.filter(q => q.table === 'appointments').every(q => q.filters.some(([k, v]) => k === 'business_id' && v === A)));
  assert.equal(h.writes.length, 0, 'history is read-only');
});
for (const id of [B, '99999999-9999-4999-8999-999999999999']) test(`detail: cross-tenant or unknown customer is not exposed (${id.slice(0, 4)})`, async () => {
  const h = harness(); const r = await h.call('customers', 'DETAIL', { url: `/customers/${id}` });
  assert.equal(r.status, 404); assert.equal(r.body.code, 'CUSTOMER_NOT_FOUND'); assert.ok(!JSON.stringify(r.body).includes('secret'));
  assert.ok(!h.queries.some(q => q.table === 'appointments'));
});
test('detail: malformed identifier rejected before data access', async () => {
  const h = harness(); assert.equal((await h.call('customers', 'DETAIL', { url: '/customers/not-a-uuid' })).status, 400);
  assert.ok(!h.queries.some(q => q.table === 'customers'));
});
test('create: shared validation, derived tenant/owner, active by default', async () => {
  const h = harness(); const r = await h.call('customers', 'CREATE', { url: '/customers', method: 'POST', body: { name: '  Jordan Lee ', phone: '+1 (555) 444-1212', email: ' jordan@example.invalid ', notes: ' VIP ' } });
  assert.equal(r.status, 201); assert.equal(r.body.customer.full_name, 'Jordan Lee');
  assert.deepEqual(h.writes[0].insert, { full_name: 'Jordan Lee', phone: '+1 (555) 444-1212', email: 'jordan@example.invalid', notes: 'VIP', business_id: A, user_id: 'member', is_active: true });
});
test('create: optional phone/email/notes', async () => {
  const r = await harness().call('customers', 'CREATE', { url: '/customers', method: 'POST', body: { name: 'Walk-in' } });
  assert.equal(r.status, 201); assert.equal(r.body.customer.phone, null);
});
for (const [body, code] of [[{ name: '' }, 'CUSTOMER_NAME_INVALID'], [{ name: 'x'.repeat(201) }, 'CUSTOMER_NAME_INVALID'], [{ name: 'A', phone: '12' }, 'CUSTOMER_PHONE_INVALID'], [{ name: 'A', phone: 'abc1234567' }, 'CUSTOMER_PHONE_INVALID'], [{ name: 'A', email: 'bad' }, 'CUSTOMER_EMAIL_INVALID']]) test(`create validation ${code} ${JSON.stringify(body).slice(0, 30)}`, async () => {
  const h = harness(); const r = await h.call('customers', 'CREATE', { url: '/customers', method: 'POST', body });
  assert.equal(r.status, 400); assert.equal(r.body.code, code); assert.equal(h.writes.length, 0);
});
test('create: duplicate phone (including archived customers) rejected within business only', async () => {
  const h = harness();
  const dup = await h.call('customers', 'CREATE', { url: '/customers', method: 'POST', body: { name: 'Dup', phone: '555-222-3333' } });
  assert.equal(dup.status, 409); assert.equal(dup.body.code, 'DUPLICATE_PHONE'); assert.equal(h.writes.length, 0);
  const otherTenantPhone = await h.call('customers', 'CREATE', { url: '/customers', method: 'POST', body: { name: 'Ok', phone: '555 999 0000' } });
  assert.equal(otherTenantPhone.status, 201, 'another business\'s phone is not visible to this tenant');
});
for (const body of [{ name: 'A', business_id: B }, { name: 'A', user_id: 'x' }, { name: 'A', isActive: false }, { name: 7 }, { name: 'A', phone: 5 }, '[]', 'not-json']) test(`create: no client-controlled tenant/owner/state fields ${JSON.stringify(body).slice(0, 30)}`, async () => {
  const h = harness(); const r = await h.call('customers', 'CREATE', { url: '/customers', method: 'POST', body });
  assert.equal(r.status, 400); assert.equal(h.writes.length, 0);
});
test('update: edits fields with scoped write and excludes self from duplicate check', async () => {
  const h = harness(); const r = await h.call('customers', 'UPDATE', { url: `/customers/${C}`, method: 'PATCH', body: { name: 'Maya C', phone: '(555) 010-0000', email: null, notes: '' } });
  assert.equal(r.status, 200); assert.equal(r.body.customer.full_name, 'Maya C'); assert.equal(r.body.customer.email, null); assert.equal(r.body.customer.notes, null);
  assert.deepEqual(h.writes[0].filters, [['id', C], ['business_id', A]]); assert.equal(h.writes[0].update.user_id, undefined); assert.equal(h.writes[0].update.business_id, undefined);
});
test('update: archive and reactivate preserve record (no deletion semantics)', async () => {
  const h = harness();
  assert.equal((await h.call('customers', 'UPDATE', { url: `/customers/${C}`, method: 'PATCH', body: { isActive: false } })).body.customer.is_active, false);
  assert.equal((await h.call('customers', 'UPDATE', { url: `/customers/${C}`, method: 'PATCH', body: { isActive: true } })).body.customer.is_active, true);
  assert.deepEqual(h.writes.map(w => w.update), [{ is_active: false }, { is_active: true }]); assert.equal(h.tables.customers.length, 3);
});
for (const body of [{ isActive: 'no' }, { isActive: false, name: 'X' }, { name: 'X', business_id: B }, {}]) test(`update rejects mixed/invalid body ${JSON.stringify(body)}`, async () => {
  const h = harness(); assert.equal((await h.call('customers', 'UPDATE', { url: `/customers/${C}`, method: 'PATCH', body })).status, 400); assert.equal(h.writes.length, 0);
});
test('update: cross-tenant customer cannot be mutated', async () => {
  const h = harness(); const r = await h.call('customers', 'UPDATE', { url: `/customers/${B}`, method: 'PATCH', body: { name: 'Hijack' } });
  assert.equal(r.status, 404); assert.equal(h.writes.length, 0); assert.equal(h.tables.customers.find(c => c.id === B).full_name, 'Other tenant');
});
test('customer provider failure returns a safe typed error', async () => {
  const r = await harness({ dbError: 'customers' }).call('customers', 'DIRECTORY', { url: '/customers/directory' });
  assert.equal(r.status, 503); assert.equal(r.body.code, 'SERVICE_UNAVAILABLE'); assert.ok(!JSON.stringify(r.body).includes('private-provider-detail'));
});

// ---- Services ---------------------------------------------------------------
test('catalog: current business only, active first, includes inactive with price/description', async () => {
  const h = harness(); const r = await h.call('services', 'CATALOG', { url: '/services/catalog' });
  assert.equal(r.status, 200); assert.deepEqual(r.body.services.map(s => s.id), [S, S2]); assert.equal(r.body.canManage, false);
  assert.deepEqual(Object.keys(r.body.services[0]).sort(), ['description', 'duration_minutes', 'id', 'is_active', 'name', 'price']);
});
test('catalog: empty state and role capability for managers', async () => {
  const r = await harness({ role: 'manager', tables: { services: [] } }).call('services', 'CATALOG', { url: '/services/catalog' });
  assert.deepEqual(r.body.services, []); assert.equal(r.body.canManage, true);
  assert.equal((await harness().call('services', 'CATALOG', { url: '/services/catalog?business_id=' + B })).status, 400);
});
for (const [kind, request] of [['CREATE', { url: '/services', method: 'POST', body: { name: 'X', durationMinutes: 30, price: null, description: null } }], ['UPDATE', { url: `/services/${S}`, method: 'PATCH', body: { isActive: false } }]]) test(`services ${kind}: staff cannot change the catalog (web owner/manager rule)`, async () => {
  const h = harness({ role: 'staff' }); const r = await h.call('services', kind, request);
  assert.equal(r.status, 403); assert.equal(r.body.code, 'ROLE_FORBIDDEN'); assert.equal(h.writes.length, 0);
});
test('services create: shared validation, derived tenant/owner', async () => {
  const h = harness({ role: 'owner' }); const r = await h.call('services', 'CREATE', { url: '/services', method: 'POST', body: { name: ' Color ', durationMinutes: 90, price: 120.5, description: ' Full color ' } });
  assert.equal(r.status, 201);
  assert.deepEqual(h.writes[0].insert, { name: 'Color', duration_minutes: 90, price: 120.5, description: 'Full color', is_active: true, business_id: A, user_id: 'member' });
});
test('services create: omitted duration preserves shared nullable web semantics', async () => {
  const h = harness({ role: 'owner' });
  const r = await h.call('services', 'CREATE', {
    url: '/services',
    method: 'POST',
    body: { name: 'Consultation', price: null, description: null }
  });
  assert.equal(r.status, 201);
  assert.deepEqual(h.writes[0].insert, {
    name: 'Consultation',
    duration_minutes: null,
    price: null,
    description: null,
    is_active: true,
    business_id: A,
    user_id: 'member'
  });
});
for (const [body, code] of [[{ name: '', durationMinutes: 30, price: null, description: null }, 'SERVICE_NAME_INVALID'], [{ name: 'X', durationMinutes: 0, price: null, description: null }, 'SERVICE_DURATION_INVALID'], [{ name: 'X', durationMinutes: 1441, price: null, description: null }, 'SERVICE_DURATION_INVALID'], [{ name: 'X', durationMinutes: 30.5, price: null, description: null }, 'SERVICE_DURATION_INVALID'], [{ name: 'X', durationMinutes: 30, price: -1, description: null }, 'SERVICE_PRICE_INVALID'], [{ name: 'X', durationMinutes: 30, price: null, description: 'x'.repeat(2001) }, 'SERVICE_DESCRIPTION_INVALID'], [{ name: 'X', durationMinutes: '30', price: null, description: null }, 'INVALID_REQUEST'], [{ name: 'X', durationMinutes: 30, price: null, description: null, business_id: B }, 'INVALID_REQUEST']]) test(`services create validation ${code}: ${JSON.stringify(body).slice(0, 50)}`, async () => {
  const h = harness({ role: 'owner' }); const r = await h.call('services', 'CREATE', { url: '/services', method: 'POST', body });
  assert.equal(r.status, 400); assert.equal(r.body.code, code); assert.equal(h.writes.length, 0);
});
test('services update: edits name/price/description, never duration', async () => {
  const h = harness({ role: 'manager' });
  const r = await h.call('services', 'UPDATE', { url: `/services/${S}`, method: 'PATCH', body: { name: 'Haircut Deluxe', price: null, description: 'Wash included' } });
  assert.equal(r.status, 200); assert.equal(r.body.service.duration_minutes, 45); assert.equal(r.body.service.is_active, true);
  assert.deepEqual(h.writes[0].update, { name: 'Haircut Deluxe', price: null, description: 'Wash included', is_active: true });
  assert.deepEqual(h.writes[0].filters, [['id', S], ['business_id', A]]);
  const locked = await h.call('services', 'UPDATE', { url: `/services/${S}`, method: 'PATCH', body: { name: 'X', durationMinutes: 60, price: null, description: null } });
  assert.equal(locked.status, 400); assert.equal(locked.body.code, 'DURATION_LOCKED'); assert.equal(h.writes.length, 1);
});
test('services update: activate/deactivate without deletion', async () => {
  const h = harness({ role: 'owner' });
  assert.equal((await h.call('services', 'UPDATE', { url: `/services/${S2}`, method: 'PATCH', body: { isActive: true } })).body.service.is_active, true);
  assert.equal((await h.call('services', 'UPDATE', { url: `/services/${S}`, method: 'PATCH', body: { isActive: false } })).body.service.is_active, false);
  assert.equal(h.tables.services.length, 3);
});
for (const id of [B, 'bad-id']) test(`services update: cross-tenant/invalid id cannot be mutated (${id})`, async () => {
  const h = harness({ role: 'owner' }); const r = await h.call('services', 'UPDATE', { url: `/services/${id}`, method: 'PATCH', body: { isActive: false } });
  assert.ok([400, 404].includes(r.status)); assert.equal(h.writes.length, 0); assert.equal(h.tables.services.find(s => s.id === B).is_active, true);
});
test('services update: partial edit must be explicit', async () => {
  const h = harness({ role: 'owner' }); assert.equal((await h.call('services', 'UPDATE', { url: `/services/${S}`, method: 'PATCH', body: { name: 'Only name' } })).status, 400); assert.equal(h.writes.length, 0);
});
test('routes are mounted after existing composer reads, which keep their contracts', () => {
  const app = fs.readFileSync('server/app.ts', 'utf8');
  assert.ok(app.indexOf('"/customers/directory"') < app.indexOf('"/customers/:id"'));
  assert.ok(app.indexOf('"/services/catalog"') < app.indexOf('"/services/:id"'));
  assert.match(app, /api\.get\("\/customers", webHandler\(appointmentReads\.CUSTOMERS\)\)/);
  assert.match(app, /api\.get\("\/services", webHandler\(appointmentReads\.SERVICES\)\)/);
  for (const file of ['server/handlers/customers.ts', 'server/handlers/services.ts', 'server/member.ts']) {
    const source = fs.readFileSync(file, 'utf8');
    assert.ok(!/supabase-server|SERVICE_ROLE|SUPABASE_SECRET|\.rpc\(|\.delete\(/.test(source), `${file} uses only member RLS client and never deletes`);
  }
});
