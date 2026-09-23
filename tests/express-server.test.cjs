// Run: node --test tests/express-server.test.cjs
// Integration tests for the standalone Express API (server/). Each test boots a
// real HTTP server on an ephemeral port and talks to it over the network. No
// Supabase, OpenAI or Twilio calls are made: every exercised path is rejected
// or answered before a provider is contacted.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { register } = require('tsx/cjs/api');

// Keep the suite hermetic regardless of the developer's .env.local.
for (const name of [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SECRET_KEY',
  'OPENAI_API_KEY',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_VOICE_WEBHOOK_URL',
  'TWILIO_TRIAL_VOICE_TOKEN',
  'API_URL',
]) {
  delete process.env[name];
}
// Placeholder config only: tested paths reject missing auth before any network call.
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.invalid';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';

const unregister = register();
const express = require('express');
const twilio = require('twilio');
const { createApp } = require('../server/app.ts');
const { webHandler } = require('../server/http.ts');

const servers = [];

after(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  unregister();
});

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

let apiBase;
async function api() {
  apiBase ||= await listen(createApp());
  return apiBase;
}

async function json(response) {
  assert.match(response.headers.get('content-type') || '', /application\/json/);
  return response.json();
}

// --- Web Request/Response adapter -------------------------------------------

test('adapter forwards method, url, query, headers and raw body to the handler', async () => {
  let seen;
  const app = express();
  app.use(express.raw({ type: () => true }));
  app.all(
    '/echo',
    webHandler(async (request) => {
      seen = {
        method: request.method,
        url: new URL(request.url),
        authorization: request.headers.get('authorization'),
        custom: request.headers.get('x-custom'),
        host: request.headers.get('host'),
        body: await request.text(),
      };
      return Response.json({ ok: true }, { status: 201 });
    })
  );
  const base = await listen(app);

  const response = await fetch(`${base}/echo?mode=gather&state=abc`, {
    method: 'PATCH',
    headers: { authorization: 'Bearer token-1', 'x-custom': 'value', 'content-type': 'application/json' },
    body: JSON.stringify({ hello: 'world' }),
  });

  assert.equal(response.status, 201);
  assert.deepEqual(await json(response), { ok: true });
  assert.equal(seen.method, 'PATCH');
  assert.equal(seen.url.pathname, '/echo');
  assert.equal(seen.url.searchParams.get('mode'), 'gather');
  assert.equal(seen.url.searchParams.get('state'), 'abc');
  assert.equal(seen.authorization, 'Bearer token-1');
  assert.equal(seen.custom, 'value');
  assert.equal(seen.host, null, 'connection-level headers are not forwarded');
  assert.equal(seen.body, '{"hello":"world"}');
});

test('adapter parses urlencoded form bodies exactly as Twilio sends them', async () => {
  let fields;
  const app = express();
  app.use(express.raw({ type: () => true }));
  app.post(
    '/form',
    webHandler(async (request) => {
      fields = Object.fromEntries(await request.formData());
      return new Response('<Response/>', { headers: { 'content-type': 'text/xml' } });
    })
  );
  const base = await listen(app);

  const response = await fetch(`${base}/form`, {
    method: 'POST',
    body: new URLSearchParams({ CallSid: 'CA123', From: '+15555550100', SpeechResult: 'book a haircut' }),
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/xml');
  assert.equal(await response.text(), '<Response/>');
  assert.deepEqual(fields, { CallSid: 'CA123', From: '+15555550100', SpeechResult: 'book a haircut' });
});

test('adapter sends GET requests without a body and preserves response headers', async () => {
  let body = 'unset';
  const app = express();
  app.use(express.raw({ type: () => true }));
  app.get(
    '/headers',
    webHandler(async (request) => {
      body = request.body;
      const headers = new Headers({ 'cache-control': 'no-store', 'x-anaai': '1' });
      headers.append('set-cookie', 'a=1; Path=/');
      headers.append('set-cookie', 'b=2; Path=/');
      return new Response('ok', { status: 202, headers });
    })
  );
  const base = await listen(app);

  const response = await fetch(`${base}/headers`);

  assert.equal(response.status, 202);
  assert.equal(await response.text(), 'ok');
  assert.equal(body, null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-anaai'), '1');
  assert.deepEqual(response.headers.getSetCookie(), ['a=1; Path=/', 'b=2; Path=/']);
});

test('adapter passes handler exceptions to Express error handling', async () => {
  const app = express();
  app.get('/boom', webHandler(async () => { throw new Error('PRIVATE DETAIL'); }));
  app.use((error, _req, res, _next) => res.status(500).json({ caught: error.message }));
  const base = await listen(app);

  const response = await fetch(`${base}/boom`);

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { caught: 'PRIVATE DETAIL' });
});

// --- The AnaAI Express app ---------------------------------------------------

test('health check responds and Express fingerprinting is disabled', async () => {
  const response = await fetch(`${await api()}/health`);

  assert.equal(response.status, 200);
  assert.deepEqual(await json(response), { ok: true });
  assert.equal(response.headers.get('x-powered-by'), null);
  assert.equal(response.headers.get('etag'), null);
});

test('every authenticated endpoint is mounted and rejects missing credentials', async () => {
  const base = await api();
  const cases = [
    ['GET', '/api/current-business', { success: false, error: 'Missing authorization token.' }],
    ['POST', '/api/onboarding', { error: 'Please log in again.' }],
    ['POST', '/api/appointments', { error: 'Please log in again.' }],
    ['PATCH', '/api/appointments', { error: 'Please log in again.' }],
    ['POST', '/api/ai', { error: 'Invalid authorization header.' }],
  ];

  for (const [method, route, expected] of cases) {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: method === 'GET' ? {} : { 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : '{}',
    });

    assert.equal(response.status, 401, `${method} ${route}`);
    assert.deepEqual(await json(response), expected, `${method} ${route}`);
  }
});

test('voice status endpoint returns TwiML', async () => {
  const response = await fetch(`${await api()}/api/voice`);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/xml');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(await response.text(), /<Response><Say[^>]*>AnaAI voice service is online\.<\/Say><\/Response>/);
});

test('voice webhook rejects unsigned and wrongly signed Twilio requests', async () => {
  const base = await api();
  process.env.TWILIO_AUTH_TOKEN = 'test-auth-token';
  process.env.TWILIO_VOICE_WEBHOOK_URL = 'https://anaai.example/api/voice';

  try {
    const params = { CallSid: 'CA123', From: '+15555550100' };
    const unsigned = await fetch(`${base}/api/voice`, { method: 'POST', body: new URLSearchParams(params) });
    assert.equal(unsigned.status, 403);
    assert.equal(await unsigned.text(), 'Forbidden');

    const signature = twilio.getExpectedTwilioSignature('test-auth-token', 'https://anaai.example/api/voice', params);
    const tampered = await fetch(`${base}/api/voice`, {
      method: 'POST',
      headers: { 'x-twilio-signature': signature },
      body: new URLSearchParams({ ...params, From: '+15555550199' }),
    });
    assert.equal(tampered.status, 403);
  } finally {
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_VOICE_WEBHOOK_URL;
  }
});

test('voice webhook accepts a correctly signed Twilio request through Express', async () => {
  const base = await api();
  process.env.TWILIO_AUTH_TOKEN = 'test-auth-token';
  process.env.TWILIO_VOICE_WEBHOOK_URL = 'https://anaai.example/api/voice';

  try {
    const params = { CallSid: 'CA123', From: '+15555550100' };
    // Twilio signs the configured public URL plus the query string it called.
    const signature = twilio.getExpectedTwilioSignature(
      'test-auth-token',
      'https://anaai.example/api/voice?mode=gather',
      params
    );
    const response = await fetch(`${base}/api/voice?mode=gather`, {
      method: 'POST',
      headers: { 'x-twilio-signature': signature },
      body: new URLSearchParams(params),
    });

    // The signature check passed (not 403). With no database configured the
    // handler answers with its spoken fallback, which is still valid TwiML.
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/xml');
    assert.match(await response.text(), /^<\?xml[\s\S]*<Response>[\s\S]*<\/Response>$/);
  } finally {
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_VOICE_WEBHOOK_URL;
  }
});

test('trial voice webhook is closed to GET and to wrong tokens', async () => {
  const base = await api();
  process.env.TWILIO_TRIAL_VOICE_TOKEN = 'trial-secret';

  try {
    assert.equal((await fetch(`${base}/api/voice/trial`)).status, 403);

    const wrong = await fetch(`${base}/api/voice/trial?token=nope`, {
      method: 'POST',
      body: new URLSearchParams({ CallSid: 'CA123' }),
    });
    assert.equal(wrong.status, 403);
    assert.equal(await wrong.text(), 'Forbidden');
  } finally {
    delete process.env.TWILIO_TRIAL_VOICE_TOKEN;
  }
});

test('unknown API paths and unsupported methods return JSON 404', async () => {
  const base = await api();

  for (const [method, route] of [['GET', '/api/nope'], ['GET', '/api/ai'], ['DELETE', '/api/appointments']]) {
    const response = await fetch(`${base}${route}`, { method });
    assert.equal(response.status, 404, `${method} ${route}`);
    assert.deepEqual(await json(response), { success: false, error: 'Not found.' });
  }
});

test('oversized request bodies are rejected with 413 before reaching a handler', async () => {
  const response = await fetch(`${await api()}/api/ai`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'x'.repeat(1024 * 1024 + 1),
  });

  assert.equal(response.status, 413);
  assert.deepEqual(await json(response), { success: false, error: 'Request body is too large.' });
});

// --- Next.js wiring -----------------------------------------------------------

test('Next.js proxies /api/* to the Express server', async () => {
  const load = () => {
    delete require.cache[require.resolve('../next.config.ts')];
    return require('../next.config.ts').default;
  };

  try {
    delete process.env.API_URL;
    assert.deepEqual(await load().rewrites(), [
      { source: '/api/:path*', destination: 'http://localhost:4000/api/:path*' },
    ]);

    process.env.API_URL = 'https://api.anaai.example/';
    assert.deepEqual(await load().rewrites(), [
      { source: '/api/:path*', destination: 'https://api.anaai.example/api/:path*' },
    ]);
  } finally {
    delete process.env.API_URL;
  }
});

test('Next.js no longer owns API routes and backend code is Next-independent', () => {
  assert.equal(fs.existsSync('app/api'), false, 'app/api must not shadow the Express API');

  const files = ['server', 'lib'].flatMap((dir) =>
    fs.readdirSync(dir, { recursive: true })
      .filter((file) => /\.ts$/.test(file))
      .map((file) => path.join(dir, file))
  );
  const backend = files.filter((file) => file.startsWith('server'));

  assert.ok(backend.length >= 9);
  for (const file of backend) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /from ["']next\//, file);
  }
  for (const file of files) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /import ["']server-only["']/, file);
  }
});

test('npm scripts start the API alongside Next.js', () => {
  const { scripts, dependencies } = JSON.parse(fs.readFileSync('package.json', 'utf8'));

  assert.match(scripts.dev, /npm:dev:web/);
  assert.match(scripts.dev, /npm:dev:api/);
  assert.equal(scripts['dev:web'], 'next dev');
  assert.equal(scripts['dev:api'], 'tsx watch server/index.ts');
  assert.equal(scripts['start:api'], 'tsx server/index.ts');
  assert.ok(dependencies.express);
  assert.ok(dependencies.tsx, 'tsx runs the API in production, so it is a runtime dependency');
});
