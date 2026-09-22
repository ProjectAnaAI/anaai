// Run: node --test tests/voice-conversation.test.cjs
//
// Natural-conversation regressions for the Voice receptionist. Every test here
// corresponds to a concrete conversational defect: details supplied in an
// unexpected order used to be discarded, a service named inside a longer
// sentence used to fail to match, and a correction used to wipe unrelated
// fields.
//
// No network, no database, no PostgreSQL. The semantic layer is stubbed OFF by
// default so these prove the DETERMINISTIC path: the conversation must work
// when the model is unavailable, and the model may only ever supplement it.
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
  VOICE_STATE_SECRET: 'ab'.repeat(32),
};

const BUSINESS_ID = '11111111-1111-4111-8111-111111111111';
const HAIRCUT_ID = '22222222-2222-4222-8222-222222222222';
const FACIAL_ID = '33333333-3333-4333-8333-333333333333';
const WAXING_ID = '44444444-4444-4444-8444-444444444444';
const CALL_SID = 'CA' + 'b'.repeat(32);
const CALLER = '+12025550123';
const TIMEZONE = 'America/Los_Angeles';

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
      URL, Request, Response, FormData, Buffer, AbortSignal, Intl, Date,
      console: { error: (...a) => logs.push(a), warn: (...a) => logs.push(a), log: (...a) => logs.push(a), info: (...a) => logs.push(a) },
    }
  );
  return exports;
}

const aiActions = load('lib/ai-actions.ts', {});
const parsing = load('lib/voice-parsing.ts', { './ai-actions': aiActions });
const slots = load('lib/voice-slots.ts', { '@/lib/voice-parsing': parsing });
const voiceConfig = load('lib/voice-config.ts', {});
const voiceInput = load('lib/voice-input.ts', {});

/*
 * Relative days are DERIVED with the same business-timezone helper the handler
 * uses, so these tests never depend on the machine's current date.
 */
const TODAY = parsing.businessLocalDate(TIMEZONE, 0);
const TOMORROW = parsing.businessLocalDate(TIMEZONE, 1);

function stateOf(xml) {
  const action = /action="([^"]+)"/.exec(xml)?.[1];
  return action ? new URL(action.replaceAll('&amp;', '&')).searchParams.get('state') : null;
}

const said = (xml) => [...xml.matchAll(/<Say[^>]*>([^<]*)<\/Say>/g)].map(m => m[1]).join(' ');

function harness({
  services = [
    { id: HAIRCUT_ID, name: 'Haircut' },
    { id: FACIAL_ID, name: 'Facial' },
    { id: WAXING_ID, name: 'Waxing' },
  ],
  understanding = null,
  availability = () => ({ available: true }),
  bookingResult = { success: true, replayed: false, smsSent: true },
  handoffSettings = null,
  stateEnabled = true,
  answerAvailable = false,
} = {}) {
  const logs = [], bookings = [], availabilityChecks = [], understandings = [], questions = [], serviceLoads = [];

  const db = {
    from(table) {
      const q = {};
      for (const m of ['select', 'eq', 'order', 'limit', 'abortSignal']) q[m] = () => q;
      const rows = {
        business_phone_numbers: { business_id: BUSINESS_ID, businesses: { name: 'Example Salon', timezone: TIMEZONE } },
        voice_handoff_settings: handoffSettings,
        business_profiles: { address: 'Test street', business_hours: '{}' },
        services: [],
        business_knowledge: [],
        ai_settings: { tone: 'friendly' },
      };
      q.maybeSingle = async () => ({ data: rows[table] ?? null, error: null });
      q.then = r => Promise.resolve({ data: rows[table] ?? [], error: null }).then(r);
      return q;
    },
  };

  const state = load('lib/voice-state.ts', { 'node:crypto': require('node:crypto') }, logs, stateEnabled ? {} : { VOICE_STATE_SECRET: '' });

  const handler = load(
    'lib/voice-handler.ts',
    {
      twilio: { default: twilio },
      '@/lib/supabase-server': { createSupabaseServiceClient: () => db },
      '@/lib/voice-receptionist': {
        answerVoiceQuestion: async (...args) => { questions.push(args[2]); if (answerAvailable) args[4]?.(); return answerAvailable ? 'Our hours are nine to five.' : 'I do not have that information available.'; },
        safeVoiceText: (v, max = 350) => (typeof v === 'string' && v.length <= max ? v : ''),
      },
      '@/lib/voice-state': state,
      '@/lib/voice-input': voiceInput,
      '@/lib/voice-appointment-management': load('lib/voice-appointment-management.ts', {
        'node:crypto': require('node:crypto'),
        '@/lib/supabase-server': { createSupabaseServiceClient: () => db },
        '@/lib/voice-state': state,
        '@/lib/voice-input': voiceInput, '@/lib/voice-slots': slots, '@/lib/voice-parsing': parsing,
      }, logs),
      '@/lib/voice-booking': {
        loadVoiceServices: async () => { serviceLoads.push(true); return services; },
        checkVoiceAvailability: async request => {
          availabilityChecks.push(request);
          return availability(request);
        },
        executeVoiceBooking: async request => {
          bookings.push(request);
          return bookingResult;
        },
      },
      '@/lib/voice-parsing': parsing,
      '@/lib/voice-slots': slots,
      '@/lib/voice-config': voiceConfig,
      '@/lib/voice-understanding': {
        understandVoiceTurn: async request => {
          understandings.push(request);
          // Default: the semantic layer is unavailable. Determinism must cope.
          return understanding
            ? understanding(request)
            : {
                kind: 'unclear', meaningful: false, customerName: null, serviceName: null,
                serviceUnresolved: false, dateExpression: null, timeExpression: null,
                confirmation: null, correction: false,
              };
        },
      },
    },
    logs,
    stateEnabled ? {} : { VOICE_STATE_SECRET: '' }
  );

  const run = async ({ speech = '', digits = '', stateToken = '', confidence = '', mode = stateToken ? 'listen' : '' } = {}) => {
    const formData = new FormData();
    formData.set('To', '+12025550100');
    if (speech !== null) formData.set('SpeechResult', speech);
    if (digits !== null) formData.set('Digits', digits);
    formData.set('CallSid', CALL_SID);
    formData.set('From', CALLER);
    if (confidence) formData.set('Confidence', confidence);
    return handler.buildVoiceResponse({ formData, mode, ingress: 'trial', stateToken });
  };

  return {
    run, state, logs, bookings, availabilityChecks, understandings, questions, serviceLoads,
    open: xml => state.openVoiceState(stateOf(xml), { businessId: BUSINESS_ID, callSid: CALL_SID, ingress: 'trial' }),
  };
}

/* Drive a full conversation; each entry is an argument object for run(). */
async function converse(h, turns) {
  const results = [];
  let token = '';
  for (const turn of turns) {
    const xml = await h.run({ ...turn, stateToken: turn.fresh ? '' : token });
    token = stateOf(xml) || '';
    results.push(xml);
  }
  return results;
}

// --------------------------------------------------------------------------
// 1-5: flexible order, details preserved, only the missing field asked for
// --------------------------------------------------------------------------

test('1. a bare booking request starts collection and books nothing', async () => {
  const h = harness();
  const xml = await h.run({ speech: 'I want to book an appointment.' });
  assert.match(said(xml), /What name should I put on the appointment/);
  assert.equal(h.bookings.length, 0);
  const s = h.open(xml);
  assert.equal(s.booking.date, null);
  assert.equal(s.booking.time, null);
});

test('2-4. date and time given first are preserved, and only name and service are asked for', async () => {
  const h = harness();
  const xml = await h.run({ speech: 'I want to book an appointment for tomorrow at 1:00 PM.' });

  const s = h.open(xml);
  assert.equal(s.booking.date, TOMORROW, 'tomorrow resolved in the business timezone');
  assert.equal(s.booking.requestedTime, '13:00');
  assert.equal(s.booking.customerName, null);
  assert.equal(s.booking.serviceId, null);

  // Asks only for what is missing, and never re-asks for the day or time.
  assert.match(said(xml), /What name should I put on the appointment/);
  assert.doesNotMatch(said(xml), /what day|what time/i);
  assert.equal(h.bookings.length, 0);
});

test('5. "BJ, haircut" supplies the remaining name and service in one utterance', async () => {
  const h = harness();
  const [, second] = await converse(h, [
    { speech: 'I want to book an appointment for tomorrow at 1:00 PM.' },
    { speech: 'BJ, haircut' },
  ]);

  const s = h.open(second);
  assert.equal(s.booking.customerName, 'BJ');
  assert.equal(s.booking.serviceName, 'Haircut');
  assert.equal(s.booking.date, TOMORROW);
  assert.equal(s.booking.time, '13:00', 'availability verified');
  assert.equal(s.booking.stage, 'confirm');

  // Summarised as a proposal, never as a completed booking.
  assert.match(said(second), /Haircut for BJ tomorrow at 1 PM/);
  assert.match(said(second), /Say yes or press 1 to book it/);
  assert.doesNotMatch(said(second), /has been booked/);
  assert.equal(h.bookings.length, 0);
});

// --------------------------------------------------------------------------
// 6-12: multi-field extraction in every combination
// --------------------------------------------------------------------------

test('6-7. the production failure: service, date and time in one sentence at the service turn', async () => {
  const h = harness();
  const [, , third] = await converse(h, [
    { speech: 'I want to book an appointment.' },
    { speech: 'Alex Rivera' },
    { speech: 'Facial on October 2nd at 2:30 in the afternoon.' },
  ]);

  // The deployed matcher tested the WHOLE sentence against the service name
  // and answered "I couldn't match that service."
  assert.doesNotMatch(said(third), /couldn't match/i);

  const s = h.open(third);
  assert.equal(s.booking.serviceName, 'Facial');
  assert.match(s.booking.date, /^\d{4}-10-02$/);
  assert.equal(s.booking.time, '14:30');
  assert.equal(s.booking.stage, 'confirm');
  assert.equal(h.bookings.length, 0);
});

test('8. service and date without a time asks only for the time', async () => {
  const h = harness();
  const [, , third] = await converse(h, [
    { speech: 'Book an appointment' },
    { speech: 'Alex Rivera' },
    { speech: 'Waxing next Friday' },
  ]);

  const s = h.open(third);
  assert.equal(s.booking.serviceName, 'Waxing');
  assert.ok(s.booking.date > TODAY);
  assert.equal(s.booking.requestedTime, null);
  assert.match(said(third), /What time would you like/);
  assert.doesNotMatch(said(third), /which service|what day/i);
});

test('9. service and time when the day is already known completes the booking details', async () => {
  const h = harness();
  const [, , , fourth] = await converse(h, [
    { speech: 'Book an appointment for tomorrow' },
    { speech: 'Alex Rivera' },
    { speech: 'Haircut' },
    { speech: 'Facial at 3 PM' },
  ]);

  const s = h.open(fourth);
  assert.equal(s.booking.serviceName, 'Facial', 'the later service replaces the earlier one');
  assert.equal(s.booking.date, TOMORROW, 'the known day survives');
  assert.equal(s.booking.time, '15:00');
});

test('10. day and time when the service is already known reaches confirmation', async () => {
  const h = harness();
  const [, , , fourth] = await converse(h, [
    { speech: 'Book an appointment' },
    { speech: 'Alex Rivera' },
    { speech: 'Haircut' },
    { speech: 'tomorrow at 11 AM' },
  ]);

  const s = h.open(fourth);
  assert.equal(s.booking.serviceName, 'Haircut');
  assert.equal(s.booking.date, TOMORROW);
  assert.equal(s.booking.time, '11:00');
  assert.equal(s.booking.stage, 'confirm');
});

test('11-12. name, service, day and time in one sentence, in a natural order', async () => {
  const h = harness();
  const [, second] = await converse(h, [
    { speech: 'I would like to book something' },
    { speech: "I'd like a haircut tomorrow around 1 PM. The name is BJ." },
  ]);

  const s = h.open(second);
  assert.equal(s.booking.customerName, 'BJ');
  assert.equal(s.booking.serviceName, 'Haircut');
  assert.equal(s.booking.date, TOMORROW);
  assert.equal(s.booking.time, '13:00');
  assert.equal(s.booking.stage, 'confirm');
  assert.equal(h.bookings.length, 0);
});

// --------------------------------------------------------------------------
// 13-18: corrections preserve unrelated fields and invalidate stale state
// --------------------------------------------------------------------------

async function atConfirmation(h, { time = '1 PM' } = {}) {
  const xml = await converse(h, [
    { speech: 'Book an appointment' },
    { speech: 'BJ' },
    { speech: `Haircut tomorrow at ${time}` },
  ]);
  return xml[xml.length - 1];
}

test('13. an explicit replacement time keeps the service and day and revalidates', async () => {
  const h = harness();
  const confirm = await atConfirmation(h);
  assert.equal(h.open(confirm).booking.time, '13:00');

  const xml = await h.run({ speech: 'Please make it 2:30 in the afternoon.', stateToken: stateOf(confirm) });
  const s = h.open(xml);

  assert.equal(s.booking.time, '14:30');
  assert.equal(s.booking.serviceName, 'Haircut', 'service preserved');
  assert.equal(s.booking.date, TOMORROW, 'day preserved');
  assert.equal(h.availabilityChecks.at(-1).time, '14:30', 'availability recomputed');
  assert.equal(h.bookings.length, 0);
});

test('14. "Actually make it 3:30" is a correction, not authorization', async () => {
  const h = harness();
  const confirm = await atConfirmation(h);
  const xml = await h.run({ speech: 'Actually make it 3:30.', stateToken: stateOf(confirm) });

  // 3:30 alone is ambiguous, so Ana asks rather than guessing.
  assert.match(said(xml), /3:30 AM or 3:30 PM/);
  assert.equal(h.bookings.length, 0);

  const pending = h.open(xml);
  assert.equal(JSON.stringify(pending.booking.pendingTimeOptions), JSON.stringify(['03:30', '15:30']));
  assert.equal(pending.booking.time, null, 'stale availability dropped');

  const resolved = await h.run({ speech: 'PM', stateToken: stateOf(xml) });
  assert.equal(h.open(resolved).booking.time, '15:30');
  assert.equal(h.bookings.length, 0);
});

test('15. a day-only correction keeps the service and the time', async () => {
  const h = harness();
  const confirm = await atConfirmation(h);
  const xml = await h.run({ speech: 'No, make that Friday.', stateToken: stateOf(confirm) });
  const s = h.open(xml);

  assert.notEqual(s.booking.date, TOMORROW, 'the day changed');
  assert.equal(s.booking.serviceName, 'Haircut', 'service preserved');
  assert.equal(s.booking.requestedTime, '13:00', 'time preserved');
  assert.equal(h.availabilityChecks.at(-1).date, s.booking.date, 'availability recomputed for the new day');
  assert.equal(h.bookings.length, 0);
});

test('16. a service-only correction keeps the day and the time', async () => {
  const h = harness();
  const confirm = await atConfirmation(h);
  const xml = await h.run({ speech: 'Actually make that a facial.', stateToken: stateOf(confirm) });
  const s = h.open(xml);

  assert.equal(s.booking.serviceName, 'Facial');
  assert.equal(s.booking.date, TOMORROW, 'day preserved');
  assert.equal(s.booking.requestedTime, '13:00', 'time preserved');
  // Duration depends on the service, so availability must be recomputed.
  assert.equal(h.availabilityChecks.at(-1).serviceId, FACIAL_ID);
  assert.equal(h.bookings.length, 0);
});

test('17. a correction invalidates a stale availability answer', async () => {
  const checks = [];
  const h = harness({
    availability: request => {
      checks.push(request);
      // The original slot is free; the replacement day is not.
      return request.date === TOMORROW ? { available: true } : { available: false, reason: 'slot_unavailable' };
    },
  });

  const confirm = await atConfirmation(h);
  assert.equal(h.open(confirm).booking.time, '13:00');

  const xml = await h.run({ speech: 'Make it Friday instead.', stateToken: stateOf(confirm) });

  // The earlier "available" answer must not carry over to the new day.
  assert.equal(h.open(xml).booking.time, null);
  assert.match(said(xml), /isn't available/);
  assert.equal(h.bookings.length, 0);
  assert.ok(checks.length >= 2);
});

test('18. a correction invalidates a pending confirmation so a later yes cannot book the old slot', async () => {
  const h = harness();
  const confirm = await atConfirmation(h);
  const corrected = await h.run({ speech: 'Actually make it 3:30.', stateToken: stateOf(confirm) });

  // An affirmative while the AM/PM question is open answers nothing.
  const premature = await h.run({ speech: 'yes', stateToken: stateOf(corrected) });
  assert.equal(h.bookings.length, 0);
  assert.match(said(premature), /3:30 AM or 3:30 PM/);
  assert.doesNotMatch(said(premature), /has been booked/);
});

// --------------------------------------------------------------------------
// 19-22: confirmation safety
// --------------------------------------------------------------------------

test('19. an explicit yes books exactly the confirmed appointment', async () => {
  const h = harness();
  const confirm = await atConfirmation(h);
  const xml = await h.run({ speech: 'yes', stateToken: stateOf(confirm) });

  assert.equal(h.bookings.length, 1);
  assert.deepEqual(
    { service: h.bookings[0].serviceName, date: h.bookings[0].date, time: h.bookings[0].time, name: h.bookings[0].customerName },
    { service: 'Haircut', date: TOMORROW, time: '13:00', name: 'BJ' }
  );
  assert.match(said(xml), /appointment has been booked/);
});

test('20. DTMF 1 confirms, DTMF 2 declines', async () => {
  const yes = harness();
  const confirmYes = await atConfirmation(yes);
  // The deployed handler never passed Digits into the booking flow at all,
  // so "press 1 to confirm" did nothing.
  const booked = await yes.run({ digits: '1', stateToken: stateOf(confirmYes) });
  assert.equal(yes.bookings.length, 1);
  assert.match(said(booked), /appointment has been booked/);

  const no = harness();
  const confirmNo = await atConfirmation(no);
  const declined = await no.run({ digits: '2', stateToken: stateOf(confirmNo) });
  assert.equal(no.bookings.length, 0);
  assert.match(said(declined), /No appointment was booked/);
});

test('20b. DTMF 1 and 2 also answer an AM/PM clarification', async () => {
  const h = harness();
  const confirm = await atConfirmation(h);
  const ambiguous = await h.run({ speech: 'Actually make it 3:30.', stateToken: stateOf(confirm) });
  assert.match(said(ambiguous), /press 1 for 3:30 AM and 2 for 3:30 PM/);

  const chosen = await h.run({ digits: '2', stateToken: stateOf(ambiguous) });
  assert.equal(h.open(chosen).booking.time, '15:30');
  assert.equal(h.bookings.length, 0);
});

test('21. no at confirmation never books', async () => {
  const h = harness();
  const confirm = await atConfirmation(h);
  const xml = await h.run({ speech: 'no', stateToken: stateOf(confirm) });
  assert.equal(h.bookings.length, 0);
  assert.match(said(xml), /No appointment was booked/);
  assert.match(xml, /<Hangup/);
});

test('22. unexpected speech at confirmation never books', async () => {
  for (const speech of [
    'the weather is nice today',
    'hmm',
    'what was that',
    'can you repeat the price',
    'yes no maybe',
  ]) {
    const h = harness();
    const confirm = await atConfirmation(h);
    const xml = await h.run({ speech, stateToken: stateOf(confirm) });
    assert.equal(h.bookings.length, 0, speech);
    assert.doesNotMatch(said(xml), /has been booked/, speech);
  }
});

test('22b. a restated detail at confirmation is a correction even when the model says yes', async () => {
  // An adversarial semantic layer that always authorizes must not be able to
  // book on a turn that also carries appointment details.
  const h = harness({
    understanding: () => ({
      kind: 'unclear', meaningful: true, customerName: null, serviceName: 'Haircut',
      serviceUnresolved: false, dateExpression: null, timeExpression: null,
      confirmation: 'yes', correction: false,
    }),
  });
  const confirm = await atConfirmation(h);
  const xml = await h.run({ speech: 'Yes, a haircut.', stateToken: stateOf(confirm) });
  assert.equal(h.bookings.length, 0);
  assert.doesNotMatch(said(xml), /has been booked/);
});

// --------------------------------------------------------------------------
// 23-27: interruptions, recovery, and the availability/booking race
// --------------------------------------------------------------------------

test('23. a human request during booking transfers and never submits the appointment', async () => {
  const h = harness({ handoffSettings: { is_enabled: true, human_transfer_phone: '+12025550199' } });
  const confirm = await atConfirmation(h);
  const xml = await h.run({ speech: 'Can I speak to a real person?', stateToken: stateOf(confirm) });
  assert.match(xml, /<Dial>/);
  assert.match(xml, /\+12025550199/);
  assert.equal(h.bookings.length, 0);
});

test('24. silence re-prompts for the outstanding field, then ends without booking', async () => {
  const h = harness();
  const started = await h.run({ speech: 'Book an appointment' });

  const first = await h.run({ speech: '', stateToken: stateOf(started) });
  assert.match(said(first), /I didn't catch that.*What name/);
  assert.equal(h.bookings.length, 0);

  const second = await h.run({ speech: '', stateToken: stateOf(first) });
  assert.match(xmlText(second), /<Hangup/);
  assert.match(said(second), /No appointment was booked/);
  assert.equal(h.bookings.length, 0);
});

function xmlText(xml) {
  return xml;
}

test('24b. silence at confirmation repeats the proposal without booking', async () => {
  const h = harness();
  const confirm = await atConfirmation(h);
  const xml = await h.run({ speech: '', stateToken: stateOf(confirm) });
  assert.match(said(xml), /I have Haircut for BJ tomorrow at 1 PM/);
  assert.doesNotMatch(said(xml), /has been booked/);
  assert.equal(h.bookings.length, 0);
});

test('25. unrecognisable speech re-prompts for the specific missing field and escalates', async () => {
  const h = harness();
  let xml = await h.run({ speech: 'Book an appointment' });

  // Two failures re-ask; the third escalates rather than looping forever.
  for (const n of [1, 2]) {
    xml = await h.run({ speech: '@@@@', stateToken: stateOf(xml) });
    assert.equal(h.open(xml).recovery, n);
    assert.match(said(xml), /name/i);
  }

  xml = await h.run({ speech: '@@@@', stateToken: stateOf(xml) });
  assert.match(xml, /<Hangup/);
  assert.match(said(xml), /No appointment was booked/);
  assert.equal(h.bookings.length, 0);
});

test('26. availability failures are explained naturally and recover in place', async () => {
  for (const [reason, pattern] of [
    ['slot_unavailable', /isn't available/],
    ['outside_hours', /outside our hours/],
    ['closed', /closed that day/],
  ]) {
    const h = harness({ availability: () => ({ available: false, reason }) });
    const xml = await converse(h, [
      { speech: 'Book an appointment' },
      { speech: 'BJ' },
      { speech: 'Haircut tomorrow at 1 PM' },
    ]);
    const last = xml[xml.length - 1];
    assert.match(said(last), pattern, reason);
    assert.doesNotMatch(said(last), /has been booked/, reason);
    assert.equal(h.bookings.length, 0, reason);
    // Never leaves a verified availability behind.
    assert.equal(h.open(last).booking.time, null, reason);
  }
});

test('26b. an unverifiable availability check never reports a free slot', async () => {
  const h = harness({ availability: () => ({ available: false, reason: 'unverified' }) });
  const xml = await converse(h, [
    { speech: 'Book an appointment' },
    { speech: 'BJ' },
    { speech: 'Haircut tomorrow at 1 PM' },
  ]);
  const last = xml[xml.length - 1];
  assert.match(said(last), /couldn't check availability/);
  assert.match(last, /<Hangup/);
  assert.equal(h.bookings.length, 0);
});

test('27-28. an authoritative conflict after a successful precheck is never spoken as success', async () => {
  // Availability is advisory: another booking can consume the capacity between
  // the check and the caller's yes.
  const h = harness({
    availability: () => ({ available: true }),
    bookingResult: { success: false, message: 'That time is no longer available. No appointment was booked.' },
  });

  const confirm = await atConfirmation(h);
  const xml = await h.run({ speech: 'yes', stateToken: stateOf(confirm) });

  assert.equal(h.bookings.length, 1, 'the authoritative RPC was called');
  assert.match(said(xml), /no longer available/);
  assert.doesNotMatch(said(xml), /has been booked/);
  assert.doesNotMatch(said(xml), /confirmation text/);
});

test('28b. success wording and the SMS claim follow the database result only', async () => {
  const booked = harness({ bookingResult: { success: true, replayed: false, smsSent: true } });
  const a = await booked.run({ speech: 'yes', stateToken: stateOf(await atConfirmation(booked)) });
  assert.match(said(a), /appointment has been booked/);
  assert.match(said(a), /confirmation text was submitted/);

  const noSms = harness({ bookingResult: { success: true, replayed: false, smsSent: false } });
  const b = await noSms.run({ speech: 'yes', stateToken: stateOf(await atConfirmation(noSms)) });
  assert.match(said(b), /appointment has been booked/);
  assert.match(said(b), /couldn't verify the text confirmation status/);

  const replayed = harness({ bookingResult: { success: true, replayed: true, smsSent: false } });
  const c = await replayed.run({ speech: 'yes', stateToken: stateOf(await atConfirmation(replayed)) });
  assert.match(said(c), /already completed. No duplicate appointment/);
});

// --------------------------------------------------------------------------
// Ambiguity is asked about, never guessed
// --------------------------------------------------------------------------

test('two services in one utterance asks which one', async () => {
  const h = harness();
  const xml = await converse(h, [
    { speech: 'Book an appointment' },
    { speech: 'BJ' },
    { speech: 'facial and haircut tomorrow at 1 PM' },
  ]);
  const last = xml[xml.length - 1];
  assert.match(said(last), /Did you want Facial or Haircut/);
  assert.equal(h.open(last).booking.serviceId, null, 'no service guessed');
  assert.equal(h.bookings.length, 0);
});

test('an offered choice of days is not silently narrowed to the first', async () => {
  const h = harness();
  const xml = await converse(h, [
    { speech: 'Book an appointment' },
    { speech: 'BJ' },
    { speech: 'Haircut' },
    { speech: 'September 24 or 25' },
  ]);
  const last = xml[xml.length - 1];
  assert.equal(h.open(last).booking.date, null, 'no day guessed');
  assert.match(said(last), /couldn't work out that day/);
});

test('a past day is refused rather than booked', async () => {
  const h = harness();
  const xml = await converse(h, [
    { speech: 'Book an appointment' },
    { speech: 'BJ' },
    { speech: 'Haircut' },
    { speech: '2000-01-01' },
  ]);
  const last = xml[xml.length - 1];
  assert.match(said(last), /already passed/);
  assert.equal(h.open(last).booking.date, null);
  assert.equal(h.bookings.length, 0);
});

// --------------------------------------------------------------------------
// 21: speech configuration and low-confidence recognition
// --------------------------------------------------------------------------

test('empty and whitespace SpeechResult are both treated as no input', async () => {
  for (const speech of ['', '   ', '\n\t ']) {
    const h = harness();
    const started = await h.run({ speech: 'Book an appointment' });
    const xml = await h.run({ speech, stateToken: stateOf(started) });
    assert.match(said(xml), /I didn't catch that/, JSON.stringify(speech));
    assert.equal(h.bookings.length, 0);
  }
});

test('every booking turn biases recognition toward services and scheduling words', async () => {
  const h = harness();
  const xml = await converse(h, [
    { speech: 'Book an appointment' },
    { speech: 'BJ' },
  ]);
  for (const turn of xml) {
    const hints = /hints="([^"]*)"/.exec(turn)?.[1];
    assert.ok(hints, 'booking turns carry hints');
    assert.ok(hints.includes('Haircut') && hints.includes('tomorrow') && hints.includes('PM'));
  }
  // Speech settings tuned against real calls are unchanged.
  assert.match(xml[0], /timeout="6"/);
  assert.match(xml[0], /speechTimeout="2"/);
  assert.match(xml[0], /speechModel="experimental_conversations"/);
  assert.match(xml[0], /input="speech dtmf"/);
  assert.match(xml[0], /actionOnEmptyResult="true"/);
});

test('a reported low-confidence transcript cannot authorize a booking', async () => {
  const h = harness();
  const confirm = await atConfirmation(h);
  const xml = await h.run({ speech: 'yes', confidence: '0.12', stateToken: stateOf(confirm) });

  assert.equal(h.bookings.length, 0);
  assert.match(said(xml), /didn't hear that clearly enough/);
  assert.match(said(xml), /I have Haircut for BJ tomorrow at 1 PM/);

  // The same words at a normal confidence do book.
  const ok = await h.run({ speech: 'yes', confidence: '0.93', stateToken: stateOf(xml) });
  assert.equal(h.bookings.length, 1);
  assert.match(said(ok), /appointment has been booked/);
});

test('missing confidence remains supported but malformed confidence cannot authorize', async () => {
  // Twilio omits Confidence for some speech models; that must not block booking.
  for (const confidence of ['', 'not-a-number', '-1', '2']) {
    const h = harness();
    const confirm = await atConfirmation(h);
    await h.run({ speech: 'yes', confidence, stateToken: stateOf(confirm) });
    assert.equal(h.bookings.length, confidence === '' ? 1 : 0, JSON.stringify(confidence));
  }
});

test('DTMF confirmation is unaffected by a low-confidence speech score', async () => {
  const h = harness();
  const confirm = await atConfirmation(h);
  await h.run({ digits: '1', confidence: '0.05', stateToken: stateOf(confirm) });
  assert.equal(h.bookings.length, 1, 'a keypress is not a transcript');
});

// --------------------------------------------------------------------------
// The semantic layer supplements; it is never authority
// --------------------------------------------------------------------------

test('the whole booking flow completes with the semantic layer unavailable', async () => {
  // Every test above already runs with the model stubbed to "unclear"; this
  // asserts the end-to-end path explicitly.
  const h = harness();
  const confirm = await atConfirmation(h);
  await h.run({ speech: 'yes', stateToken: stateOf(confirm) });
  assert.equal(h.bookings.length, 1);
  assert.ok(h.understandings.length > 0, 'the model was consulted');
});

test('a model-invented service is discarded but its date and time survive', async () => {
  const h = harness({
    understanding: () => ({
      kind: 'unclear', meaningful: true, customerName: null,
      serviceName: null, serviceUnresolved: true,
      dateExpression: 'tomorrow', timeExpression: '1 PM',
      confirmation: null, correction: false,
    }),
  });

  const xml = await converse(h, [
    { speech: 'Book an appointment' },
    { speech: 'BJ' },
    { speech: 'something for my hair' },
  ]);
  const last = xml[xml.length - 1];

  // The unusable service name is not accepted...
  assert.equal(h.open(last).booking.serviceId, null);
  assert.match(said(last), /couldn't match that to a service/);
  // ...but the caller does not have to repeat the day and time.
  assert.equal(h.open(last).booking.date, TOMORROW);
  assert.equal(h.open(last).booking.requestedTime, '13:00');
});

test('a model date or time still passes the deterministic validators', async () => {
  const h = harness({
    understanding: () => ({
      kind: 'unclear', meaningful: true, customerName: null, serviceName: null,
      serviceUnresolved: false, dateExpression: 'the thirty-second of Octember',
      timeExpression: 'half past fish', confirmation: null, correction: false,
    }),
  });

  // Begin at date collection so this test isolates invalid model fields; the
  // separate repeated-failure tests verify termination instead of a fourth turn.
  const last = await h.run({ speech: 'sometime around then', stateToken: bookingToken(h, 'date') });
  assert.equal(h.open(last).booking.date, null, 'an unparsable model date is refused');
  assert.equal(h.availabilityChecks.length, 0);
  assert.equal(h.bookings.length, 0);
});

// Follow the actual Twilio action, including retry modes and encrypted state.
function nextTurn(h, xml, input = {}) {
  const action = /<Gather[^>]*action="([^"]+)"/.exec(xml)?.[1];
  assert.ok(action, 'a continuing turn must provide an action');
  const url = new URL(action.replaceAll('&amp;', '&'));
  return h.run({ ...input, stateToken: url.searchParams.get('state') || '', mode: url.searchParams.get('mode') || '' });
}
const rejectedInputs = [
  { speech: '...', confidence: '0.95' },
  { speech: 'banana', confidence: '0.01' },
  { speech: 'banana', confidence: 'NaN' },
  { speech: 'banana', confidence: '-1' },
  { speech: 'banana', confidence: '2' },
  { speech: 'yes', digits: '1', confidence: '0.99' },
  { digits: '9' },
];
for (const flow of ['menu', 'info']) {
  for (const [n, input] of rejectedInputs.entries()) test(`${flow}: rejected input ${n} is bounded without dispatch`, async () => {
    const h = harness();
    let xml = await h.run({ mode: '' });
    if (flow === 'info') xml = await nextTurn(h, xml, { digits: '2' });
    for (let turn = 1; turn <= 3; turn++) {
      xml = await nextTurn(h, xml, input);
      if (turn < 3) { assert.equal(h.open(xml).recovery, turn); assert.equal(h.open(xml).mode, flow); }
      else assert.match(xml, /<Hangup/);
    }
    assert.equal(h.questions.length, 0);
    assert.equal(h.serviceLoads.length, 0);
    assert.equal(h.understandings.length, 0);
    assert.equal(h.bookings.length, 0);
  });
  for (const speech of [null, '', ' \n\t ']) test(`${flow}: two genuine empty callbacks end, including absent fields ${JSON.stringify(speech)}`, async () => {
    const h = harness(); let xml = await h.run({ mode: '' });
    if (flow === 'info') xml = await nextTurn(h, xml, { digits: '2' });
    xml = await nextTurn(h, xml, { speech, digits: null, confidence: 'NaN' });
    assert.equal(h.open(xml).silence, 1);
    assert.match(xml, /mode=retry/);
    xml = await nextTurn(h, xml, { speech, digits: null, confidence: '0.01' });
    assert.match(xml, /<Hangup/);
    assert.equal(h.questions.length, 0);
  });
}
for (const speech of ['person', 'book an appointment', 'cancel my appointment', 'reschedule my appointment']) {
  test(`rejected intent cannot dispatch: ${speech}`, async () => {
    const h = harness({ handoffSettings: { is_enabled: true, human_transfer_phone: '+12025550999' } });
    const initial = await h.run({ mode: '' });
    for (const confidence of ['0.01', 'NaN', '-1', '2']) {
      const xml = await nextTurn(h, initial, { speech, confidence });
      assert.equal(h.open(xml).mode, 'menu');
      assert.doesNotMatch(xml, /<Dial/);
    }
    assert.equal(h.questions.length + h.serviceLoads.length + h.understandings.length + h.bookings.length, 0);
  });
}
for (const stateEnabled of [true, false]) {
  test(`menu alternating empty/noise ends with state=${stateEnabled}`, async () => {
    const h = harness({ stateEnabled }); let xml = await h.run({ mode: '' });
    for (const speech of ['', '...', '']) xml = await nextTurn(h, xml, { speech });
    assert.match(xml, /<Hangup/);
  });
  test(`unresolved info replies exhaust recovery with state=${stateEnabled}`, async () => {
    const h = harness({ stateEnabled }); let xml = await h.run({ mode: '' });
    for (let n = 0; n < 3; n++) xml = await nextTurn(h, xml, { speech: 'unrelated background conversation' });
    assert.match(xml, /<Hangup/);
    assert.equal(h.questions.length, 3);
  });
}
test('a real information answer with absent confidence resets recovery', async () => {
  const h = harness({ answerAvailable: true });
  let xml = await h.run({ mode: '' });
  xml = await nextTurn(h, xml, { speech: '...' });
  xml = await nextTurn(h, xml, { speech: 'what are your hours' });
  assert.equal(h.open(xml).recovery, 0);
  assert.equal(h.open(xml).mode, 'info');
  assert.match(said(xml), /Our hours/);
});

function bookingToken(h, stage) {
  const s = h.state.initialBookingState();
  s.turns = 4;
  Object.assign(s.booking, {
    stage, customerName: stage === 'name' ? null : 'BJ',
    serviceId: ['name', 'service'].includes(stage) ? null : HAIRCUT_ID,
    serviceName: ['name', 'service'].includes(stage) ? null : 'Haircut',
    date: ['name', 'service', 'date'].includes(stage) ? null : TOMORROW,
    requestedTime: stage === 'confirm' ? '13:00' : null,
    time: stage === 'confirm' ? '13:00' : null,
  });
  if (stage === 'period') { s.booking.stage = 'time'; s.booking.pendingTimeOptions = ['03:00', '15:00']; }
  return h.state.sealVoiceState(s, { businessId: BUSINESS_ID, callSid: CALL_SID, ingress: 'trial' });
}
const stageSpeech = { name: 'Banana', service: 'Facial', date: 'tomorrow', time: '3 PM', period: 'PM', confirm: 'yes' };
for (const [stage, speech] of Object.entries(stageSpeech)) {
  for (const confidence of ['0.01', 'NaN', '-1', '2']) test(`booking ${stage}: ${confidence} preserves slots and invokes no operations`, async () => {
    const h = harness(); const token = bookingToken(h, stage);
    const before = h.state.openVoiceState(token, { businessId: BUSINESS_ID, callSid: CALL_SID, ingress: 'trial' });
    const xml = await h.run({ speech, confidence, stateToken: token });
    assert.deepEqual(h.open(xml).booking, before.booking);
    assert.equal(h.open(xml).recovery, 1);
    assert.equal(h.serviceLoads.length + h.understandings.length + h.availabilityChecks.length + h.bookings.length, 0);
  });
  test(`booking ${stage}: alternating empty/punctuation/invalid digit ends without mutation`, async () => {
    const h = harness(); let xml = await h.run({ speech: '', stateToken: bookingToken(h, stage) });
    const before = JSON.stringify(h.open(xml).booking);
    xml = await nextTurn(h, xml, { speech: '...' });
    assert.equal(JSON.stringify(h.open(xml).booking), before);
    xml = await nextTurn(h, xml, { digits: '9' });
    assert.match(xml, /<Hangup/);
    assert.equal(h.serviceLoads.length + h.understandings.length + h.availabilityChecks.length + h.bookings.length, 0);
  });
}
for (const speech of ['no', 'cancel', 'actually make it 3 PM', 'person', 'yes']) {
  test(`booking confirmation rejects doubtful control/correction: ${speech}`, async () => {
    const h = harness(); const token = bookingToken(h, 'confirm');
    const before = h.state.openVoiceState(token, { businessId: BUSINESS_ID, callSid: CALL_SID, ingress: 'trial' }).booking;
    const xml = await h.run({ speech, confidence: '0.01', stateToken: token });
    assert.deepEqual(h.open(xml).booking, before);
    assert.match(said(xml), /Haircut for BJ/);
    assert.doesNotMatch(xml, /<Dial|<Hangup/);
    assert.equal(h.serviceLoads.length + h.understandings.length + h.availabilityChecks.length + h.bookings.length, 0);
  });
}
test('rejected confirmation re-presents the proposal before a fresh missing-confidence yes books', async () => {
  const h = harness();
  let xml = await h.run({ speech: 'yes', confidence: 'NaN', stateToken: bookingToken(h, 'confirm') });
  assert.match(said(xml), /Haircut for BJ.*1 PM/);
  xml = await nextTurn(h, xml, { speech: 'yes' });
  assert.equal(h.bookings.length, 1);
  assert.match(xml, /<Hangup/);
});
test('repeated ambiguous time consumes the shared recovery budget', async () => {
  const h = harness(); let xml = await h.run({ speech: '3', stateToken: bookingToken(h, 'time') });
  assert.equal(h.open(xml).recovery, 1);
  xml = await nextTurn(h, xml, { speech: '3' });
  assert.equal(h.open(xml).recovery, 2);
  xml = await nextTurn(h, xml, { speech: '3' });
  assert.match(xml, /<Hangup/);
  assert.equal(h.availabilityChecks.length + h.bookings.length, 0);
});
for (const reason of ['slot_unavailable', 'outside_hours', 'closed']) test(`repeated ${reason} is bounded despite slot extraction`, async () => {
  const h = harness({ availability: () => ({ available: false, reason }) });
  let xml = await h.run({ speech: 'tomorrow at 3 PM', stateToken: bookingToken(h, 'time') });
  xml = await nextTurn(h, xml, { speech: 'tomorrow at 3 PM' });
  xml = await nextTurn(h, xml, { speech: 'tomorrow at 3 PM' });
  assert.match(xml, /<Hangup/);
  assert.equal(h.bookings.length, 0);
});
test('menu to booking retains the call lifetime and total turns', async () => {
  const h = harness(); const s = h.state.initialVoiceState();
  s.turns = 25; s.expires -= 100000; s.recovery = 2;
  const token = h.state.sealVoiceState(s, { businessId: BUSINESS_ID, callSid: CALL_SID, ingress: 'trial' });
  const xml = await h.run({ speech: 'book an appointment', stateToken: token });
  assert.equal(h.open(xml).expires, s.expires);
  assert.equal(h.open(xml).turns, 26);
  assert.equal(h.open(xml).recovery, 0);
});
test('diagnostics cover rejected input and terminal state without sensitive values', async () => {
  const h = harness(); const token = bookingToken(h, 'confirm');
  const xml = await h.run({ speech: 'PRIVATE RECOGNITION', confidence: '0.01', stateToken: token });
  await nextTurn(h, xml, { speech: '', confidence: 'NaN' });
  await h.run({ speech: 'PRIVATE RECOGNITION', stateToken: 'invalid-token' });
  const events = h.logs.filter(x => x[0] === 'AnaAI voice turn').map(x => x[1]);
  assert.equal(events.length, 3);
  assert.equal(events[0].classification, 'rejected');
  assert.equal(events[0].before.stage, 'confirm');
  assert.equal(events[0].after.recovery, 1);
  assert.equal(events[1].classification, 'empty');
  assert.equal(events[2].outcome, 'hangup');
  const serialized = JSON.stringify(h.logs);
  for (const value of ['PRIVATE RECOGNITION', token, CALLER, CALL_SID, BUSINESS_ID, 'dummy-auth', 'invalid-token']) assert.ok(!serialized.includes(value), value);
});
for (const stage of ['menu', 'name', 'service', 'date', 'time', 'confirm', 'period']) test(`TwiML ${stage} retains exact Gather settings and no redirects`, async () => {
  const h = harness(); const xml = stage === 'menu' ? await h.run({ mode: '' }) : await h.run({ stateToken: bookingToken(h, stage) });
  assert.equal((xml.match(/<Gather\b/g) || []).length, 1);
  for (const attribute of ['input="speech dtmf"', 'numDigits="1"', 'timeout="6"', 'speechTimeout="2"', 'actionOnEmptyResult="true"', 'speechModel="experimental_conversations"', 'language="en-US"', 'method="POST"']) assert.ok(xml.includes(attribute), attribute);
  assert.doesNotMatch(xml, /<Redirect|bargeIn=/);
  assert.ok(stateOf(xml));
});

test('a callback missing encrypted state cannot reset the conversation budget', async () => {
  const h = harness();
  for (const mode of ['listen', 'retry', 'recovery-2-0']) {
    const xml = await h.run({ mode, speech: 'book an appointment' });
    assert.match(xml, /<Hangup/);
    assert.doesNotMatch(xml, /<Gather/);
  }
  assert.equal(h.questions.length + h.serviceLoads.length + h.understandings.length + h.bookings.length, 0);
});
for (const stateEnabled of [true, false]) test(`unavailable human handoff cannot reset recovery with state=${stateEnabled}`, async () => {
  const h = harness({ stateEnabled }); let xml = await h.run({ mode: '' });
  for (let n = 0; n < 3; n++) xml = await nextTurn(h, xml, { speech: 'person' });
  assert.match(xml, /<Hangup/);
  assert.equal(h.bookings.length, 0);
});
test('stateless unavailable booking cannot reset recovery', async () => {
  const h = harness({ stateEnabled: false }); let xml = await h.run({ mode: '' });
  for (let n = 0; n < 3; n++) xml = await nextTurn(h, xml, { speech: 'book an appointment' });
  assert.match(xml, /<Hangup/);
  assert.equal(h.bookings.length, 0);
});
