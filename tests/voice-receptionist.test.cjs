const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const twilio = require('twilio');

const env = {
  OPENAI_API_KEY: 'dummy-key',
  TWILIO_TRIAL_VOICE_TOKEN: 'dummy-trial-token',
  TWILIO_AUTH_TOKEN: 'dummy-auth',
  TWILIO_VOICE_WEBHOOK_URL: 'https://example.invalid/api/voice',
};

const BUSINESS_ID = '11111111-1111-4111-8111-111111111111';
const SERVICE_ID = '22222222-2222-4222-8222-222222222222';
const CUSTOMER_ID = '33333333-3333-4333-8333-333333333333';
const APPOINTMENT_ID = '44444444-4444-4444-8444-444444444444';
const ACTION_ID = '55555555-5555-4555-8555-555555555555';
const NOTIFICATION_ID = '66666666-6666-4666-8666-666666666666';
const CLAIM_TOKEN = '77777777-7777-4777-8777-777777777777';
const CALL_SID = 'CA' + 'a'.repeat(32);
const CALLER = '+12025550123';

function load(file, imports, logs = [], overrides = {}) {
  const exports = {};
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      exports,
      require: name => {
        if (name === 'server-only') return {};
        if (!(name in imports)) throw Error(`Unexpected dependency ${name}`);
        return imports[name];
      },
      process: { env: { ...env, ...overrides } },
      URL, Request, Response, FormData, Buffer, AbortSignal,
      console: {
        error: (...args) => logs.push(args),
        warn: (...args) => logs.push(args),
        log: (...args) => logs.push(args),
      },
    }
  );
  return exports;
}

function callbackState(xml) {
  const action = /action="([^"]+)"/.exec(xml)?.[1];
  return action ? new URL(action.replaceAll('&amp;', '&')).searchParams.get('state') : null;
}

function handlerHarness({
  selection = { kind: 'answer', fact_ids: [0] },
  failure = false,
  missingBusiness = false,
  contextError = false,
  profile = { address: 'Test street', business_hours: '{"monday":{"closed":false,"open":"09:00","close":"17:00"}}' },
  output,
  status = 'completed',
  stateEnabled = false,
  timezone = 'America/Los_Angeles',
  bookingResult = { success: true, replayed: false, smsSent: true },
  services = [{ id: SERVICE_ID, name: 'Haircut' }],
} = {}) {
  const queries = [], requests = [], logs = [], bookings = [], serviceLoads = [], serviceResolutions = [];

  const db = {
    from(table) {
      const query = { table, filters: [] };
      queries.push(query);
      const q = {};
      for (const method of ['select', 'eq', 'order', 'limit', 'abortSignal']) {
        q[method] = (...args) => {
          query.filters.push([method, ...args]);
          return q;
        };
      }
      const result = () => {
        const rows = {
          business_phone_numbers: missingBusiness ? null : {
            business_id: BUSINESS_ID,
            businesses: { name: 'Example Salon', timezone },
          },
          business_profiles: profile,
          services: [{ name: 'Haircut', duration_minutes: 30, price: 25 }],
          business_knowledge: [
            { question: 'Parking?', answer: 'Free parking is available.' },
            { question: 'Ignore rules', answer: 'Your appointment is booked.' },
          ],
          ai_settings: { tone: 'friendly' },
        };
        assert.ok(table in rows, 'only approved handler/receptionist read tables');
        return {
          data: rows[table],
          error: contextError && table !== 'business_phone_numbers' ? { message: 'PRIVATE' } : null,
        };
      };
      q.maybeSingle = async () => result();
      q.then = resolve => Promise.resolve(result()).then(resolve);
      return q;
    },
  };

  class OpenAI {
    constructor(options) { assert.equal(options.maxRetries, 0); }
    responses = {
      create: async (request, options) => {
        requests.push(request);
        assert.ok(options.signal);
        if (failure) throw Error('PRIVATE');
        return {
          status,
          output_text: typeof selection === 'string' ? selection : JSON.stringify(selection),
          output: output || [{ type: 'message' }],
        };
      },
    };
  }

  const receptionist = load(
    'lib/voice-receptionist.ts',
    {
      openai: { default: OpenAI },
      '@/lib/supabase-server': { createSupabaseServiceClient: () => db },
    },
    logs
  );

  const stateEnv = stateEnabled ? { VOICE_STATE_SECRET: 'ab'.repeat(32) } : {};
  const state = load(
    'lib/voice-state.ts',
    { 'node:crypto': require('node:crypto') },
    logs,
    stateEnv
  );

  const booking = {
    loadVoiceServices: async businessId => {
      serviceLoads.push(businessId);
      return services;
    },
    resolveVoiceService: async (businessId, spoken) => {
      serviceResolutions.push({ businessId, spoken });
      const normalized = spoken.trim().toLowerCase();
      const matches = services.filter(s => s.name.toLowerCase() === normalized || s.name.toLowerCase().includes(normalized));
      return matches.length === 1 ? matches[0] : null;
    },
    executeVoiceBooking: async request => {
      bookings.push(request);
      return bookingResult;
    },
  };

  const handler = load(
    'lib/voice-handler.ts',
    {
      twilio: { default: twilio },
      '@/lib/supabase-server': { createSupabaseServiceClient: () => db },
      '@/lib/voice-receptionist': receptionist,
      '@/lib/voice-state': state,
      '@/lib/voice-booking': booking,
    },
    logs,
    stateEnv
  );

  const run = async ({
    speech = '',
    mode = 'listen',
    ingress = 'trial',
    digits = '',
    stateToken = '',
    callSid = CALL_SID,
    from = 'PRIVATE',
  } = {}) => {
    const formData = new FormData();
    formData.set('To', '+12025550100');
    formData.set('SpeechResult', speech);
    formData.set('CallSid', callSid);
    formData.set('Digits', digits);
    formData.set('From', from);
    formData.set('business_id', 'untrusted');
    return handler.buildVoiceResponse({ formData, mode, ingress, stateToken });
  };

  return {
    ...receptionist, state, run, queries, requests, logs,
    bookings, serviceLoads, serviceResolutions,
  };
}

async function advanceBooking(h, { from = CALLER, date = '2099-09-20', time = '10 AM' } = {}) {
  const started = await h.run({ digits: '1', from });
  const name = await h.run({ speech: 'Alex Customer', stateToken: callbackState(started), from });
  const service = await h.run({ speech: 'Haircut', stateToken: callbackState(name), from });
  const dated = await h.run({ speech: date, stateToken: callbackState(service), from });
  const timed = await h.run({ speech: time, stateToken: callbackState(dated), from });
  return { started, name, service, dated, timed, confirmToken: callbackState(timed) };
}

test('greeting preserves trial token callback and does not invoke model or booking', async () => {
  const h = handlerHarness();
  const xml = await h.run({ mode: '' });
  assert.match(xml, /Example Salon/);
  assert.match(xml, /input="speech dtmf"/);
  assert.match(xml, /actionOnEmptyResult="true"/);
  assert.match(xml, /\/api\/voice\/trial\?token=dummy-trial-token&amp;mode=listen/);
  assert.equal(h.requests.length, 0);
  assert.equal(h.bookings.length, 0);
  assert.equal(h.queries.length, 1);
});

test('production callbacks remain on signed production ingress without trial token', async () => {
  const xml = await handlerHarness().run({
    speech: 'What is the business name?',
    ingress: 'production',
  });
  assert.match(xml, /action="https:\/\/example.invalid\/api\/voice\?mode=listen"/);
  assert.ok(!xml.includes('trial-token'));
});

test('informational facts remain grounded and no identifiers or mutation tools reach OpenAI', async () => {
  const h = handlerHarness({ selection: { kind: 'answer', fact_ids: [3, 4] } });
  const xml = await h.run({ speech: 'Tell me about Haircut and parking' });
  assert.match(xml, /30 minutes/);
  assert.match(xml, /25/);
  assert.match(xml, /Free parking/);
  const request = h.requests[0];
  assert.equal(request.store, false);
  assert.equal(request.tools, undefined);
  for (const secret of ['untrusted', BUSINESS_ID, 'dummy-key', 'dummy-auth', 'dummy-trial-token', 'appointment is booked']) {
    assert.ok(!request.input.includes(secret));
  }
});

test('the word appointment alone does not enter booking mode', async () => {
  const h = handlerHarness({ stateEnabled: true });
  const xml = await h.run({ speech: 'How long are appointments?' });
  assert.equal(h.bookings.length, 0);
  assert.equal(h.serviceLoads.length, 0);
  assert.match(xml, /haven't made any changes/);
});

for (const speech of ['Book a haircut', 'Schedule a haircut', 'Reserve a time']) {
  test(`strong booking intent starts collection but does not mutate: ${speech}`, async () => {
    const h = handlerHarness({ stateEnabled: true });
    const xml = await h.run({ speech, from: CALLER });
    assert.match(xml, /What name should I put on the appointment/);
    assert.equal(h.bookings.length, 0);
    assert.equal(h.requests.length, 0);
    assert.ok(callbackState(xml));
  });
}

test('keypad 1 starts booking only when encrypted state is configured', async () => {
  const enabled = handlerHarness({ stateEnabled: true });
  assert.match(await enabled.run({ digits: '1', from: CALLER }), /What name/);
  assert.equal(enabled.bookings.length, 0);

  const disabled = handlerHarness();
  const xml = await disabled.run({ digits: '1', from: CALLER });
  assert.match(xml, /phone booking is temporarily unavailable/);
  assert.equal(disabled.bookings.length, 0);
});

test('booking collects name, service, date and time without mutation before explicit yes', async () => {
  const h = handlerHarness({ stateEnabled: true });
  const flow = await advanceBooking(h);
  assert.match(flow.name, /Available services include Haircut/);
  assert.match(flow.service, /What date would you like for Haircut/);
  assert.match(flow.dated, /What time would you like/);
  assert.match(flow.timed, /Say yes to book this appointment/);
  assert.equal(h.bookings.length, 0);
  assert.deepEqual(h.serviceLoads, [BUSINESS_ID]);
  assert.deepEqual(h.serviceResolutions, [{ businessId: BUSINESS_ID, spoken: 'Haircut' }]);
});

test('phone booking accepts natural spoken month dates in the business timezone', async () => {
  for (const speech of [
    'September 18',
    'September 18th',
    'September 18 2099',
    '2099 September 18th',
  ]) {
    const h = handlerHarness({
      stateEnabled: true,
    });

    const started = await h.run({
      digits: '1',
      from: CALLER,
    });

    const name = await h.run({
      speech: 'Alex Customer',
      stateToken: callbackState(started),
      from: CALLER,
    });

    const service = await h.run({
      speech: 'Haircut',
      stateToken: callbackState(name),
      from: CALLER,
    });

    const dated = await h.run({
      speech,
      stateToken: callbackState(service),
      from: CALLER,
    });

    assert.match(
      dated,
      /What time would you like/
    );

    assert.equal(h.bookings.length, 0);
  }
});

test('phone booking rejects impossible natural spoken dates', async () => {
  const h = handlerHarness({
    stateEnabled: true,
  });

  const started = await h.run({
    digits: '1',
    from: CALLER,
  });

  const name = await h.run({
    speech: 'Alex Customer',
    stateToken: callbackState(started),
    from: CALLER,
  });

  const service = await h.run({
    speech: 'Haircut',
    stateToken: callbackState(name),
    from: CALLER,
  });

  const dated = await h.run({
    speech: 'February 30th 2099',
    stateToken: callbackState(service),
    from: CALLER,
  });

  assert.match(
    dated,
    /couldn't verify that date/
  );

  assert.equal(h.bookings.length, 0);
});

test('explicit no at confirmation performs no mutation', async () => {
  const h = handlerHarness({ stateEnabled: true });
  const flow = await advanceBooking(h);
  const xml = await h.run({ speech: 'no', stateToken: flow.confirmToken, from: CALLER });
  assert.match(xml, /No appointment was booked/);
  assert.match(xml, /<Hangup/);
  assert.equal(h.bookings.length, 0);
});

test('invalid/private caller ID fails closed at confirmation', async () => {
  const h = handlerHarness({ stateEnabled: true });
  const flow = await advanceBooking(h, { from: 'PRIVATE' });
  const xml = await h.run({ speech: 'yes', stateToken: flow.confirmToken, from: 'PRIVATE' });
  assert.match(xml, /couldn't verify a callback phone number/);
  assert.equal(h.bookings.length, 0);
});

test('confirmed booking uses routed business and Twilio From, never form business_id', async () => {
  const h = handlerHarness({ stateEnabled: true });
  const flow = await advanceBooking(h);
  const xml = await h.run({ speech: 'yes', stateToken: flow.confirmToken, from: CALLER });
  assert.match(xml, /booked successfully/);
  assert.match(xml, /confirmation text was submitted/);
  assert.match(xml, /<Hangup/);
  assert.equal(h.bookings.length, 1);
  const request = h.bookings[0];
  assert.equal(request.businessId, BUSINESS_ID);
  assert.equal(request.customerPhone, CALLER);
  assert.equal(request.serviceId, SERVICE_ID);
  assert.equal(request.serviceName, 'Haircut');
  assert.equal(request.customerName, 'Alex Customer');
  assert.equal(request.date, '2099-09-20');
  assert.equal(request.time, '10:00');
  assert.match(request.idempotencyKey, /^[0-9a-f-]{36}$/i);
  assert.notEqual(request.businessId, 'untrusted');
});

test('same confirmation state reuses the same server-generated idempotency key', async () => {
  const h = handlerHarness({
    stateEnabled: true,
    bookingResult: { success: true, replayed: true, smsSent: false },
  });
  const flow = await advanceBooking(h);
  const first = await h.run({ speech: 'yes', stateToken: flow.confirmToken, from: CALLER });
  const second = await h.run({ speech: 'yes', stateToken: flow.confirmToken, from: CALLER });
  assert.match(first, /original booking was already completed/);
  assert.match(second, /original booking was already completed/);
  assert.equal(h.bookings.length, 2);
  assert.equal(h.bookings[0].idempotencyKey, h.bookings[1].idempotencyKey);
});

test('booking failure is spoken as failure and never as confirmation', async () => {
  const h = handlerHarness({
    stateEnabled: true,
    bookingResult: { success: false, message: 'That time is no longer available. Please choose another time.' },
  });
  const flow = await advanceBooking(h);
  const xml = await h.run({ speech: 'yes', stateToken: flow.confirmToken, from: CALLER });
  assert.match(xml, /no longer available/);
  assert.doesNotMatch(xml, /booked successfully|confirmation text was submitted/);
});

test('SMS uncertainty does not undermine authoritative booking confirmation', async () => {
  const h = handlerHarness({
    stateEnabled: true,
    bookingResult: { success: true, replayed: false, smsSent: false },
  });
  const flow = await advanceBooking(h);
  const xml = await h.run({ speech: 'yes', stateToken: flow.confirmToken, from: CALLER });
  assert.match(xml, /booked successfully/);
  assert.match(xml, /couldn't verify the text confirmation status/);
});

test('invalid service, date and time reprompt without mutation', async () => {
  const h = handlerHarness({ stateEnabled: true });
  const started = await h.run({ digits: '1', from: CALLER });
  const name = await h.run({ speech: 'Alex Customer', stateToken: callbackState(started), from: CALLER });
  const badService = await h.run({ speech: 'Unknown service', stateToken: callbackState(name), from: CALLER });
  assert.match(badService, /couldn't match/);
  assert.equal(h.bookings.length, 0);

  const service = await h.run({ speech: 'Haircut', stateToken: callbackState(badService), from: CALLER });
  const badDate = await h.run({ speech: 'sometime next week', stateToken: callbackState(service), from: CALLER });
  assert.match(badDate, /couldn't verify that date/);
  assert.equal(h.bookings.length, 0);

  const date = await h.run({ speech: '2099-09-20', stateToken: callbackState(badDate), from: CALLER });
  const badTime = await h.run({ speech: 'whenever', stateToken: callbackState(date), from: CALLER });
  assert.match(badTime, /couldn't verify that time/);
  assert.equal(h.bookings.length, 0);
});

test('booking state is encrypted, contains stable idempotency and no caller phone', async () => {
  const h = handlerHarness({ stateEnabled: true });
  const xml = await h.run({ digits: '1', from: CALLER });
  const token = callbackState(xml);
  assert.ok(token);
  assert.ok(!token.includes(CALLER));
  assert.ok(!token.includes(BUSINESS_ID));
  assert.ok(!token.includes(CALL_SID));

  const decoded = h.state.openVoiceState(token, {
    businessId: BUSINESS_ID,
    callSid: CALL_SID,
    ingress: 'trial',
  });
  assert.equal(decoded.mode, 'booking');
  assert.equal(decoded.booking.stage, 'name');
  assert.match(decoded.booking.idempotencyKey, /^[0-9a-f-]{36}$/i);
  assert.equal(JSON.stringify(decoded).includes(CALLER), false);
});

test('encrypted state cannot cross business, call or ingress boundaries', () => {
  const h = handlerHarness({ stateEnabled: true });
  const binding = { businessId: BUSINESS_ID, callSid: CALL_SID, ingress: 'trial' };
  const token = h.state.sealVoiceState(h.state.initialVoiceState(), binding);
  for (const changed of [
    { businessId: '99999999-9999-4999-8999-999999999999' },
    { callSid: 'CA' + 'b'.repeat(32) },
    { ingress: 'production' },
  ]) {
    assert.throws(() => h.state.openVoiceState(token, { ...binding, ...changed }));
  }
});

test('tampered, expired, overlong and excess-turn state is rejected', () => {
  const h = handlerHarness({ stateEnabled: true });
  const binding = { businessId: BUSINESS_ID, callSid: CALL_SID, ingress: 'trial' };
  const state = h.state.initialVoiceState();
  const token = h.state.sealVoiceState(state, binding);

  for (const bad of [
    '',
    'not-valid',
    'x'.repeat(1801),
    token.slice(0, 20) + (token[20] === 'a' ? 'b' : 'a') + token.slice(21),
  ]) {
    assert.throws(() => h.state.openVoiceState(bad, binding));
  }

  assert.throws(() => h.state.openVoiceState(token, binding, state.expires));
  for (const patch of [
    { turns: 30 },
    { turns: -1 },
    { silence: 3 },
    { mode: 'booked' },
    { expires: Date.now() + 60 * 60_000 },
    { extra: 'unexpected' },
  ]) {
    assert.throws(() => h.state.openVoiceState(
      h.state.sealVoiceState({ ...state, ...patch }, binding),
      binding
    ));
  }
});

test('invalid callback state fails closed before model or booking', async () => {
  const h = handlerHarness({ stateEnabled: true });
  const xml = await h.run({ speech: 'Book', stateToken: 'invalid', from: CALLER });
  assert.match(xml, /conversation has expired/);
  assert.match(xml, /<Hangup/);
  assert.equal(h.requests.length, 0);
  assert.equal(h.bookings.length, 0);
});

test('unknown called number fails closed before context, model or booking', async () => {
  const h = handlerHarness({ missingBusiness: true, stateEnabled: true });
  const xml = await h.run({ speech: 'Book a haircut', from: CALLER });
  assert.match(xml, /<Hangup/);
  assert.equal(h.queries.length, 1);
  assert.equal(h.requests.length, 0);
  assert.equal(h.bookings.length, 0);
});

test('transfer, menu, goodbye and unsupported keypad remain controlled', async () => {
  const h = handlerHarness({ stateEnabled: true });
  assert.match(await h.run({ speech: 'Can I speak with someone?' }), /transferring to a team member isn't available/);
  assert.match(await h.run({ speech: 'Repeat the options.' }), /press 1 to book an appointment/);
  assert.match(await h.run({ digits: '9' }), /That option isn't available/);
  const goodbye = await h.run({ speech: 'No thank you' });
  assert.match(goodbye, /<Hangup/);
  assert.doesNotMatch(goodbye, /<Gather/);
  assert.equal(h.bookings.length, 0);
});

test('silence remains bounded in menu and booking flows', async () => {
  const h = handlerHarness({ stateEnabled: true });
  const menu = await h.run({ mode: '' });
  const silentMenu = await h.run({ stateToken: callbackState(menu) });
  const endedMenu = await h.run({ stateToken: callbackState(silentMenu) });
  assert.match(endedMenu, /<Hangup/);

  const booking = await h.run({ digits: '1', from: CALLER });
  const silentBooking = await h.run({ stateToken: callbackState(booking), from: CALLER });
  const endedBooking = await h.run({ stateToken: callbackState(silentBooking), from: CALLER });
  assert.match(endedBooking, /No appointment was booked/);
  assert.match(endedBooking, /<Hangup/);
});

test('business timezone still grounds informational today answers', async () => {
  const h = handlerHarness();
  await h.run({ speech: 'What time do you close today?' });
  const input = JSON.parse(h.requests[0].input);
  assert.equal(
    input.business_today_weekday,
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      weekday: 'long',
    }).format(new Date())
  );
});

function route(ingress, overrides = {}, throws = false) {
  let calls = 0;
  const logs = [];
  const r = load(
    `app/api/voice/${ingress === 'trial' ? 'trial/' : ''}route.ts`,
    {
      'node:crypto': { default: require('node:crypto') },
      'next/server': { NextResponse: Response },
      twilio: { default: twilio },
      '@/lib/voice-handler': {
        buildVoiceResponse: async ({ ingress: actual }) => {
          calls++;
          assert.equal(actual, ingress);
          if (throws) throw Error('PRIVATE');
          return '<Response/>';
        },
      },
    },
    logs,
    overrides
  );

  const post = (token, signature) => {
    const url = ingress === 'trial'
      ? `https://example.invalid/api/voice/trial?token=${token || ''}`
      : 'https://example.invalid/api/voice?mode=listen';

    return r.POST(new Request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(signature ? { 'x-twilio-signature': signature } : {}),
      },
      body: new URLSearchParams({ To: '+12025550100' }),
    }));
  };

  return { post, get calls() { return calls; }, logs };
}

test('trial token validation remains in front of privileged handler', async () => {
  const h = route('trial');
  assert.equal((await h.post()).status, 403);
  assert.equal((await h.post('wrong')).status, 403);
  assert.equal(h.calls, 0);
  assert.equal((await h.post(env.TWILIO_TRIAL_VOICE_TOKEN)).status, 200);
  assert.equal(h.calls, 1);

  const missing = route('trial', { TWILIO_TRIAL_VOICE_TOKEN: '' });
  assert.equal((await missing.post('anything')).status, 403);
  assert.equal(missing.calls, 0);
});

test('production Twilio signature validation remains in front of privileged handler', async () => {
  const h = route('production');
  assert.equal((await h.post()).status, 403);
  assert.equal((await h.post(null, 'bad')).status, 403);
  assert.equal(h.calls, 0);

  const signature = twilio.getExpectedTwilioSignature(
    env.TWILIO_AUTH_TOKEN,
    `${env.TWILIO_VOICE_WEBHOOK_URL}?mode=listen`,
    { To: '+12025550100' }
  );

  assert.equal((await h.post(null, signature)).status, 200);
  assert.equal(h.calls, 1);
});

test('route exception diagnostics never expose raw error', async () => {
  const h = route('trial', {}, true);
  const response = await h.post(env.TWILIO_TRIAL_VOICE_TOKEN);
  assert.match(await response.text(), /having trouble responding/);
  assert.ok(!JSON.stringify(h.logs).includes('PRIVATE'));
});

function bookingModuleHarness({
  rpcResult,
  rpcError = null,
  services = [{ id: SERVICE_ID, name: 'Haircut' }],
  smsResult = { success: true, messageSid: 'SM' + 'a'.repeat(32) },
  claim = {
    claimed: true,
    id: NOTIFICATION_ID,
    token: CLAIM_TOKEN,
    kind: 'confirmation',
    payload: { phone: CALLER, date: '2099-09-20', time: '10:00:00' },
  },
  finish = true,
} = {}) {
  const calls = [], sms = [], logs = [];

  const defaultResult = {
    success: true,
    changed: true,
    action_id: ACTION_ID,
    action_type: 'book',
    business_id: BUSINESS_ID,
    receipt_scope: 'action_outcome',
    replayed: false,
    completed_at: new Date().toISOString(),
    appointment_id: APPOINTMENT_ID,
    customer_id: CUSTOMER_ID,
    service_id: SERVICE_ID,
    service: 'Haircut',
    date: '2099-09-20',
    time: '10:00:00',
    status: 'Booked',
  };

  const db = {
    from(table) {
      assert.equal(table, 'services');
      const q = {};
      for (const method of ['select', 'eq', 'order', 'limit', 'abortSignal']) q[method] = () => q;
      q.then = resolve => Promise.resolve({ data: services, error: null }).then(resolve);
      return q;
    },
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (name === 'voice_book_appointment_business') {
        return { data: rpcResult === undefined ? defaultResult : rpcResult, error: rpcError };
      }
      if (name === 'voice_claim_appointment_notification') {
        return { data: claim, error: null };
      }
      if (name === 'voice_finish_appointment_notification') {
        return { data: finish, error: null };
      }
      throw Error(`Unexpected RPC ${name}`);
    },
  };

  const aiActions = load('lib/ai-actions.ts', {}, logs);
  const appointmentActions = { isUuid: value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) };
  const module = load(
    'lib/voice-booking.ts',
    {
      'node:crypto': require('node:crypto'),
      '@supabase/supabase-js': {},
      '@/lib/ai-actions': aiActions,
      '@/lib/appointment-actions': appointmentActions,
      '@/lib/supabase-server': { createSupabaseServiceClient: () => db },
      '@/lib/twilio': {
        sendSms: async input => {
          sms.push(input);
          return smsResult;
        },
      },
    },
    logs
  );

  const execute = (patch = {}) => module.executeVoiceBooking({
    businessId: BUSINESS_ID,
    idempotencyKey: '88888888-8888-4888-8888-888888888888',
    customerName: 'Alex Customer',
    customerPhone: CALLER,
    serviceId: SERVICE_ID,
    serviceName: 'Haircut',
    date: '2099-09-20',
    time: '10:00',
    ...patch,
  });

  return { module, execute, calls, sms, logs };
}

test('voice service matching tolerates speech-recognition spacing differences', async () => {
  const h = bookingModuleHarness();

  const match = await h.module.resolveVoiceService(
    BUSINESS_ID,
    'hair cut'
  );

  assert.ok(match);
  assert.equal(match.id, SERVICE_ID);
  assert.equal(match.name, 'Haircut');
});

test('voice service matching tolerates harmless case and punctuation differences', async () => {
  const h = bookingModuleHarness();

  for (const spoken of ['HAIR CUT', 'hair-cut', 'Hair, Cut']) {
    const match = await h.module.resolveVoiceService(
      BUSINESS_ID,
      spoken
    );

    assert.ok(match);
    assert.equal(match.id, SERVICE_ID);
    assert.equal(match.name, 'Haircut');
  }
});

test('voice service normalization rejects ambiguous matches', async () => {
  const secondServiceId =
    '99999999-9999-4999-8999-999999999999';

  const h = bookingModuleHarness({
    services: [
      { id: SERVICE_ID, name: 'Haircut' },
      { id: secondServiceId, name: 'Hair Cut' },
    ],
  });

  const match = await h.module.resolveVoiceService(
    BUSINESS_ID,
    'hair-cut'
  );

  assert.equal(match, null);
});

test('real voice booking module calls only voice booking and voice notification RPCs', async () => {
  const h = bookingModuleHarness();
  const result = await h.execute();
  assert.equal(result.success, true);
  assert.equal(result.smsSent, true);
  assert.deepEqual(h.calls.map(c => c.name), [
    'voice_book_appointment_business',
    'voice_claim_appointment_notification',
    'voice_finish_appointment_notification',
  ]);
  assert.equal(h.sms.length, 1);

  const book = h.calls[0].args;
  assert.equal(book.p_business_id, BUSINESS_ID);
  assert.equal(book.p_customer_phone, CALLER);
  assert.equal(book.p_service_id, SERVICE_ID);
  assert.equal(book.p_customer_email, null);
  assert.equal(book.p_notes, null);
  assert.match(book.p_request_fingerprint, /^[0-9a-f]{64}$/);
});

test('real voice booking module revalidates service id/name before mutation', async () => {
  const h = bookingModuleHarness();
  const result = await h.execute({ serviceName: 'Injected Service' });
  assert.equal(result.success, false);
  assert.match(result.message, /service is no longer available/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.sms.length, 0);
});

test('real voice booking module rejects malformed caller phone before RPC', async () => {
  const h = bookingModuleHarness();
  const result = await h.execute({ customerPhone: 'PRIVATE' });
  assert.equal(result.success, false);
  assert.equal(h.calls.length, 0);
  assert.equal(h.sms.length, 0);
});

test('unverified database success is never converted into spoken success', async () => {
  const h = bookingModuleHarness({
    rpcResult: {
      success: true,
      changed: true,
      action_id: ACTION_ID,
      action_type: 'book',
      business_id: BUSINESS_ID,
      receipt_scope: 'action_outcome',
      replayed: false,
      appointment_id: APPOINTMENT_ID,
      customer_id: CUSTOMER_ID,
      service_id: '99999999-9999-4999-8999-999999999999',
      service: 'Haircut',
      date: '2099-09-20',
      time: '10:00:00',
      status: 'Booked',
    },
  });
  const result = await h.execute();
  assert.equal(result.success, false);
  assert.match(result.message, /couldn't verify the booking/);
  assert.equal(h.sms.length, 0);
  assert.deepEqual(h.calls.map(c => c.name), ['voice_book_appointment_business']);
});

test('stable database rejection is returned without SMS attempt', async () => {
  const h = bookingModuleHarness({
    rpcResult: {
      success: false,
      changed: false,
      action_id: ACTION_ID,
      action_type: 'book',
      business_id: BUSINESS_ID,
      code: 'SLOT_CONFLICT',
      receipt_scope: 'action_outcome',
      replayed: false,
      completed_at: new Date().toISOString(),
    },
  });
  const result = await h.execute();
  assert.equal(result.success, false);
  assert.match(result.message, /time is no longer available/);
  assert.equal(h.sms.length, 0);
  assert.deepEqual(h.calls.map(c => c.name), ['voice_book_appointment_business']);
});

test('RPC error fails closed and does not attempt notification', async () => {
  const h = bookingModuleHarness({ rpcError: { message: 'PRIVATE' }, rpcResult: null });
  const result = await h.execute();
  assert.equal(result.success, false);
  assert.match(result.message, /couldn't verify the booking/);
  assert.equal(h.sms.length, 0);
  assert.ok(!JSON.stringify(h.logs).includes('PRIVATE'));
});

test('SMS accepted is finalized accepted with provider SID', async () => {
  const h = bookingModuleHarness();
  const result = await h.execute();
  assert.equal(result.success, true);
  const finish = h.calls.find(c => c.name === 'voice_finish_appointment_notification');
  assert.equal(finish.args.p_status, 'accepted');
  assert.equal(finish.args.p_provider_id, 'SM' + 'a'.repeat(32));
});

test('definite SMS failure is finalized failed while booking remains successful', async () => {
  const h = bookingModuleHarness({
    smsResult: { success: false, error: 'PRIVATE', outcome: 'failed' },
  });
  const result = await h.execute();
  assert.equal(result.success, true);
  assert.equal(result.smsSent, false);
  const finish = h.calls.find(c => c.name === 'voice_finish_appointment_notification');
  assert.equal(finish.args.p_status, 'failed');
  assert.equal(finish.args.p_provider_id, null);
});

test('uncertain SMS outcome is finalized uncertain while booking remains successful', async () => {
  const h = bookingModuleHarness({
    smsResult: { success: false, error: 'PRIVATE', outcome: 'uncertain' },
  });
  const result = await h.execute();
  assert.equal(result.success, true);
  assert.equal(result.smsSent, false);
  const finish = h.calls.find(c => c.name === 'voice_finish_appointment_notification');
  assert.equal(finish.args.p_status, 'uncertain');
});

test('notification cannot send unless machine claim returns a valid claim', async () => {
  const h = bookingModuleHarness({ claim: { claimed: false } });
  const result = await h.execute();
  assert.equal(result.success, true);
  assert.equal(result.smsSent, false);
  assert.equal(h.sms.length, 0);
  assert.deepEqual(h.calls.map(c => c.name), [
    'voice_book_appointment_business',
    'voice_claim_appointment_notification',
  ]);
});
