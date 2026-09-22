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
        info: (...args) => logs.push(args),
      },
    }
  );
  return exports;
}

const parsing = load('lib/voice-parsing.ts', { './ai-actions': load('lib/ai-actions.ts', {}) });
const slots = load('lib/voice-slots.ts', { '@/lib/voice-parsing': parsing });
const voiceConfig = load('lib/voice-config.ts', {});
const voiceInput = load('lib/voice-input.ts', {});

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
  bookingExecutor,
  availabilityResult = { available: true },
  availabilityExecutor,
  services = [{ id: SERVICE_ID, name: 'Haircut' }],
  understandingResult = { kind: 'unclear' },
  handoffSettings = null,
} = {}) {
  const queries = [], requests = [], logs = [], bookings = [], availabilityChecks = [], serviceLoads = [], serviceResolutions = [], understandings = [];

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
          voice_handoff_settings: handoffSettings,
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
    checkVoiceAvailability: async request => {
      availabilityChecks.push(request);
      return availabilityExecutor
        ? availabilityExecutor(request)
        : availabilityResult;
    },
    resolveVoiceService: async (businessId, spoken) => {
      serviceResolutions.push({ businessId, spoken });
      const normalized = spoken.trim().toLowerCase();
      const matches = services.filter(s => s.name.toLowerCase() === normalized || s.name.toLowerCase().includes(normalized));
      return matches.length === 1 ? matches[0] : null;
    },
    executeVoiceBooking: async request => {
      bookings.push(request);
      return bookingExecutor ? bookingExecutor(request) : bookingResult;
    },
  };

  const handler = load(
    'lib/voice-handler.ts',
    {
      twilio: { default: twilio },
      '@/lib/supabase-server': { createSupabaseServiceClient: () => db },
      '@/lib/voice-receptionist': receptionist,
      '@/lib/voice-state': state,
      '@/lib/voice-input': voiceInput,
      '@/lib/voice-appointment-management': load('lib/voice-appointment-management.ts', {
        'node:crypto': require('node:crypto'),
        '@/lib/supabase-server': { createSupabaseServiceClient: () => db },
        '@/lib/voice-state': state,
        '@/lib/voice-input': voiceInput, '@/lib/voice-slots': slots, '@/lib/voice-parsing': parsing,
      }, logs),
      '@/lib/voice-booking': booking,
      '@/lib/voice-parsing': parsing,
      '@/lib/voice-slots': slots,
      '@/lib/voice-config': voiceConfig,
      '@/lib/voice-understanding': {
        understandVoiceTurn: async request => {
          understandings.push(request);
          return typeof understandingResult === 'function'
            ? understandingResult(request)
            : understandingResult;
        },
      },
    },
    logs,
    stateEnv
  );

  const run = async ({
    speech = '',
    mode,
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
    return handler.buildVoiceResponse({ formData, mode: mode ?? (stateToken ? "listen" : ""), ingress, stateToken });
  };

  return {
    ...receptionist, state, run, queries, requests, logs,
    bookings, availabilityChecks, serviceLoads, serviceResolutions, understandings,
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
  assert.match(flow.name, /We offer Haircut/);
  assert.match(flow.service, /What day would you like for Haircut/);
  assert.match(flow.dated, /What time would you like/);
  assert.match(flow.timed, /Say yes or press 1 to book it/);
  assert.equal(h.bookings.length, 0);
  assert.ok(h.serviceLoads.length >= 2);
  assert.ok(h.serviceLoads.every(id => id === BUSINESS_ID));
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
    /couldn't work out that day/
  );

  assert.equal(h.bookings.length, 0);
});


test('availability is checked before confirmation and does not mutate', async () => {
  const h = handlerHarness({ stateEnabled: true });
  const flow = await advanceBooking(h);

  assert.match(flow.timed, /Say yes or press 1 to book it/);
  assert.equal(h.availabilityChecks.length, 1);
  assert.equal(h.availabilityChecks[0].businessId, BUSINESS_ID);
  assert.equal(h.availabilityChecks[0].serviceId, SERVICE_ID);
  assert.equal(h.availabilityChecks[0].date, '2099-09-20');
  assert.equal(h.availabilityChecks[0].time, '10:00');
  assert.equal(h.bookings.length, 0);
});

test('unavailable slot never reaches confirmation and never mutates', async () => {
  const h = handlerHarness({
    stateEnabled: true,
    availabilityResult: {
      available: false,
      reason: 'slot_unavailable',
    },
  });

  const flow = await advanceBooking(h);

  assert.match(flow.timed, /isn't available for/);
  assert.doesNotMatch(flow.timed, /Say yes or press 1 to book it/);
  assert.equal(h.availabilityChecks.length, 1);
  assert.equal(h.bookings.length, 0);

  const binding = {
    businessId: BUSINESS_ID,
    callSid: CALL_SID,
    ingress: 'trial',
  };

  const state = h.state.openVoiceState(
    callbackState(flow.timed),
    binding
  );

  assert.equal(state.booking.stage, 'time');
  assert.equal(state.booking.time, null);
});

test('outside-hours slot remains in time selection without mutation', async () => {
  const h = handlerHarness({
    stateEnabled: true,
    availabilityResult: {
      available: false,
      reason: 'outside_hours',
    },
  });

  const flow = await advanceBooking(h);

  assert.match(flow.timed, /outside our hours/);
  assert.doesNotMatch(flow.timed, /Say yes or press 1 to book it/);
  assert.equal(h.bookings.length, 0);

  const state = h.state.openVoiceState(
    callbackState(flow.timed),
    {
      businessId: BUSINESS_ID,
      callSid: CALL_SID,
      ingress: 'trial',
    }
  );

  assert.equal(state.booking.stage, 'time');
  assert.equal(state.booking.time, null);
});

test('closed date returns to date selection without mutation', async () => {
  const h = handlerHarness({
    stateEnabled: true,
    availabilityResult: {
      available: false,
      reason: 'closed',
    },
  });

  const flow = await advanceBooking(h);

  assert.match(flow.timed, /We're closed that day/);
  assert.doesNotMatch(flow.timed, /Say yes or press 1 to book it/);
  assert.equal(h.bookings.length, 0);

  const state = h.state.openVoiceState(
    callbackState(flow.timed),
    {
      businessId: BUSINESS_ID,
      callSid: CALL_SID,
      ingress: 'trial',
    }
  );

  assert.equal(state.booking.stage, 'date');
  assert.equal(state.booking.date, null);
  assert.equal(state.booking.time, null);
});

test('unverified availability fails closed without confirmation or mutation', async () => {
  const h = handlerHarness({
    stateEnabled: true,
    availabilityResult: {
      available: false,
      reason: 'unverified',
    },
  });

  const flow = await advanceBooking(h);

  assert.match(flow.timed, /couldn't check availability/);
  assert.match(flow.timed, /No appointment was booked/);
  assert.match(flow.timed, /<Hangup/);
  assert.doesNotMatch(flow.timed, /Say yes or press 1 to book it/);
  assert.equal(callbackState(flow.timed), null);
  assert.equal(h.bookings.length, 0);
});

test('authoritative booking can still reject a race after successful availability precheck', async () => {
  const h = handlerHarness({
    stateEnabled: true,
    availabilityResult: { available: true },
    bookingResult: {
      success: false,
      message: 'That time is no longer available. Please choose another time.',
    },
  });

  const flow = await advanceBooking(h);

  assert.equal(h.availabilityChecks.length, 1);
  assert.equal(h.bookings.length, 0);
  assert.match(flow.timed, /Say yes or press 1 to book it/);

  const xml = await h.run({
    speech: 'yes',
    stateToken: flow.confirmToken,
    from: CALLER,
  });

  assert.match(xml, /no longer available/);
  assert.doesNotMatch(
    xml,
    /booked successfully|confirmation text was submitted/
  );
  assert.equal(h.bookings.length, 1);
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
  assert.match(xml, /appointment has been booked/);
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
  assert.match(xml, /appointment has been booked/);
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
  assert.match(badDate, /couldn't work out that day/);
  assert.equal(h.bookings.length, 0);

  const date = await h.run({ speech: '2099-09-20', stateToken: callbackState(badDate), from: CALLER });
  const badTime = await h.run({ speech: 'whenever', stateToken: callbackState(date), from: CALLER });
  assert.match(badTime, /couldn't interpret that time/);
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

test('configured human request dials only the private server-side destination', async () => {
  const destination = '+14085550123';
  const h = handlerHarness({
    stateEnabled: true,
    handoffSettings: {
      human_transfer_phone: destination,
      is_enabled: true,
    },
  });

  const xml = await h.run({
    speech: 'Please connect me to someone at the salon.',
    from: CALLER,
  });

  assert.match(xml, /connect you with someone at the salon/);
  assert.match(xml, /<Dial/);
  assert.match(xml, /<Number>\+14085550123<\/Number>/);
  assert.doesNotMatch(xml, /<Gather/);
  assert.equal(h.bookings.length, 0);

  const handoffQuery = h.queries.find(
    query => query.table === 'voice_handoff_settings'
  );

  assert.ok(handoffQuery);
  assert.ok(
    handoffQuery.filters.some(
      filter =>
        filter[0] === 'eq' &&
        filter[1] === 'business_id' &&
        filter[2] === BUSINESS_ID
    )
  );
});

test('menu digit 3 uses the configured private human destination', async () => {
  const h = handlerHarness({
    stateEnabled: true,
    handoffSettings: {
      human_transfer_phone: '+14085550123',
      is_enabled: true,
    },
  });

  const xml = await h.run({
    digits: '3',
    from: CALLER,
  });

  assert.match(xml, /<Dial/);
  assert.match(xml, /<Number>\+14085550123<\/Number>/);
  assert.doesNotMatch(xml, /<Gather/);
  assert.equal(h.bookings.length, 0);
});

test('configured human request during confirmation transfers without booking', async () => {
  const h = handlerHarness({
    stateEnabled: true,
    handoffSettings: {
      human_transfer_phone: '+14085550123',
      is_enabled: true,
    },
  });

  const flow = await advanceBooking(h);

  assert.equal(h.bookings.length, 0);

  const xml = await h.run({
    speech: 'I want a real person.',
    stateToken: flow.confirmToken,
    from: CALLER,
  });

  assert.match(xml, /<Dial/);
  assert.doesNotMatch(xml, /appointment has been booked/);
  assert.doesNotMatch(xml, /<Gather/);
  assert.equal(h.bookings.length, 0);
});

test('disabled invalid and missing human destinations fail closed', async () => {
  const cases = [
    null,
    {
      human_transfer_phone: '+14085550123',
      is_enabled: false,
    },
    {
      human_transfer_phone: '408-555-0123',
      is_enabled: true,
    },
  ];

  for (const handoffSettings of cases) {
    const h = handlerHarness({
      stateEnabled: true,
      handoffSettings,
    });

    const xml = await h.run({
      speech: 'representative',
      from: CALLER,
    });

    assert.doesNotMatch(xml, /<Dial/);
    assert.match(
      xml,
      /transferring to a team member isn't available/
    );
    assert.match(xml, /<Gather/);
    assert.equal(h.bookings.length, 0);
  }
});

test('human destination equal to inbound AnaAI number is rejected to prevent transfer loops', async () => {
  const h = handlerHarness({
    stateEnabled: true,
    handoffSettings: {
      human_transfer_phone: '+12025550100',
      is_enabled: true,
    },
  });

  const xml = await h.run({
    speech: 'agent',
    from: CALLER,
  });

  assert.doesNotMatch(xml, /<Dial/);
  assert.match(
    xml,
    /transferring to a team member isn't available/
  );
  assert.match(xml, /<Gather/);
  assert.equal(h.bookings.length, 0);
});

test('caller supplied phone number cannot override configured human destination', async () => {
  const h = handlerHarness({
    stateEnabled: true,
    handoffSettings: {
      human_transfer_phone: '+14085550123',
      is_enabled: true,
    },
  });

  const xml = await h.run({
    speech: 'Connect me to a human at 650-555-9999.',
    from: CALLER,
  });

  assert.match(xml, /<Number>\+14085550123<\/Number>/);
  assert.doesNotMatch(xml, /6505559999/);
  assert.doesNotMatch(xml, /\+16505559999/);
  assert.equal(h.bookings.length, 0);
});

test('explicit human requests are controlled across natural phrase variants', async () => {
  const phrases = [
    'representative',
    'agent',
    'human',
    'Can I speak with a real person?',
    'I need a team member',
    'Can I talk to a store employee?',
    'Please connect me to someone at the salon.',
    'Can you connect me with someone?',
    'I want to speak to someone at the store.',
  ];

  for (const speech of phrases) {
    const h = handlerHarness({ stateEnabled: true });
    const xml = await h.run({ speech });

    assert.match(
      xml,
      /transferring to a team member isn't available/
    );
    assert.match(xml, /<Gather/);
    assert.equal(h.bookings.length, 0);
  }
});

test('explicit human request during booking cannot submit the in-progress appointment', async () => {
  const h = handlerHarness({ stateEnabled: true });
  const flow = await advanceBooking(h);

  assert.equal(h.bookings.length, 0);

  const xml = await h.run({
    speech: 'Can I speak with a real person?',
    stateToken: flow.confirmToken,
    from: CALLER,
  });

  assert.match(
    xml,
    /transferring to a team member isn't available/
  );
  assert.match(xml, /<Gather/);
  assert.doesNotMatch(xml, /appointment has been booked/);
  assert.equal(h.bookings.length, 0);
});

test('explicit human request during service collection does not mutate booking state', async () => {
  const h = handlerHarness({
    stateEnabled: true,
    services: productionServices,
  });

  let xml = await h.run({
    digits: '1',
    from: CALLER,
  });

  xml = await h.run({
    speech: 'Randy',
    stateToken: callbackState(xml),
    from: CALLER,
  });

  const beforeToken =
    callbackState(xml);

  const before =
    h.state.openVoiceState(
      beforeToken,
      {
        businessId: BUSINESS_ID,
        callSid: CALL_SID,
        ingress: 'trial',
      }
    );

  xml = await h.run({
    speech: 'Please connect me to someone at the salon.',
    stateToken: beforeToken,
    from: CALLER,
  });

  assert.match(
    xml,
    /transferring to a team member isn't available/
  );
  assert.equal(h.bookings.length, 0);

  const after =
    h.state.openVoiceState(
      callbackState(xml),
      {
        businessId: BUSINESS_ID,
        callSid: CALL_SID,
        ingress: 'trial',
      }
    );

  assert.equal(after.booking.stage, before.booking.stage);
  assert.equal(after.booking.customerName, before.booking.customerName);
  assert.equal(after.booking.serviceId, null);
  assert.equal(after.booking.failures, before.booking.failures);
});

test('third genuine booking failure escalates without mutation', async () => {
  const h = handlerHarness({
    stateEnabled: true,
    services: productionServices,
  });

  let xml = await h.run({
    digits: '1',
    from: CALLER,
  });

  xml = await h.run({
    speech: 'Randy',
    stateToken: callbackState(xml),
    from: CALLER,
  });

  for (let attempt = 1; attempt <= 2; attempt++) {
    xml = await h.run({
      speech: 'unmatched service',
      stateToken: callbackState(xml),
      from: CALLER,
    });

    assert.match(xml, /<Gather/);
    assert.doesNotMatch(
      xml,
      /call the salon directly/
    );
    assert.equal(h.bookings.length, 0);
  }

  xml = await h.run({
    speech: 'unmatched service',
    stateToken: callbackState(xml),
    from: CALLER,
  });

  assert.match(
    xml,
    /I'm having trouble understanding/
  );
  assert.match(
    xml,
    /call the salon directly/
  );
  assert.match(xml, /No appointment was booked/);
  assert.match(xml, /<Hangup/);
  assert.doesNotMatch(xml, /<Gather/);
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
      '@/lib/voice-config': voiceConfig,
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

  return { post, postRequest: r.POST, get calls() { return calls; }, logs };
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
  availabilityResult,
  availabilityError = null,
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
      if (name === 'voice_check_appointment_availability') {
        const defaultAvailability = {
          available: true,
          code: 'AVAILABLE',
          service_id: SERVICE_ID,
          service: 'Haircut',
          date: '2099-09-20',
          time: '10:00:00',
          duration_minutes: 30,
        };
        return {
          data: availabilityResult === undefined
            ? defaultAvailability
            : availabilityResult,
          error: availabilityError,
        };
      }
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
      '@/lib/voice-parsing': parsing,
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

test('real voice availability module uses only the read-only availability RPC', async () => {
  const h = bookingModuleHarness();

  const result = await h.module.checkVoiceAvailability({
    businessId: BUSINESS_ID,
    serviceId: SERVICE_ID,
    date: '2099-09-20',
    time: '10:00',
  });

  assert.equal(result.available, true);
  assert.deepEqual(h.calls.map(call => call.name), [
    'voice_check_appointment_availability',
  ]);
  assert.equal(h.sms.length, 0);

  const check = h.calls[0].args;
  assert.equal(check.p_business_id, BUSINESS_ID);
  assert.equal(check.p_service_id, SERVICE_ID);
  assert.equal(check.p_appointment_date, '2099-09-20');
  assert.equal(check.p_appointment_time, '10:00');
});

test('real voice availability module maps slot conflict without mutation or SMS', async () => {
  const h = bookingModuleHarness({
    availabilityResult: {
      available: false,
      code: 'SLOT_CONFLICT',
      service_id: SERVICE_ID,
      service: 'Haircut',
      date: '2099-09-20',
      time: '10:00:00',
      duration_minutes: 30,
    },
  });

  const result = await h.module.checkVoiceAvailability({
    businessId: BUSINESS_ID,
    serviceId: SERVICE_ID,
    date: '2099-09-20',
    time: '10:00',
  });

  assert.equal(result.available, false);
  assert.equal(result.reason, 'slot_unavailable');

  assert.deepEqual(h.calls.map(call => call.name), [
    'voice_check_appointment_availability',
  ]);

  assert.equal(
    h.calls.some(
      call => call.name === 'voice_book_appointment_business'
    ),
    false
  );

  assert.equal(h.sms.length, 0);
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

for (const speech of ['yeah', 'correct', 'sounds good', 'book it', 'please book it']) test(`full flow requires and accepts explicit ${speech}`, async () => {
  const h = handlerHarness({stateEnabled:true});
  const flow = await advanceBooking(h, {time:'one p.m.'});
  assert.equal(h.bookings.length,0);
  assert.match(flow.timed,/1 PM/);
  await h.run({speech,stateToken:flow.confirmToken,from:CALLER});
  assert.equal(h.bookings.length,1);
  assert.equal(h.bookings[0].time,'13:00');
  assert.equal(h.requests.length,0);
});
for (const speech of ['no', 'cancel', "that's wrong", "don't book it", 'start over']) test(`full flow negative ${speech} never mutates`, async () => {
  const h=handlerHarness({stateEnabled:true}); const flow=await advanceBooking(h);
  const xml=await h.run({speech,stateToken:flow.confirmToken,from:CALLER});
  assert.match(xml, /<Hangup/); assert.equal(h.bookings.length,0);
});
test('ambiguous confirmation exhausts bounded retries without booking', async () => {
  const h=handlerHarness({stateEnabled:true}); const flow=await advanceBooking(h);
  let token=flow.confirmToken, xml;
  for (let n=0;n<3;n++) {
    xml=await h.run({speech:'maybe',stateToken:token,from:CALLER});
    if(n<2) {token=callbackState(xml); assert.ok(token);}
  }
  assert.match(xml,/<Hangup/); assert.equal(h.bookings.length,0);
});
test('ambiguous time clarification preserves stage and canonicalizes full answer', async () => {
  const h=handlerHarness({stateEnabled:true}); const flow=await advanceBooking(h,{time:'two thirty'});
  assert.match(flow.timed,/2:30 AM or 2:30 PM/); assert.equal(h.bookings.length,0);
  const clarified=await h.run({speech:'two thirty PM',stateToken:flow.confirmToken,from:CALLER});
  assert.match(clarified,/Say yes or press 1 to book it/); assert.match(clarified,/2:30 PM/);
  assert.equal(h.bookings.length,0);
});
test('confirmation time correction preserves ambiguous time until bare PM resolves it', async () => {
  const h=handlerHarness({
    stateEnabled:true,
    // Supply the semantic correction only for the correction utterance, not
    // for every name/service/date answer during fixture setup.
    understandingResult:({speech}) => speech.includes("3:30") ? {
      kind:'unclear',
      meaningful:true,
      serviceName:null,
      dateExpression:null,
      timeExpression:'3:30',
      confirmation:null,
      correction:true,
    } : {kind:'unclear'},
  });
  const flow=await advanceBooking(h,{time:'2:30 PM'});
  const binding={businessId:BUSINESS_ID,callSid:CALL_SID,ingress:'trial'};

  const ambiguous=await h.run({
    speech:'Can you make it 3:30?',
    stateToken:flow.confirmToken,
    from:CALLER,
  });

  assert.match(ambiguous,/3:30 AM or 3:30 PM/);
  assert.equal(h.bookings.length,0);

  const pendingToken=callbackState(ambiguous);
  const pending=h.state.openVoiceState(pendingToken,binding);

  assert.equal(
    JSON.stringify(
      pending.booking.pendingTimeOptions
    ),
    JSON.stringify(
      ['03:30','15:30']
    )
  );
  // The active question is now the time, so the stage reflects that. The
  // pending AM/PM options are honoured at any stage, not only at confirmation.
  assert.equal(pending.booking.stage,'time');

  const clarified=await h.run({
    speech:'p.m.',
    stateToken:pendingToken,
    from:CALLER,
  });

  assert.match(clarified,/3:30 PM/);
  assert.match(clarified,/Say yes or press 1 to book it/);
  assert.equal(h.bookings.length,0);

  const clarifiedState=h.state.openVoiceState(
    callbackState(clarified),
    binding
  );

  assert.equal(
    clarifiedState.booking.pendingTimeOptions,
    undefined
  );
  assert.equal(clarifiedState.booking.time,'15:30');

  await h.run({
    speech:'yes',
    stateToken:callbackState(clarified),
    from:CALLER,
  });

  assert.equal(h.bookings.length,1);
  assert.equal(h.bookings[0].time,'15:30');
});

test('affirmative cannot book old appointment while AM PM correction is unresolved', async () => {
  const h=handlerHarness({
    stateEnabled:true,
    // Supply the semantic correction only for the correction utterance, not
    // for every name/service/date answer during fixture setup.
    understandingResult:({speech}) => speech.includes("3:30") ? {
      kind:'unclear',
      meaningful:true,
      serviceName:null,
      dateExpression:null,
      timeExpression:'3:30',
      confirmation:null,
      correction:true,
    } : {kind:'unclear'},
  });
  const flow=await advanceBooking(h,{time:'2:30 PM'});

  const ambiguous=await h.run({
    speech:'Can you make it 3:30?',
    stateToken:flow.confirmToken,
    from:CALLER,
  });

  const xml=await h.run({
    speech:'yes',
    stateToken:callbackState(ambiguous),
    from:CALLER,
  });

  assert.match(xml,/Say AM or PM/);
  assert.equal(h.bookings.length,0);
});

test('bare PM without pending ambiguity cannot change or book confirmed appointment', async () => {
  const h=handlerHarness({stateEnabled:true});
  const flow=await advanceBooking(h,{time:'2:30 PM'});

  const xml=await h.run({
    speech:'p.m.',
    stateToken:flow.confirmToken,
    from:CALLER,
  });

  assert.equal(h.bookings.length,0);
  assert.doesNotMatch(xml,/I have Haircut.*3:30 PM/);
});

test('semantic replacement time is revalidated as a correction even when correction flag is false', async () => {
  const h=handlerHarness({
    stateEnabled:true,
    understandingResult:{
      kind:'unclear',
      meaningful:true,
      serviceName:null,
      dateExpression:null,
      timeExpression:'4 in the afternoon',
      confirmation:'yes',
      correction:false,
    },
  });
  const flow=await advanceBooking(h,{time:'2:30 PM'});
  const binding={businessId:BUSINESS_ID,callSid:CALL_SID,ingress:'trial'};

  const xml=await h.run({
    speech:'Book for me for 4 in the afternoon.',
    stateToken:flow.confirmToken,
    from:CALLER,
  });

  assert.equal(h.bookings.length,0);
  assert.doesNotMatch(xml,/appointment has been booked/);
  assert.match(xml,/4 PM/);
  assert.match(xml,/Say yes or press 1 to book it/);

  const corrected=h.state.openVoiceState(
    callbackState(xml),
    binding
  );

  assert.equal(corrected.booking.time,'16:00');

  await h.run({
    speech:'yes',
    stateToken:callbackState(xml),
    from:CALLER,
  });

  assert.equal(h.bookings.length,1);
  assert.equal(h.bookings[0].time,'16:00');
});

test('semantic replacement date is revalidated as a correction and keeps the time', async () => {
  const h=handlerHarness({
    stateEnabled:true,
    understandingResult:{
      kind:'unclear',
      meaningful:true,
      customerName:null,
      serviceName:null,
      dateExpression:'October 5th 2099',
      timeExpression:null,
      confirmation:'yes',
      correction:false,
    },
  });
  const flow=await advanceBooking(h,{date:'2099-09-20',time:'2:30 PM'});
  const binding={businessId:BUSINESS_ID,callSid:CALL_SID,ingress:'trial'};

  const xml=await h.run({
    speech:'Yes, book it for October 5th 2099.',
    stateToken:flow.confirmToken,
    from:CALLER,
  });

  // Booking language alongside a replacement detail is a correction, never
  // authorization: the old appointment must not be booked.
  assert.equal(h.bookings.length,0);
  assert.doesNotMatch(xml,/appointment has been booked/);

  const corrected=h.state.openVoiceState(
    callbackState(xml),
    binding
  );

  // The date changed; the unrelated service and time survive the correction
  // and availability is recomputed for the new combination.
  assert.equal(corrected.booking.date,'2099-10-05');
  assert.equal(corrected.booking.serviceName,'Haircut');
  assert.equal(corrected.booking.requestedTime,'14:30');
  assert.equal(corrected.booking.stage,'confirm');
  assert.equal(h.availabilityChecks.at(-1).date,'2099-10-05');
  assert.equal(h.availabilityChecks.at(-1).time,'14:30');
  assert.match(xml,/Say yes or press 1 to book it/);
});

test('semantic replacement service is revalidated as a correction and keeps date and time', async () => {
  const h=handlerHarness({
    stateEnabled:true,
    services:[
      {id:SERVICE_ID,name:'Haircut'},
      {id:CUSTOMER_ID,name:'Facial'},
    ],
    understandingResult:{
      kind:'unclear',
      meaningful:true,
      customerName:null,
      serviceName:'Facial',
      dateExpression:null,
      timeExpression:null,
      confirmation:'yes',
      correction:false,
    },
  });
  const flow=await advanceBooking(h,{date:'2099-09-20',time:'2:30 PM'});
  const binding={businessId:BUSINESS_ID,callSid:CALL_SID,ingress:'trial'};

  const xml=await h.run({
    speech:'Yes, make it a facial.',
    stateToken:flow.confirmToken,
    from:CALLER,
  });

  assert.equal(h.bookings.length,0);
  assert.doesNotMatch(xml,/appointment has been booked/);

  const corrected=h.state.openVoiceState(
    callbackState(xml),
    binding
  );

  // Changing the service changes the duration, so availability is recomputed,
  // but the day and time the caller already chose are not thrown away.
  assert.equal(corrected.booking.serviceId,CUSTOMER_ID);
  assert.equal(corrected.booking.serviceName,'Facial');
  assert.equal(corrected.booking.date,'2099-09-20');
  assert.equal(corrected.booking.requestedTime,'14:30');
  assert.equal(corrected.booking.stage,'confirm');
  assert.equal(h.availabilityChecks.at(-1).serviceId,CUSTOMER_ID);
  assert.equal(h.availabilityChecks.at(-1).time,'14:30');
});

test('pending time state accepts canonical pair and rejects malformed values', () => {
  const h=handlerHarness({stateEnabled:true});
  const binding={businessId:BUSINESS_ID,callSid:CALL_SID,ingress:'trial'};

  const valid=h.state.initialBookingState();
  valid.booking.pendingTimeOptions=['03:30','15:30'];

  const opened=h.state.openVoiceState(
    h.state.sealVoiceState(valid,binding),
    binding
  );

  assert.equal(
    JSON.stringify(
      opened.booking.pendingTimeOptions
    ),
    JSON.stringify(
      ['03:30','15:30']
    )
  );

  for (const pendingTimeOptions of [
    ['99:99','15:30'],
    ['03:60','15:30'],
    ['03:30','03:30'],
    ['3:30','15:30'],
    ['03:30'],
    '03:30',
  ]) {
    const state=h.state.initialBookingState();
    state.booking.pendingTimeOptions=pendingTimeOptions;

    assert.throws(() =>
      h.state.openVoiceState(
        h.state.sealVoiceState(state,binding),
        binding
      )
    );
  }

  const legacy=h.state.initialBookingState();

  assert.equal(
    h.state.openVoiceState(
      h.state.sealVoiceState(legacy,binding),
      binding
    ).booking.pendingTimeOptions,
    undefined
  );
});

test('ambiguous services prompt only the routed service list with no selection', async () => {
  const h=handlerHarness({stateEnabled:true,services:[{id:SERVICE_ID,name:'Haircut basic'},{id:CUSTOMER_ID,name:'Haircut premium'}]});
  const started=await h.run({digits:'1',from:CALLER});
  const named=await h.run({speech:'Alex Customer',stateToken:callbackState(started),from:CALLER});
  const xml=await h.run({speech:'a haircut please',stateToken:callbackState(named),from:CALLER});
  assert.match(xml,/Did you want Haircut basic or Haircut premium/);
  // Routed service names lead the hint list, followed by shared scheduling
  // vocabulary. No service from another business may appear.
  assert.match(xml,/hints="Haircut basic,Haircut premium,/);
  assert.ok(h.serviceLoads.every(id=>id===BUSINESS_ID)); assert.equal(h.bookings.length,0);
});
test('past dates reprompt and silence never books', async () => {
  const h=handlerHarness({stateEnabled:true}); const flow=await advanceBooking(h,{date:'2000-01-01',time:''});
  assert.match(flow.dated,/already passed/);
  const xml=await h.run({speech:'',stateToken:callbackState(flow.timed),from:CALLER});
  assert.match(xml,/<Hangup/); assert.equal(h.bookings.length,0);
});
test('total turn limit is enforced before final affirmative execution', async () => {
  const h=handlerHarness({stateEnabled:true}); const flow=await advanceBooking(h);
  const binding={businessId:BUSINESS_ID,callSid:CALL_SID,ingress:'trial'};
  const state=h.state.openVoiceState(flow.confirmToken,binding); state.turns=29;
  const xml=await h.run({speech:'yes',stateToken:h.state.sealVoiceState(state,binding),from:CALLER});
  assert.match(xml,/<Hangup/); assert.equal(h.bookings.length,0);
});
test('retry counter validates bounds and legacy state without counter still opens', () => {
  const h=handlerHarness({stateEnabled:true});
  const binding={businessId:BUSINESS_ID,callSid:CALL_SID,ingress:'trial'};
  const state=h.state.initialBookingState();
  assert.equal(h.state.openVoiceState(h.state.sealVoiceState(state,binding),binding).booking.failures,undefined);
  for (const failures of [-1,3,1.5,'1']) {
    state.booking.failures=failures;
    assert.throws(()=>h.state.openVoiceState(h.state.sealVoiceState(state,binding),binding));
  }
});

const productionServices = [
  { id: SERVICE_ID, name: 'facial' },
  { id: CUSTOMER_ID, name: 'haircut' },
  { id: APPOINTMENT_ID, name: 'waxing' },
];

for (const ingress of ['production', 'trial']) {
  for (const invalidAttempts of [0, 1, 2]) {
    test(`${ingress}: Randy -> ${invalidAttempts} invalid services -> Facial advances through encrypted callbacks`, async () => {
      const h = handlerHarness({ stateEnabled: true, services: productionServices });
      const binding = { businessId: BUSINESS_ID, callSid: CALL_SID, ingress };
      let xml = await h.run({ digits: '1', ingress, from: CALLER });
      const initial = h.state.openVoiceState(callbackState(xml), binding);
      const key = initial.booking.idempotencyKey;
      xml = await h.run({ speech: 'Randy', stateToken: callbackState(xml), ingress, from: CALLER });
      assert.match(xml, /facial, haircut, waxing/);
      for (let n = 1; n <= invalidAttempts; n++) {
        const previous = callbackState(xml);
        xml = await h.run({ speech: 'unmatched service', stateToken: previous, ingress, from: CALLER });
        assert.match(xml, /couldn't match that to a service.*facial, haircut, waxing/);
        assert.notEqual(callbackState(xml), previous);
        const state = h.state.openVoiceState(callbackState(xml), binding);
        assert.equal(state.booking.stage, 'service');
        assert.equal(state.booking.failures, n);
        assert.equal(state.turns, 2 + n);
        assert.equal(state.booking.serviceId, null);
        assert.equal(state.booking.idempotencyKey, key);
        assert.equal(state.expires, initial.expires);
        assert.equal(JSON.stringify(state).includes(CALLER), false);
        const action = new URL(/action="([^"]+)"/.exec(xml)[1].replaceAll('&amp;', '&'));
        assert.equal(action.pathname, ingress === 'trial' ? '/api/voice/trial' : '/api/voice');
        assert.equal(action.searchParams.get('token'), ingress === 'trial' ? env.TWILIO_TRIAL_VOICE_TOKEN : null);
        assert.equal(action.searchParams.get('mode'), 'listen');
        assert.match(xml, /hints="facial,haircut,waxing,/);
        assert.match(xml, /speechModel="experimental_conversations"/);
        assert.match(xml, /speechTimeout="2"/);
        assert.match(xml, /actionOnEmptyResult="true"/);
        assert.match(xml, /method="POST"/);
        assert.equal(h.bookings.length, 0);
      }
      xml = await h.run({ speech: invalidAttempts ? 'Facial' : 'I would like a facial, please.', stateToken: callbackState(xml), ingress, from: CALLER });
      assert.match(xml, /What day would you like/);
      assert.doesNotMatch(xml, /No appointment was booked|<Hangup/);
      const selected = h.state.openVoiceState(callbackState(xml), binding);
      assert.equal(selected.booking.stage, 'date');
      assert.equal(selected.booking.failures, 0);
      assert.equal(selected.booking.serviceId, SERVICE_ID);
      assert.equal(selected.booking.serviceName, 'facial');
      assert.equal(selected.booking.customerName, 'Randy');
      assert.equal(selected.booking.idempotencyKey, key);
      assert.equal(h.bookings.length, 0);
      xml = await h.run({ speech: 'tomorrow', stateToken: callbackState(xml), ingress, from: CALLER });
      assert.match(xml, /What time would you like/);
      xml = await h.run({ speech: 'two thirty PM', stateToken: callbackState(xml), ingress, from: CALLER });
      assert.match(xml, /Say yes or press 1 to book it/);
      assert.equal(h.bookings.length, 0);
      xml = await h.run({ speech: 'yes', stateToken: callbackState(xml), ingress, from: CALLER });
      assert.match(xml, /appointment has been booked/);
      assert.equal(h.bookings.length, 1);
      assert.equal(h.bookings[0].idempotencyKey, key);
      assert.equal(h.bookings[0].time, '14:30');
      assert.ok(h.serviceLoads.every(id => id === BUSINESS_ID));
      assert.equal(h.requests.length, 0);
    });
  }
}

test('two failures in every collection stage reset before the next stage', async () => {
  const h = handlerHarness({ stateEnabled: true, services: productionServices });
  const binding = { businessId: BUSINESS_ID, callSid: CALL_SID, ingress: 'trial' };
  let xml = await h.run({ digits: '1', from: CALLER });
  for (const [stage, invalid, valid, next] of [
    ['name', 'x', 'Randy', 'service'],
    ['service', 'unmatched', 'Facial', 'date'],
    ['date', 'February 30th 2099', 'tomorrow', 'time'],
    ['time', '25 PM', 'two thirty PM', 'confirm'],
  ]) {
    for (let n = 1; n <= 2; n++) {
      xml = await h.run({ speech: invalid, stateToken: callbackState(xml), from: CALLER });
      const state = h.state.openVoiceState(callbackState(xml), binding);
      assert.equal(state.booking.stage, stage);
      assert.equal(state.booking.failures, n);
      assert.equal(h.bookings.length, 0);
    }
    xml = await h.run({ speech: valid, stateToken: callbackState(xml), from: CALLER });
    const state = h.state.openVoiceState(callbackState(xml), binding);
    assert.equal(state.booking.stage, next);
    assert.equal(state.booking.failures, 0);
  }
  for (let n = 1; n <= 2; n++) {
    xml = await h.run({ speech: 'maybe', stateToken: callbackState(xml), from: CALLER });
    assert.equal(h.state.openVoiceState(callbackState(xml), binding).booking.failures, n);
    assert.equal(h.bookings.length, 0);
  }
  xml = await h.run({ speech: 'yes', stateToken: callbackState(xml), from: CALLER });
  assert.match(xml, /appointment has been booked/);
  assert.equal(h.bookings.length, 1);
});

for (const silence of [false, true]) test(`service ${silence ? 'silence' : 'failed answers'} is bounded without mutation`, async () => {
  const h = handlerHarness({ stateEnabled: true, services: productionServices });
  let xml = await h.run({ digits: '1', from: CALLER });
  xml = await h.run({ speech: 'Randy', stateToken: callbackState(xml), from: CALLER });
  const limit = silence ? 2 : 3;
  for (let n = 1; n <= limit; n++) {
    xml = await h.run({ speech: silence ? '' : 'unmatched', stateToken: callbackState(xml), from: CALLER });
    if (n < limit) assert.ok(callbackState(xml));
    else {
      assert.match(xml, /No appointment was booked/);
      assert.match(xml, /<Hangup/);
      assert.equal(callbackState(xml), null);
    }
    assert.equal(h.bookings.length, 0);
  }
});

test('silence does not consume service failures and a valid answer clears both', async () => {
  const h = handlerHarness({ stateEnabled: true, services: productionServices });
  const binding = { businessId: BUSINESS_ID, callSid: CALL_SID, ingress: 'trial' };
  let xml = await h.run({ digits: '1', from: CALLER });
  for (const speech of ['Randy', 'unmatched', '']) {
    xml = await h.run({ speech, stateToken: callbackState(xml), from: CALLER });
  }
  const silent = h.state.openVoiceState(callbackState(xml), binding);
  assert.equal(silent.booking.failures, 1);
  assert.equal(silent.silence, 1);
  xml = await h.run({ speech: 'Facial', stateToken: callbackState(xml), from: CALLER });
  const recovered = h.state.openVoiceState(callbackState(xml), binding);
  assert.equal(recovered.booking.failures, 0);
  assert.equal(recovered.silence, 0);
  assert.equal(recovered.booking.stage, 'date');
  assert.equal(h.bookings.length, 0);
});

for (const verified of [true, false]) test(`recovered facial booking requires authoritative receipt: ${verified}`, async () => {
  const receipt = {
    success: true, changed: true, action_id: ACTION_ID, action_type: 'book',
    business_id: BUSINESS_ID, receipt_scope: 'action_outcome', replayed: false,
    appointment_id: APPOINTMENT_ID, customer_id: CUSTOMER_ID, service_id: SERVICE_ID,
    service: 'facial', date: '2099-09-20', time: '14:30:00', status: 'Booked',
  };
  const real = bookingModuleHarness({ services: productionServices, rpcResult: verified ? receipt : { success: true } });
  const h = handlerHarness({ stateEnabled: true, services: productionServices, bookingExecutor: real.module.executeVoiceBooking });
  let xml = await h.run({ digits: '1', from: CALLER });
  for (const speech of ['Randy', 'unmatched service', 'Facial', 'September twentieth 2099', 'two thirty PM']) {
    xml = await h.run({ speech, stateToken: callbackState(xml), from: CALLER });
    assert.ok(callbackState(xml));
    assert.equal(real.calls.length, 0);
    assert.equal(h.bookings.length, 0);
  }
  xml = await h.run({ speech: 'yes', stateToken: callbackState(xml), from: CALLER });
  assert.equal(real.calls.filter(call => call.name === 'voice_book_appointment_business').length, 1);
  if (verified) assert.match(xml, /appointment has been booked/);
  else {
    assert.doesNotMatch(xml, /appointment has been booked/);
    assert.match(xml, /couldn't verify the booking/);
    assert.equal(real.sms.length, 0);
  }
});

for (const failures of [undefined, 0, 1, 2]) test(`legacy/current service state with failures=${failures} accepts Facial`, async () => {
  const h = handlerHarness({ stateEnabled: true, services: productionServices });
  const binding = { businessId: BUSINESS_ID, callSid: CALL_SID, ingress: 'trial' };
  const state = h.state.initialBookingState();
  state.booking.stage = 'service';
  state.booking.customerName = 'Randy';
  if (failures !== undefined) state.booking.failures = failures;
  const xml = await h.run({ speech: 'Facial', stateToken: h.state.sealVoiceState(state, binding), from: CALLER });
  assert.match(xml, /What day would you like/);
  const next = h.state.openVoiceState(callbackState(xml), binding);
  assert.equal(next.booking.stage, 'date');
  assert.equal(next.booking.failures, 0);
  assert.equal(next.booking.idempotencyKey, state.booking.idempotencyKey);
  assert.equal(h.bookings.length, 0);
});

for (const selection of [{ kind: 'unavailable', fact_ids: [] }, { kind: 'clarify', fact_ids: [] }]) {
  test(`real Q&A ${selection.kind} does not reset the shared recovery budget`, async () => {
    const h = handlerHarness({ stateEnabled: true, selection });
    let xml = await h.run({ mode: '' });
    for (let n = 1; n <= 3; n++) {
      const url = new URL(/action="([^"]+)"/.exec(xml)[1].replaceAll('&amp;', '&'));
      xml = await h.run({ speech: 'unrelated background conversation', stateToken: url.searchParams.get('state'), mode: url.searchParams.get('mode') });
      if (n < 3) assert.equal(h.state.openVoiceState(callbackState(xml), { businessId: BUSINESS_ID, callSid: CALL_SID, ingress: 'trial' }).recovery, n);
    }
    assert.match(xml, /<Hangup/);
    assert.equal(h.requests.length, 3);
    assert.equal(h.bookings.length, 0);
  });
}
test('real Q&A grounded answer resets prior recovery, including missing Confidence', async () => {
  const h = handlerHarness({ stateEnabled: true });
  const initial = await h.run({ mode: '' });
  const rejected = await h.run({ speech: '...', stateToken: callbackState(initial) });
  const answered = await h.run({ speech: 'What is the business name?', stateToken: callbackState(rejected) });
  const next = h.state.openVoiceState(callbackState(answered), { businessId: BUSINESS_ID, callSid: CALL_SID, ingress: 'trial' });
  assert.equal(next.recovery, 0);
  assert.equal(next.silence, 0);
  assert.equal(next.mode, 'info');
  assert.equal(h.requests.length, 1);
});
test('signature validation covers state and recovery query parameters without logging them', async () => {
  const h = route('production');
  const url = `${env.TWILIO_VOICE_WEBHOOK_URL}?mode=retry&state=PRIVATE_STATE`;
  const params = { To: '+12025550100', From: CALLER, CallSid: CALL_SID, SpeechResult: 'PRIVATE_TRANSCRIPT', Confidence: '0.01' };
  const signature = twilio.getExpectedTwilioSignature(env.TWILIO_AUTH_TOKEN, url, params);
  const request = (target, body = params) => new Request(target, { method: 'POST', headers: {
    'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature,
  }, body: new URLSearchParams(body) });
  assert.equal((await h.postRequest(request(url))).status, 200);
  assert.equal((await h.postRequest(request(url.replace('mode=retry', 'mode=listen')))).status, 403);
  assert.equal((await h.postRequest(request(url.replace('PRIVATE_STATE', 'altered')))).status, 403);
  assert.equal((await h.postRequest(request(url, { ...params, Confidence: '0.95' }))).status, 403);
  assert.equal(h.calls, 1);
  const events = h.logs.filter(x => x[0] === 'AnaAI voice ingress').map(x => x[1]);
  assert.equal(events.length, 4);
  assert.deepEqual(events.map(x => x.outcome), ['responded', 'rejected', 'rejected', 'rejected']);
  for (const secret of ['PRIVATE_STATE', 'PRIVATE_TRANSCRIPT', CALLER, CALL_SID, signature]) assert.ok(!JSON.stringify(h.logs).includes(secret));
});
test('ingress exception emits a structured completion event with no exception text', async () => {
  const h = route('trial', {}, true);
  assert.equal((await h.post(env.TWILIO_TRIAL_VOICE_TOKEN)).status, 200);
  const events = h.logs.filter(x => x[0] === 'AnaAI voice ingress');
  assert.equal(events.length, 1);
  assert.equal(events[0][1].outcome, 'error');
  assert.ok(!JSON.stringify(h.logs).includes('PRIVATE'));
});
