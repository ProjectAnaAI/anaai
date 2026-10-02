// Real Express app/adapter and real business handler/resolver. Provider fetches
// in the authenticated test are intercepted with synthetic fixtures only.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { register } = require('tsx/cjs/api');
const unregister = register();
const { createApp } = require('../server/app.ts');
const { apiCors } = require('../server/cors.ts');
const nativeFetch = global.fetch;
const servers = [];
const origin = 'http://localhost:8081';

after(async () => {
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  unregister();
});

async function app(origins = origin) {
  const saved = process.env.ZUDE_CORS_ORIGINS;
  process.env.ZUDE_CORS_ORIGINS = origins;
  let application;
  try { application = createApp(); }
  finally {
    if (saved === undefined) delete process.env.ZUDE_CORS_ORIGINS;
    else process.env.ZUDE_CORS_ORIGINS = saved;
  }
  const server = application.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  return `http://127.0.0.1:${server.address().port}`;
}
function preflight(base, { requestOrigin = origin, method = 'GET', headers = 'authorization', path = '/api/businesses' } = {}) {
  return nativeFetch(base + path, { method: 'OPTIONS', headers: {
    Origin: requestOrigin, 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': headers,
  } });
}
function grant(response) {
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
  assert.match(response.headers.get('vary'), /Origin/);
}

test('Expo web preflight is approved without a bearer token and before domain authentication', async () => {
  const response = await preflight(await app());
  assert.equal(response.status, 204); assert.equal(await response.text(), ''); grant(response);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('vary'), /Access-Control-Request-Headers/);
  assert.deepEqual(response.headers.get('access-control-allow-methods').split(', '), ['GET', 'POST', 'PATCH']);
});

for (const method of ['GET', 'POST', 'PATCH']) {
  test(`${method}: Today and mutation preflight headers are explicitly permitted`, async () => {
    const response = await preflight(await app(), { method, path: '/api/appointments',
      headers: 'Authorization, Accept, Content-Type, X-AnaAI-Business-ID, Idempotency-Key' });
    assert.equal(response.status, 204); grant(response);
    assert.deepEqual(response.headers.get('access-control-allow-headers').toLowerCase().split(', '),
      ['authorization', 'accept', 'content-type', 'x-anaai-business-id', 'idempotency-key', 'x-zude-device', 'x-zude-employee-session']);
  });
}

for (const requestOrigin of ['https://untrusted.invalid', 'http://localhost:8082', 'http://localhost:8081.attacker.invalid', 'null']) {
  test(`unapproved origin ${requestOrigin} gets no browser access grant`, async () => {
    const base = await app();
    const response = await preflight(base, { requestOrigin });
    assert.equal(response.status, 403); assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.equal((await response.json()).code, 'CORS_DENIED');
    const actual = await nativeFetch(base + '/api/businesses', { headers: { Origin: requestOrigin } });
    assert.equal(actual.status, 401); assert.equal(actual.headers.get('access-control-allow-origin'), null);
  });
}

for (const extra of [{ method: 'DELETE' }, { method: 'PUT' }, { headers: 'authorization, x-unapproved' }]) {
  test(`preflight rejects unsupported method/headers ${JSON.stringify(extra)}`, async () => {
    const response = await preflight(await app(), extra);
    assert.equal(response.status, 403); assert.equal(response.headers.get('access-control-allow-origin'), null);
  });
}

test('production/unconfigured policy has no implicit localhost or arbitrary origin trust', async () => {
  const saved = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const response = await preflight(await app(''));
    assert.equal(response.status, 403); assert.equal(response.headers.get('access-control-allow-origin'), null);
  } finally { if (saved === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved; }
});

test('explicit multiple origins are matched exactly', async () => {
  const base = await app(`${origin}, https://admin.example.test`);
  const response = await preflight(base, { requestOrigin: 'https://admin.example.test' });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://admin.example.test');
});

for (const invalid of ['*', 'null', 'https://*.example.test', 'https://example.test/path', 'https://fixture:fixture@example.test']) {
  test('invalid origin configuration fails safely without echoing configuration', () => {
    assert.throws(() => apiCors(invalid), error => error.message === 'ZUDE_CORS_ORIGINS must contain comma-separated HTTP(S) origins only.');
  });
}

test('approved-origin errors remain readable and still require bearer authentication', async () => {
  const base = await app();
  for (const [method, path] of [['GET', '/api/businesses'], ['GET', '/api/appointments?date=2026-09-27'], ['POST', '/api/appointments'], ['PATCH', '/api/appointments'], ['POST', '/api/onboarding']]) {
    const response = await nativeFetch(base + path, { method, headers: { Origin: origin, 'Content-Type': 'application/json' },
      ...(method === 'GET' ? {} : { body: '{}' }) });
    assert.equal(response.status, 401); grant(response);
  }
});

test('approved-origin authenticated business request passes real identity/membership resolution', async () => {
  const savedUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const savedKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://cors-provider.invalid';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'public-fixture';
  const calls = [];
  global.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, 'https://cors-provider.invalid', 'no live provider calls');
    calls.push(url.pathname);
    const authorization = new Headers(init?.headers).get('authorization');
    if (url.pathname === '/auth/v1/user') {
      if (authorization !== 'Bearer cors-fixture-session') return Response.json({ message: 'Invalid token' }, { status: 401 });
      return Response.json({ id: 'verified-user', aud: 'authenticated', role: 'authenticated' });
    }
    if (url.pathname === '/rest/v1/business_members') {
      assert.equal(url.searchParams.get('user_id'), 'eq.verified-user');
      return Response.json([{ business_id: 'business-a', role: 'staff' }]);
    }
    if (url.pathname === '/rest/v1/businesses') {
      assert.equal(url.searchParams.get('id'), 'in.(business-a)');
      return Response.json([{ id: 'business-a', name: 'Fixture Business', timezone: 'UTC' }]);
    }
    throw Error('Unexpected fixture endpoint');
  };
  try {
    const base = await app();
    const response = await nativeFetch(base + '/api/businesses', { headers: { Origin: origin, Authorization: 'Bearer cors-fixture-session' } });
    assert.equal(response.status, 200); grant(response);
    assert.deepEqual(await response.json(), { success: true, userId: 'verified-user', businesses: [{ id: 'business-a', name: 'Fixture Business', timezone: 'UTC', role: 'staff' }] });
    assert.deepEqual(calls, ['/auth/v1/user', '/rest/v1/business_members', '/rest/v1/businesses']);
    const invalid = await nativeFetch(base + '/api/businesses', { headers: { Origin: origin, Authorization: 'Bearer invalid-fixture' } });
    assert.equal(invalid.status, 401); grant(invalid);
    assert.equal(calls.filter(path => path === '/rest/v1/business_members').length, 1);
  } finally {
    global.fetch = nativeFetch;
    for (const [name, value] of [['NEXT_PUBLIC_SUPABASE_URL', savedUrl], ['NEXT_PUBLIC_SUPABASE_ANON_KEY', savedKey]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test('requests without Origin preserve native authentication and Twilio signature rejection', async () => {
  const base = await app();
  const response = await nativeFetch(base + '/api/businesses');
  assert.equal(response.status, 401); assert.equal(response.headers.get('access-control-allow-origin'), null);
  const voice = await nativeFetch(base + '/api/voice', { method: 'POST', body: new URLSearchParams({ To: '+15005550006' }) });
  assert.equal(voice.status, 403); assert.equal(voice.headers.get('access-control-allow-origin'), null);
});

test('shared-device management headers are explicitly permitted, arbitrary headers still denied', async () => {
  const base = await app();
  const allowed = await preflight(base, { method: 'PATCH', path: '/api/team/x', headers: 'Authorization, Content-Type, X-AnaAI-Business-ID, X-Zude-Device, X-Zude-Employee-Session' });
  assert.equal(allowed.status, 204);
  const denied = await preflight(base, { method: 'PATCH', path: '/api/team/x', headers: 'Authorization, X-Zude-Role' });
  assert.equal(denied.status, 403);
});
