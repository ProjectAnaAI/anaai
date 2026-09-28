const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, imports, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, URL, AbortController, ...globals, require(name) {
    if (Object.hasOwn(imports, name)) return imports[name];
    throw Error(`Unexpected dependency ${name}`);
  } });
  return exports;
}
const base = 'apps/zude-mobile/src/';
const session = { access_token: 'PRIVATE_TEST_TOKEN', user: { id: 'user-a' } };
function transport(options = {}) {
  const calls = []; let sessionReads = 0;
  const api = load(base + 'lib/api.ts', {
    './supabase': { supabase: { auth: { async getSession() {
      sessionReads++;
      if (options.sessionError) throw Error('PRIVATE_TEST_TOKEN');
      return { data: { session: options.noSession ? null : options.changedSession && sessionReads > 1
        ? { ...session, user: { id: 'user-b' } } : session }, error: null };
    } } } },
  }, {
    __DEV__: options.development ?? false,
    process: { env: { EXPO_PUBLIC_ZUDE_API_URL: options.url ?? 'https://zude.invalid' } },
    async fetch(url, init) {
      calls.push({ url, init });
      if (options.fetch) return options.fetch(url, init);
      return new Response(options.rawBody ?? JSON.stringify(options.payload ?? { success: true, value: 42 }), {
        status: options.status ?? 200, headers: { 'content-type': 'application/json' },
      });
    },
  });
  return { ...api, calls };
}

test('transport sends current Supabase bearer token and requested business to configured API only', async () => {
  const h = transport(); const controller = new AbortController();
  assert.equal((await h.apiGet('/api/appointments?date=2026-09-27', { businessId: 'a', signal: controller.signal })).value, 42);
  assert.equal(h.calls[0].url, 'https://zude.invalid/api/appointments?date=2026-09-27');
  assert.equal(h.calls[0].init.headers.Authorization, 'Bearer PRIVATE_TEST_TOKEN');
  assert.equal(h.calls[0].init.headers['x-anaai-business-id'], 'a');
  assert.equal(h.calls[0].init.signal, controller.signal);
  assert.equal(h.calls[0].init.redirect, 'error');
});

for (const url of ['', 'postgres://user:password@host/db', 'https://user:password@host', 'https://host?token=x', 'https://host/api', 'http://host']) {
  test(`transport rejects unsafe/malformed production origin ${url}`, async () => {
    const h = transport({ url });
    await assert.rejects(h.apiGet('/api/businesses'), e => e.code === 'CONFIGURATION_ERROR');
    assert.equal(h.calls.length, 0);
  });
}

test('transport permits explicit HTTP origin for local development', async () => {
  const h = transport({ url: 'http://192.168.1.2:4000', development: true });
  await h.apiGet('/api/businesses'); assert.equal(h.calls.length, 1);
});

test('transport cannot send bearer token to another origin', async () => {
  const h = transport();
  await assert.rejects(h.apiGet('https://attacker.invalid/api/businesses'), e => e.code === 'CONFIGURATION_ERROR');
  assert.equal(h.calls.length, 0);
});

test('transport rejects missing session before network access', async () => {
  const h = transport({ noSession: true });
  await assert.rejects(h.apiGet('/api/businesses'), e => e.status === 401 && e.code === 'UNAUTHORIZED');
  assert.equal(h.calls.length, 0);
});

test('transport preserves structured error status/code without showing raw provider diagnostics', async () => {
  const h = transport({ status: 403, payload: { success: false, code: 'BUSINESS_ACCESS_DENIED', error: 'PRIVATE_TEST_TOKEN' } });
  await assert.rejects(h.apiGet('/api/businesses'), e => e.status === 403 && e.code === 'BUSINESS_ACCESS_DENIED' && !e.message.includes('PRIVATE_TEST_TOKEN'));
});

test('transport classifies non-JSON responses', async () => {
  const h = transport({ status: 502, rawBody: '<html>PRIVATE_TEST_TOKEN</html>' });
  await assert.rejects(h.apiGet('/api/businesses'), e => e.code === 'INVALID_RESPONSE' && !e.message.includes('PRIVATE_TEST_TOKEN'));
});

test('transport sanitizes network/session exceptions', async () => {
  for (const h of [transport({ sessionError: true }), transport({ fetch() { throw Error('PRIVATE_TEST_TOKEN'); } })]) {
    await assert.rejects(h.apiGet('/api/businesses'), e => e.code === 'NETWORK_ERROR' && !e.message.includes('PRIVATE_TEST_TOKEN'));
  }
});

test('transport refuses response from a previous account session', async () => {
  const h = transport({ changedSession: true });
  await assert.rejects(h.apiGet('/api/businesses'), e => e.code === 'SESSION_CHANGED');
});

test('transport cancellation before fetch performs no request', async () => {
  const h = transport(); const controller = new AbortController(); controller.abort();
  await assert.rejects(h.apiGet('/api/businesses', { signal: controller.signal }), e => e.code === 'CANCELLED');
  assert.equal(h.calls.length, 0);
});

test('transport ignores a response that arrives after cancellation', async () => {
  const controller = new AbortController();
  const h = transport({ fetch() { controller.abort(); return Response.json({ success: true }); } });
  await assert.rejects(h.apiGet('/api/businesses', { signal: controller.signal }), e => e.code === 'CANCELLED');
});

function domain(payload) {
  const h = transport({ payload });
  return load(base + 'lib/today-api.ts', { './api': h });
}
const a = { id: 'a', name: 'A', timezone: 'UTC', role: 'staff' };
const b = { id: 'b', name: 'B', timezone: 'Pacific/Auckland', role: 'manager' };
test('remembered selection is limited to authorized businesses, with safe single-business fallback', () => {
  const { rememberedBusiness } = domain({});
  assert.equal(rememberedBusiness([a, b], 'b'), b);
  assert.equal(rememberedBusiness([a, b], 'revoked'), undefined);
  assert.equal(rememberedBusiness([a], 'revoked'), a);
  assert.equal(rememberedBusiness([], 'a'), undefined);
});

test('business response validates roles and identity shape', async () => {
  const valid = { success: true, userId: 'user-a', businesses: [a, b] };
  assert.equal((await domain(valid).getBusinesses()).businesses.length, 2);
  for (const invalid of [{ ...valid, userId: null }, { ...valid, businesses: [{ ...a, role: 'owner-forged' }] }]) {
    await assert.rejects(domain(invalid).getBusinesses(), e => e.code === 'INVALID_RESPONSE');
  }
});

test('Today rejects responses for the wrong business or date', async () => {
  for (const payload of [
    { success: true, businessId: 'other', date: '2026-09-27', appointments: [] },
    { success: true, businessId: 'a', date: '2026-09-26', appointments: [] },
  ]) await assert.rejects(domain(payload).getTodayAppointments('a', '2026-09-27'), e => e.code === 'INVALID_RESPONSE');
});

test('native domain access has no direct Supabase business/appointment reads', () => {
  for (const file of ['features/business/BusinessContext.tsx', 'features/today/useTodayAppointments.ts', 'lib/today-api.ts']) {
    const source = fs.readFileSync(base + file, 'utf8');
    assert.doesNotMatch(source, /supabase|\.from\s*\(|\.rpc\s*\(/);
  }
});
