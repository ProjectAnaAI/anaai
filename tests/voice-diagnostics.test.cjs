const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const twilio = require('twilio');
const crypto = require('node:crypto');

const businessId = '11111111-1111-4111-8111-111111111111';
const serviceId = '22222222-2222-4222-8222-222222222222';
const callSid = 'CA' + 'a'.repeat(32);
const phone = '+12025550123';
const env = {
  VOICE_STATE_SECRET: 'ab'.repeat(32),
  TWILIO_VOICE_WEBHOOK_URL: 'https://private.example/api/voice',
  TWILIO_TRIAL_VOICE_TOKEN: 'PRIVATE-TRIAL-TOKEN',
};
function harness({ ingress = 'production', services, throws = false, loggerThrows = false } = {}) {
  const events = [], bookings = [], loads = [];
  function load(file, imports = {}) {
    const exports = {};
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, {
      exports, Buffer, URL, AbortSignal, process: { env },
      console: { info: (...args) => {
        assert.equal(args.length, 1);
        events.push(JSON.parse(JSON.stringify(args[0])));
        if (loggerThrows) throw Error('PRIVATE LOGGER ERROR');
      } },
      require: name => {
        if (name === 'server-only') return {};
        assert.ok(name in imports, name);
        return imports[name];
      },
    });
    return exports;
  }
  const state = load('lib/voice-state.ts', { 'node:crypto': crypto });
  const parsing = load('lib/voice-parsing.ts', { './ai-actions': load('lib/ai-actions.ts') });
  const db = { from(table) {
    assert.equal(table, 'business_phone_numbers');
    const q = {};
    for (const method of ['select', 'eq', 'abortSignal']) q[method] = () => q;
    q.maybeSingle = async () => ({ data: { business_id: businessId, businesses: { name: 'PRIVATE BUSINESS', timezone: 'America/Los_Angeles' } }, error: null });
    return q;
  } };
  const handler = load('lib/voice-handler.ts', {
    twilio: { default: twilio },
    '@/lib/voice-state': state,
    '@/lib/voice-parsing': parsing,
    '@/lib/voice-config': load('lib/voice-config.ts'),
    '@/lib/supabase-server': { createSupabaseServiceClient: () => db },
    '@/lib/voice-receptionist': { safeVoiceText: value => value, answerVoiceQuestion: async () => 'Info' },
    '@/lib/voice-booking': {
      loadVoiceServices: async id => {
        loads.push(id);
        if (throws) throw Error('PRIVATE PROVIDER PAYLOAD');
        return services || [{ id: serviceId, name: 'facial' }];
      },
      executeVoiceBooking: async request => {
        bookings.push(request);
        return { success: true, replayed: false, smsSent: false };
      },
    },
  });
  const binding = { businessId, callSid, ingress };
  function initial(stage = 'service') {
    const value = state.initialBookingState();
    Object.assign(value.booking, {
      stage, customerName: 'PRIVATE CUSTOMER', serviceId, serviceName: 'facial', date: '2099-09-20', time: '14:30',
    });
    return value;
  }
  async function run(speech, value = initial()) {
    const formData = new FormData();
    for (const [key, v] of Object.entries({ To: '+12025550100', From: phone, CallSid: callSid, SpeechResult: speech, AccountSid: 'ACPRIVATE', MessageSid: 'SMPRIVATE', token: env.TWILIO_TRIAL_VOICE_TOKEN })) formData.set(key, v);
    const token = typeof value === 'string' ? value : state.sealVoiceState(value, binding);
    const xml = await handler.buildVoiceResponse({ formData, mode: 'listen', ingress, stateToken: token });
    const action = /action="([^"]+)"/.exec(xml)?.[1];
    const nextToken = action && new URL(action.replaceAll('&amp;', '&')).searchParams.get('state');
    return { xml, token, next: nextToken ? state.openVoiceState(nextToken, binding) : null };
  }
  return { events, bookings, loads, initial, run };
}

function checkSchema(event, invalidState = false) {
  const allowed = ['stage', 'speech_present', 'speech_length_bucket', 'confirmation_interpretation', 'stage_interpretation', 'failure_count_before', 'failure_count_after', 'next_stage', 'exit_reason', 'ingress'];
  assert.ok(Object.keys(event).every(key => allowed.includes(key)));
  assert.equal(typeof event.speech_present, 'boolean');
  for (const [key, options] of Object.entries({
    speech_length_bucket: ['empty', 'short', 'medium', 'long'],
    confirmation_interpretation: ['yes', 'no', 'unclear'],
    stage_interpretation: ['accepted', 'invalid', 'ambiguous', 'no_input', 'not_applicable'],
    next_stage: ['name', 'service', 'date', 'time', 'confirm', 'exit'],
    ingress: ['production', 'trial'],
  })) assert.ok(options.includes(event[key]), key);
  if (invalidState) {
    for (const key of ['stage', 'failure_count_before', 'failure_count_after']) assert.equal(key in event, false);
  } else {
    assert.ok(['name', 'service', 'date', 'time', 'confirm'].includes(event.stage));
    for (const key of ['failure_count_before', 'failure_count_after']) {
      assert.ok(Number.isInteger(event[key]) && event[key] >= 0 && event[key] <= 3);
    }
  }
  if (event.next_stage === 'exit') assert.ok(['explicit_negative', 'retry_exhausted', 'silence_exhausted', 'turn_limit', 'state_invalid', 'other'].includes(event.exit_reason));
  else assert.equal('exit_reason' in event, false);
}

for (const ingress of ['production', 'trial']) test(`diagnostic: ${ingress} service recovery emits one safe event per turn`, async () => {
  const h = harness({ ingress });
  const first = await h.run('PRIVATE-SPEECH +12025550123 CAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.match(first.xml, /couldn't match/);
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].stage_interpretation, 'invalid');
  assert.equal(h.events[0].failure_count_after, 1);
  const recovered = await h.run('I would like a facial, please.', first.next);
  assert.match(recovered.xml, /What date would you like for facial/);
  assert.equal(recovered.next.booking.stage, 'date');
  assert.equal(recovered.next.booking.idempotencyKey, first.next.booking.idempotencyKey);
  assert.equal(h.events.length, 2);
  assert.deepEqual(h.events[1], {
    stage: 'service', speech_present: true, speech_length_bucket: 'medium', confirmation_interpretation: 'unclear',
    stage_interpretation: 'accepted', failure_count_before: 1, failure_count_after: 0, next_stage: 'date', ingress,
  });
  assert.equal(h.bookings.length, 0);
  const serialized = JSON.stringify(h.events);
  for (const sensitive of ['PRIVATE', phone, businessId, serviceId, callSid, first.token, recovered.token, env.VOICE_STATE_SECRET, env.TWILIO_TRIAL_VOICE_TOKEN, env.TWILIO_VOICE_WEBHOOK_URL, 'facial', '2099-09-20', '14:30', first.next.booking.idempotencyKey]) {
    assert.ok(!serialized.includes(sensitive), 'sensitive content absent');
  }
  h.events.forEach(event => checkSchema(event));
});

test('diagnostic: service negative exits before service parser without mutation', async () => {
  const h = harness();
  const { xml } = await h.run('no');
  assert.match(xml, /Okay. No appointment was booked. Thanks for calling. Goodbye./);
  assert.equal(h.loads.length, 0);
  assert.equal(h.bookings.length, 0);
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].stage, 'service');
  assert.equal(h.events[0].confirmation_interpretation, 'no');
  assert.equal(h.events[0].stage_interpretation, 'not_applicable');
  assert.equal(h.events[0].exit_reason, 'explicit_negative');
  checkSchema(h.events[0]);
});

for (const [stage, speech, classification] of [
  ['name', 'PRIVATE CUSTOMER', 'accepted'], ['name', 'x', 'invalid'],
  ['date', 'tomorrow', 'accepted'], ['date', 'February 30th', 'invalid'],
  ['time', 'two thirty PM', 'accepted'], ['time', 'two thirty', 'ambiguous'], ['time', '25 PM', 'invalid'],
  ['confirm', 'maybe', 'ambiguous'], ['confirm', 'no', 'not_applicable'], ['confirm', 'yes', 'accepted'],
]) test(`diagnostic: ${stage} ${classification} preserves mutation gate`, async () => {
  const h = harness();
  await h.run(speech, h.initial(stage));
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].stage, stage);
  assert.equal(h.events[0].stage_interpretation, classification);
  assert.equal(h.bookings.length, stage === 'confirm' && speech === 'yes' ? 1 : 0);
  checkSchema(h.events[0]);
});

test('diagnostic: ambiguous service and retry exhaustion are distinct', async () => {
  const h = harness({ services: [{ id: serviceId, name: 'facial basic' }, { id: serviceId, name: 'facial premium' }] });
  let current = h.initial();
  for (let n = 1; n <= 3; n++) {
    const result = await h.run('facial', current);
    assert.equal(h.events.length, n);
    const event = h.events[n - 1];
    assert.equal(event.stage_interpretation, 'ambiguous');
    assert.equal(event.failure_count_before, n - 1);
    assert.equal(event.failure_count_after, n);
    checkSchema(event);
    current = result.next;
  }
  assert.equal(h.events[2].exit_reason, 'retry_exhausted');
  assert.equal(current, null);
  assert.equal(h.bookings.length, 0);
});

test('diagnostic: silence remains bounded', async () => {
  const h = harness();
  const first = await h.run('');
  const second = await h.run('', first.next);
  assert.equal(h.events.length, 2);
  assert.equal(h.events[0].speech_length_bucket, 'empty');
  assert.equal(h.events[0].stage_interpretation, 'no_input');
  assert.equal(h.events[1].exit_reason, 'silence_exhausted');
  assert.match(second.xml, /<Hangup/);
  assert.equal(h.bookings.length, 0);
  h.events.forEach(event => checkSchema(event));
});

test('diagnostic: turn limit and invalid state do not invent a trusted stage', async () => {
  const h = harness();
  const value = h.initial(); value.turns = 29;
  await h.run('Facial', value);
  assert.equal(h.events[0].exit_reason, 'turn_limit');
  assert.equal(h.events[0].stage_interpretation, 'not_applicable');
  checkSchema(h.events[0]);
  await h.run('PRIVATE TRANSCRIPT', 'PRIVATE INVALID STATE TOKEN');
  assert.equal(h.events.length, 2);
  assert.equal(h.events[1].exit_reason, 'state_invalid');
  checkSchema(h.events[1], true);
  assert.equal(h.bookings.length, 0);
});

test('diagnostic: exceptions are rethrown without logging their payload', async () => {
  const h = harness({ throws: true });
  await assert.rejects(h.run('Facial'), /PRIVATE PROVIDER PAYLOAD/);
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].stage_interpretation, 'not_applicable');
  assert.equal(h.events[0].exit_reason, 'other');
  assert.ok(!JSON.stringify(h.events).includes('PRIVATE'));
  checkSchema(h.events[0]);
});

test('diagnostic: logger failure never prevents or repeats booking', async () => {
  const h = harness({ loggerThrows: true });
  const result = await h.run('yes', h.initial('confirm'));
  assert.match(result.xml, /booked successfully/);
  assert.equal(h.bookings.length, 1);
  assert.equal(h.events.length, 1);
});

test('diagnostic: long speech is a bucket only', async () => {
  const h = harness();
  await h.run('PRIVATE '.repeat(30));
  assert.equal(h.events[0].speech_length_bucket, 'long');
  assert.ok(!JSON.stringify(h.events).includes('PRIVATE'));
  checkSchema(h.events[0]);
});
