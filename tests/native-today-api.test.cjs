// Execute the real handlers, shared identity boundary and repository. Only the
// Supabase transport is replaced; the mock deliberately does NOT enforce RLS.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const day = '2026-09-27';
const secret = 'SECRET_ACCESS_TOKEN_DATABASE_PASSWORD';

function harness(options = {}) {
  const queries = [], logs = [], verified = [];
  const tables = {
    business_members: options.memberships ?? [
      { business_id: A, user_id: 'user', role: 'staff' },
      { business_id: B, user_id: 'other-user', role: 'owner' },
    ],
    businesses: options.businesses ?? [
      { id: A, name: 'A business', timezone: 'America/Los_Angeles', private: secret },
      { id: B, name: 'B business', timezone: 'Pacific/Auckland', private: secret },
      { id: C, name: 'C business', timezone: 'UTC', private: secret },
    ],
    appointments: options.appointments ?? [
      { id: 'a2', business_id: A, appointment_date: day, customer_name: 'Two', service: 'Cut', appointment_time: '09:00:00', duration_minutes: 30, status: 'Confirmed', private: secret },
      { id: 'a1', business_id: A, appointment_date: day, customer_name: 'One', service: 'Cut', appointment_time: '09:00:00', duration_minutes: 45, status: 'Booked', private: secret },
      { id: 'b', business_id: B, appointment_date: day, customer_name: 'Other tenant', status: 'Booked', private: secret },
      { id: 'past', business_id: A, appointment_date: '2026-09-26', status: 'Completed', private: secret },
    ],
  };
  const db = {
    auth: { async getUser(token) {
      verified.push(token);
      if (options.throwAt === 'auth') throw Error(secret);
      return token === 'valid' ? { data: { user: { id: 'user' } } } : { data: { user: null }, error: { message: secret } };
    } },
    from(table) {
      assert.equal(verified.at(-1), 'valid', 'domain query must follow verified identity');
      const call = { table, filters: [], orders: [] }; queries.push(call);
      const q = {
        select(fields) { call.fields = fields.split(/,\s*/); return q; },
        eq(key, value) { call.filters.push([key, value]); return q; },
        in(key, values) { call.in = [key, values]; return q; },
        order(key) { call.orders.push(key); return q; },
        range(start, end) { call.range = [start, end]; return q; },
        async execute(single = false) {
          if (options.throwAt === table) throw Error(secret);
          if (options.errorAt === table) return { data: null, error: { message: secret } };
          let rows = tables[table].filter(row => call.filters.every(([key, value]) => row[key] === value));
          if (call.in) rows = rows.filter(row => call.in[1].includes(row[call.in[0]]));
          rows.sort((a, b) => { for (const key of call.orders) { const cmp = String(a[key]).localeCompare(String(b[key])); if (cmp) return cmp; } return 0; });
          if (call.range) rows = rows.slice(call.range[0], call.range[1] + 1);
          rows = rows.map(row => Object.fromEntries(call.fields.map(key => [key, row[key]])));
          return { data: single ? rows[0] ?? null : rows, error: null };
        },
        maybeSingle() { return q.execute(true); },
        then(resolve, reject) { return q.execute().then(resolve, reject); },
      };
      return q;
    },
  };
  const cache = new Map();
  function load(file) {
    file = path.resolve(file);
    if (cache.has(file)) return cache.get(file);
    const exports = {}; cache.set(file, exports);
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, {
      exports, Request, Response, URL,
      console: { error: (...args) => logs.push(args.join(' ')) },
      process: { env: options.noConfig ? {} : { NEXT_PUBLIC_SUPABASE_URL: 'https://example.invalid', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'public-test-key' } },
      require(name) {
        if (name === '@supabase/supabase-js') return { createClient(url, key, config) {
          assert.equal(config.global.headers.Authorization, `Bearer ${options.expectedToken ?? 'valid'}`);
          assert.equal(config.auth.persistSession, false);
          return db;
        } };
        return load(name.startsWith('@/') ? name.slice(2) + '.ts' : path.resolve(path.dirname(file), name + '.ts'));
      },
    });
    return exports;
  }
  return { queries, logs, verified, async call(endpoint = 'appointments', { token = 'valid', businessId, query } = {}) {
    const headers = {};
    if (token !== null) headers.authorization = `Bearer ${token}`;
    if (businessId) headers['x-anaai-business-id'] = businessId;
    const suffix = query ?? (endpoint === 'appointments' ? `?date=${day}` : '');
    const file = endpoint === 'appointments' ? 'today-appointments' : endpoint;
    const response = await load(`server/handlers/${file}.ts`).GET(new Request(`https://zude.invalid/api/${endpoint}${suffix}`, { headers }));
    return { status: response.status, headers: response.headers, body: await response.json() };
  } };
}

for (const endpoint of ['businesses', 'appointments']) {
  test(`${endpoint}: missing authentication performs no domain read`, async () => {
    const h = harness(); const r = await h.call(endpoint, { token: null });
    assert.equal(r.status, 401); assert.equal(r.body.code, 'UNAUTHORIZED');
    assert.equal(h.queries.length, 0); assert.equal(h.verified.length, 0);
  });
  test(`${endpoint}: invalid token is verified and denied before domain reads`, async () => {
    const h = harness({ expectedToken: 'invalid' }); const r = await h.call(endpoint, { token: 'invalid' });
    assert.equal(r.status, 401); assert.equal(h.queries.length, 0);
    assert.deepEqual(h.verified, ['invalid']); assert.ok(!JSON.stringify([r.body, h.logs]).includes(secret));
  });
}

test('businesses: returns only verified memberships and minimal fields, ignoring forged selection header', async () => {
  const h = harness(); const r = await h.call('businesses', { businessId: B });
  assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual(r.body, { success: true, userId: 'user', businesses: [{ id: A, name: 'A business', timezone: 'America/Los_Angeles', role: 'staff' }] });
  assert.deepEqual(h.queries[0].filters, [['user_id', 'user']]);
});

for (const query of ['?user_id=other-user', `?business_id=${B}`, '?role=owner']) {
  test(`businesses: rejects client identity/scope query ${query}`, async () => {
    const h = harness(); assert.equal((await h.call('businesses', { query })).status, 400);
    assert.ok(!h.queries.some(q => q.table === 'businesses'));
  });
}

test('businesses: no membership gives an empty authorized list; Today is denied', async () => {
  const h = harness({ memberships: [] });
  assert.deepEqual((await h.call('businesses')).body.businesses, []);
  assert.equal((await h.call()).status, 403);
});

test('memberships with missing business records fail closed instead of granting a workspace', async () => {
  const h = harness({ businesses: [] });
  assert.equal((await h.call('businesses')).status, 500);
  const r = await h.call(); assert.equal(r.status, 404); assert.equal(r.body.code, 'BUSINESS_NOT_FOUND');
  assert.ok(!h.queries.some(q => q.table === 'appointments'));
});

test('invalid roles never grant native domain access', async () => {
  const h = harness({ memberships: [{ business_id: A, user_id: 'user', role: 'superuser' }] });
  assert.deepEqual((await h.call('businesses')).body.businesses, []);
  assert.equal((await h.call('appointments', { businessId: A })).status, 403);
  assert.ok(!h.queries.some(q => q.table === 'appointments'));
});

for (const businessId of [B, 'deleted-business', `${A},${B}`]) {
  test(`Today: forged/stale header ${businessId} cannot query appointments`, async () => {
    const h = harness(); const r = await h.call('appointments', { businessId });
    assert.equal(r.status, 403); assert.equal(r.body.code, 'BUSINESS_ACCESS_DENIED');
    assert.ok(!h.queries.some(q => q.table === 'appointments'));
  });
}

test('multi-business selection must be explicit and authorized', async () => {
  const h = harness({ memberships: [A, B].map(business_id => ({ business_id, user_id: 'user', role: 'manager' })) });
  assert.equal((await h.call()).status, 409);
  const list = await h.call('businesses'); assert.deepEqual(list.body.businesses.map(b => b.id), [A, B]);
  const r = await h.call('appointments', { businessId: B });
  assert.equal(r.status, 200); assert.equal(r.body.businessId, B);
  assert.deepEqual(r.body.appointments.map(a => a.id), ['b']);
  assert.equal((await h.call('appointments', { businessId: C })).status, 403);
});

test('Today: scopes business and local date, orders ties by ID, preserves snapshots and minimizes projection', async () => {
  const h = harness(); const r = await h.call();
  assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.body.businessId, A); assert.equal(r.body.date, day);
  assert.deepEqual(r.body.appointments.map(a => [a.id, a.duration_minutes]), [['a1', 45], ['a2', 30]]);
  const q = h.queries.find(q => q.table === 'appointments');
  assert.deepEqual(q.filters, [['business_id', A], ['appointment_date', day]]);
  assert.deepEqual(q.orders, ['appointment_time', 'id']);
  assert.deepEqual(Object.keys(r.body.appointments[0]), ['id', 'customer_name', 'service', 'appointment_time', 'status', 'duration_minutes']);
});

for (const query of ['', '?date=2026-02-29', '?date=2024-02-30', '?date=2026-13-01', '?date=0000-01-01', '?date=2026-9-27', '?date=2026-09-27T00:00:00Z', `?date=${day}&date=${day}`, `?date=${day}&business_id=${B}`, `?date=${day}&user_id=other-user`]) {
  test(`Today: rejects invalid date or extra scope ${query}`, async () => {
    const h = harness(); assert.equal((await h.call('appointments', { query })).status, 400);
    assert.ok(!h.queries.some(q => q.table === 'appointments'));
  });
}

test('Today: accepts real leap day and keeps it a business-local date', async () => {
  const r = await harness().call('appointments', { query: '?date=2024-02-29' });
  assert.equal(r.status, 200); assert.equal(r.body.date, '2024-02-29'); assert.deepEqual(r.body.appointments, []);
});

test('Today: reads beyond a single provider page, without filtering terminal statuses or null duration', async () => {
  const appointments = Array.from({ length: 501 }, (_, i) => ({ id: String(i).padStart(4, '0'), business_id: A, appointment_date: day,
    customer_name: null, service: 'Historical service', appointment_time: '09:00:00', status: i % 2 ? 'Cancelled' : 'Completed', duration_minutes: null }));
  const h = harness({ appointments }); const r = await h.call();
  assert.equal(r.body.appointments.length, 501);
  assert.deepEqual(h.queries.filter(q => q.table === 'appointments').map(q => q.range), [[0, 499], [500, 999]]);
  assert.equal(r.body.appointments[0].duration_minutes, null);
});

for (const endpoint of ['businesses', 'appointments']) {
  for (const stage of ['auth', 'business_members', 'businesses', ...(endpoint === 'appointments' ? ['appointments'] : [])]) {
    test(`${endpoint}: thrown ${stage} failure is sanitized`, async () => {
      const h = harness({ throwAt: stage }); const r = await h.call(endpoint);
      assert.equal(r.status, 500); assert.equal(r.body.success, false);
      assert.ok(!JSON.stringify([r.body, h.logs]).includes(secret));
    });
  }
  test(`${endpoint}: returned database errors are sanitized`, async () => {
    const h = harness({ errorAt: endpoint === 'businesses' ? 'businesses' : 'appointments' });
    const r = await h.call(endpoint); assert.equal(r.status, 500);
    assert.ok(!JSON.stringify([r.body, h.logs]).includes(secret));
  });
  test(`${endpoint}: missing server config is a safe structured error`, async () => {
    const r = await harness({ noConfig: true }).call(endpoint);
    assert.equal(r.status, 500); assert.equal(r.body.code, 'CONFIGURATION_ERROR');
  });
}
