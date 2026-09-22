// Run: node --test tests/voice-capacity.test.cjs
//
// Static migration contracts plus a JS port of the capacity sweep exercised
// through the Voice availability and Voice booking result mappings. These do
// NOT execute PostgreSQL; see tests/voice-capacity.README.md for the database
// acceptance tests that must pass before deployment.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const checker = fs.readFileSync('supabase/migrations/202609210002_appointment_capacity_checker.sql', 'utf8');
const availability = fs.readFileSync('supabase/migrations/202609210004_voice_capacity_availability.sql', 'utf8');
const booking = fs.readFileSync('supabase/migrations/202609210005_voice_capacity_booking.sql', 'utf8');
const deployedAvailability = fs.readFileSync('supabase/migrations/202609160002_voice_availability_bridge.sql', 'utf8');
const deployedBooking = fs.readFileSync('supabase/migrations/202609190003_voice_customer_lifecycle.sql', 'utf8');
const manual = fs.readFileSync('supabase/migrations/202609210003_capacity_based_manual_scheduling.sql', 'utf8');

const code = (sql) =>
  sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*--.*$/gm, '');

// --------------------------------------------------------------------------
// Shared capacity port. Identical semantics to the port in
// tests/appointment-capacity.test.cjs; both must move together with the SQL.
// --------------------------------------------------------------------------
const ACTIVE = ['Booked', 'Confirmed'];
const MIN = (h, m = 0) => h * 60 + m;

const SERVICES = [
  { id: 'svc-30', name: 'Cut', duration_minutes: 30 },
  { id: 'svc-60', name: 'Colour', duration_minutes: 60 },
  { id: 'svc-null', name: 'Broken', duration_minutes: null },
];

let seq = 0;
function appt(time, serviceId, status = 'Booked', overrides = {}) {
  seq += 1;
  return {
    id: `appt-${seq}`,
    appointment_date: '2026-10-05',
    appointment_time: time,
    service_id: serviceId,
    service: SERVICES.find((s) => s.id === serviceId)?.name ?? null,
    status,
    ...overrides,
  };
}

function resolveDuration(appointment, services) {
  const byId = services.find((s) => s.id === appointment.service_id);
  if (byId) return byId.duration_minutes;
  const byName = services.filter(
    (s) => appointment.service != null && s.name.toLowerCase() === String(appointment.service).toLowerCase()
  );
  return byName.length === 1 ? byName[0].duration_minutes : null;
}

function checkCapacity({ capacity, appointments = [], services = SERVICES, start, duration, excludeId = null }) {
  if (capacity == null || capacity < 1) return 'INTERNAL_ERROR';
  if (start == null || duration == null || duration <= 0) return 'INVALID_SCHEDULE';

  const active = appointments
    .filter(
      (a) =>
        a.appointment_date === '2026-10-05' &&
        ACTIVE.includes(a.status) &&
        (excludeId === null || a.id !== excludeId)
    )
    .map((a) => ({ time: a.appointment_time, duration: resolveDuration(a, services) }));

  const usable = active.filter((a) => a.time != null && a.duration != null && a.duration > 0);
  if (active.length - usable.length > 0) return 'INVALID_EXISTING_SCHEDULE';

  const clipped = usable
    .map((a) => ({ s: a.time, e: a.time + a.duration }))
    .filter((i) => i.s < start + duration && i.e > start)
    .map((i) => ({ s: Math.max(i.s, start), e: Math.min(i.e, start + duration) }));

  const grouped = new Map();
  for (const i of clipped) {
    grouped.set(i.s, (grouped.get(i.s) || 0) + 1);
    grouped.set(i.e, (grouped.get(i.e) || 0) - 1);
  }

  let running = 0;
  let peak = 0;
  for (const at of [...grouped.keys()].sort((a, b) => a - b)) {
    running += grouped.get(at);
    if (running > peak) peak = running;
  }

  return peak >= capacity ? 'SLOT_CONFLICT' : 'AVAILABLE';
}

/*
 * The availability RPC's mapping of a helper result onto its own return shape,
 * transcribed from 202609210004.
 */
function voiceAvailability(input) {
  const result = checkCapacity(input);
  if (result === 'SLOT_CONFLICT') return { available: false, code: 'SLOT_CONFLICT' };
  if (result === 'INVALID_EXISTING_SCHEDULE') return { available: false, code: 'INVALID_EXISTING_SCHEDULE' };
  if (result !== 'AVAILABLE') return { available: false, code: 'INTERNAL_ERROR' };
  return { available: true, code: 'AVAILABLE' };
}

/* lib/voice-booking.ts checkVoiceAvailability's code -> reason mapping. */
function voiceReason(payload) {
  if (payload.available === true) return payload.code === 'AVAILABLE' ? 'available' : 'unverified';
  if (payload.code === 'SLOT_CONFLICT') return 'slot_unavailable';
  if (payload.code === 'CLOSED') return 'closed';
  if (payload.code === 'OUTSIDE_HOURS') return 'outside_hours';
  return 'unverified';
}

// --------------------------------------------------------------------------
// 13A: Voice availability capacity semantics (cases 1-10)
// --------------------------------------------------------------------------

test('1. capacity 1 rejects an overlapping candidate', () => {
  assert.deepEqual(
    voiceAvailability({ capacity: 1, appointments: [appt(MIN(16), 'svc-30')], start: MIN(16, 15), duration: 30 }),
    { available: false, code: 'SLOT_CONFLICT' }
  );
});

test('2. capacity 2 allows a second concurrent candidate', () => {
  assert.deepEqual(
    voiceAvailability({ capacity: 2, appointments: [appt(MIN(16), 'svc-30')], start: MIN(16), duration: 30 }),
    { available: true, code: 'AVAILABLE' }
  );
});

test('3. capacity 2 rejects a third concurrent candidate', () => {
  assert.deepEqual(
    voiceAvailability({
      capacity: 2,
      appointments: [appt(MIN(16), 'svc-30'), appt(MIN(16), 'svc-30')],
      start: MIN(16),
      duration: 30,
    }),
    { available: false, code: 'SLOT_CONFLICT' }
  );
});

for (const [n, status] of [[4, 'Booked'], [5, 'Confirmed']]) {
  test(`${n}. ${status} consumes capacity`, () => {
    assert.equal(
      voiceAvailability({
        capacity: 1,
        appointments: [appt(MIN(16), 'svc-30', status)],
        start: MIN(16),
        duration: 30,
      }).available,
      false
    );
  });
}

for (const [n, status] of [[6, 'Cancelled'], [7, 'Completed']]) {
  test(`${n}. ${status} does not consume capacity`, () => {
    assert.equal(
      voiceAvailability({
        capacity: 1,
        appointments: [appt(MIN(16), 'svc-30', status)],
        start: MIN(16),
        duration: 30,
      }).available,
      true
    );
  });
}

test('8. exact end/start boundary is available', () => {
  assert.equal(
    voiceAvailability({
      capacity: 1,
      appointments: [appt(MIN(16), 'svc-30')],
      start: MIN(16, 30),
      duration: 30,
    }).available,
    true
  );
});

test('9. peak back-to-back example: A 16:00-16:30, B 16:30-17:00, candidate 16:00-17:00 at capacity 2', () => {
  const appointments = [appt(MIN(16), 'svc-30'), appt(MIN(16, 30), 'svc-30')];
  assert.equal(
    voiceAvailability({ capacity: 2, appointments, start: MIN(16), duration: 60 }).available,
    true
  );
  // A naive overlap COUNT would be 2 and would reject.
  assert.equal(appointments.length, 2);
  assert.equal(
    voiceAvailability({ capacity: 1, appointments, start: MIN(16), duration: 60 }).available,
    false
  );
});

test('10. malformed active schedules fail closed, never available', () => {
  for (const row of [
    appt(null, 'svc-30'),
    appt(MIN(16), 'svc-missing', 'Booked', { service: 'Nope' }),
    appt(MIN(16), 'svc-null'),
  ]) {
    assert.deepEqual(
      voiceAvailability({ capacity: 5, appointments: [row], start: MIN(16), duration: 30 }),
      { available: false, code: 'INVALID_EXISTING_SCHEDULE' }
    );
  }
});

test('the deployed NULL appointment_time fail-open is corrected', () => {
  // The replaced loop compared against a NULL timestamp, which is neither
  // true nor false, so the row was skipped and the slot looked free.
  assert.match(deployedAvailability, /v_requested_start < v_existing_end\s+and v_requested_end > v_existing_start/);
  assert.doesNotMatch(code(availability), /v_existing_start|v_existing_end|for v_existing in/);
  assert.equal(
    voiceAvailability({ capacity: 1, appointments: [appt(null, 'svc-30')], start: MIN(16), duration: 30 }).code,
    'INVALID_EXISTING_SCHEDULE'
  );
});

test('the deployed ambiguous service-name fallback is corrected', () => {
  // `limit 1` silently picked one duration among same-named services.
  assert.match(deployedAvailability, /lower\(s\.name\) = lower\(v_existing\.service\)\s+limit 1;/);
  const ambiguous = [
    { id: 'a1', name: 'Trim', duration_minutes: 30 },
    { id: 'a2', name: 'trim', duration_minutes: 60 },
  ];
  assert.equal(
    voiceAvailability({
      capacity: 5,
      services: ambiguous,
      appointments: [appt(MIN(16), 'gone', 'Booked', { service: 'Trim' })],
      start: MIN(16),
      duration: 30,
    }).code,
    'INVALID_EXISTING_SCHEDULE'
  );
});

test('availability reason mapping consumed by lib/voice-booking.ts is unchanged', () => {
  assert.equal(voiceReason({ available: true, code: 'AVAILABLE' }), 'available');
  assert.equal(voiceReason({ available: false, code: 'SLOT_CONFLICT' }), 'slot_unavailable');
  assert.equal(voiceReason({ available: false, code: 'CLOSED' }), 'closed');
  assert.equal(voiceReason({ available: false, code: 'OUTSIDE_HOURS' }), 'outside_hours');
  // Every unrecognised code, including the new INTERNAL_ERROR path, fails closed.
  assert.equal(voiceReason({ available: false, code: 'INVALID_EXISTING_SCHEDULE' }), 'unverified');
  assert.equal(voiceReason({ available: false, code: 'INTERNAL_ERROR' }), 'unverified');
});

// --------------------------------------------------------------------------
// 13A: availability SQL contract
// --------------------------------------------------------------------------

test('availability keeps its signature, SECURITY DEFINER and service_role-only grant', () => {
  assert.match(
    availability,
    /create or replace function public\.voice_check_appointment_availability\(\s*p_business_id uuid,\s*p_service_id uuid,\s*p_appointment_date date,\s*p_appointment_time time without time zone\s*\)/
  );
  assert.match(code(availability), /^\s*security definer$/m);
  assert.match(code(availability), /^\s*stable$/m);
  assert.match(availability, /set search_path = pg_catalog, public/);
  assert.match(
    availability,
    /revoke all on function public\.voice_check_appointment_availability\([^)]*\) from public, anon, authenticated;/
  );
  assert.match(
    availability,
    /grant execute on function public\.voice_check_appointment_availability\([^)]*\) to service_role;/
  );
  assert.doesNotMatch(code(availability), /\bto\s+(authenticated|anon|public)\b/);
});

test('availability calls the private helper schema-qualified and never mutates', () => {
  assert.match(availability, /anaai_private\.check_appointment_capacity_business\(/);
  assert.doesNotMatch(code(availability), /\b(insert into|update public\.|delete from)\b/i);
  assert.doesNotMatch(code(availability), /pg_advisory/);
  assert.doesNotMatch(code(availability), /create schema|grant .*anaai_private|search_path = .*anaai_private/i);
});

test('availability preserves every pre-existing validation and result code', () => {
  for (const check of [
    "'INVALID_REQUEST'",
    "'BUSINESS_NOT_FOUND'",
    "'INVALID_SERVICE'",
    "'INVALID_DURATION'",
    "'INVALID_HOURS'",
    "'CLOSED'",
    "'OUTSIDE_HOURS'",
    "'SLOT_CONFLICT'",
    "'INVALID_EXISTING_SCHEDULE'",
    "'AVAILABLE'",
    "'INTERNAL_ERROR'",
  ]) {
    assert.ok(availability.includes(check), `${check} missing`);
    assert.ok(deployedAvailability.includes(check) || check === "'INTERNAL_ERROR'", `${check} is not a deployed code`);
  }
  // Business-local arithmetic only.
  assert.doesNotMatch(code(availability), /timestamptz|at time zone|now\(\)|current_date/i);
  assert.match(availability, /order by bp\.created_at desc\s+limit 1;/);
});

test('availability checks hours before capacity and never reports free on an unknown result', () => {
  // Ordering is read from statement text only; header prose must not count.
  const body = code(availability);
  const hours = body.indexOf("'OUTSIDE_HOURS'");
  const capacity = body.indexOf('anaai_private.check_appointment_capacity_business');
  const ok = body.indexOf("'available', true");
  assert.ok(hours > 0 && hours < capacity && capacity < ok);
  assert.match(
    availability,
    /if v_capacity is distinct from 'AVAILABLE' then\s+return jsonb_build_object\(\s*'available', false,\s*'code', 'INTERNAL_ERROR'/
  );
});

// --------------------------------------------------------------------------
// 13B: authoritative Voice booking capacity (cases 11-20)
// --------------------------------------------------------------------------

test('11. capacity 1 overlap is rejected by the authoritative booking', () => {
  assert.equal(
    checkCapacity({ capacity: 1, appointments: [appt(MIN(16), 'svc-30')], start: MIN(16, 15), duration: 30 }),
    'SLOT_CONFLICT'
  );
});

test('12. capacity 2 allows the second booking', () => {
  assert.equal(
    checkCapacity({ capacity: 2, appointments: [appt(MIN(16), 'svc-30')], start: MIN(16), duration: 30 }),
    'AVAILABLE'
  );
});

test('13. capacity 2 rejects the third booking', () => {
  assert.equal(
    checkCapacity({
      capacity: 2,
      appointments: [appt(MIN(16), 'svc-30'), appt(MIN(16), 'svc-30')],
      start: MIN(16),
      duration: 30,
    }),
    'SLOT_CONFLICT'
  );
});

test('14. exact boundary books', () => {
  assert.equal(
    checkCapacity({ capacity: 1, appointments: [appt(MIN(16), 'svc-30')], start: MIN(16, 30), duration: 30 }),
    'AVAILABLE'
  );
});

test('15. peak back-to-back example books at capacity 2', () => {
  assert.equal(
    checkCapacity({
      capacity: 2,
      appointments: [appt(MIN(16), 'svc-30'), appt(MIN(16, 30), 'svc-30')],
      start: MIN(16),
      duration: 60,
    }),
    'AVAILABLE'
  );
});

test('16. malformed active schedule fails the authoritative booking closed', () => {
  assert.equal(
    checkCapacity({ capacity: 9, appointments: [appt(null, 'svc-30')], start: MIN(16), duration: 30 }),
    'INVALID_EXISTING_SCHEDULE'
  );
});

test('17. the advisory lock is taken before the capacity decision and any mutation', () => {
  const body = code(booking);
  const lock = body.indexOf('pg_advisory_xact_lock');
  const capacity = body.indexOf('anaai_private.check_appointment_capacity_business');
  const customerRead = body.indexOf('select c.id');
  const customerWrite = body.indexOf('insert into public.customers');
  const appointmentWrite = body.indexOf('insert into public.appointments');
  assert.ok(lock > 0, 'advisory lock present');
  assert.ok(lock < capacity, 'lock precedes the capacity decision');
  assert.ok(capacity < customerRead, 'capacity precedes customer resolution');
  assert.ok(capacity < customerWrite, 'capacity precedes customer creation');
  assert.ok(capacity < appointmentWrite, 'capacity precedes appointment creation');
  // Identical lock expression to manual scheduling: both serialize together.
  assert.match(booking, /hashtext\(p_business_id::text \|\| ':' \|\| p_appointment_date::text\)/);
  assert.match(manual, /hashtext\(\s*p_business_id::text\s*\|\|\s*':'\s*\|\|\s*p_appointment_date::text\s*\)/);
});

test('18. durable idempotency is unchanged and still claimed before the lock', () => {
  const body = code(booking);
  const claim = body.indexOf('insert into public.appointment_actions');
  const replay = body.indexOf("jsonb_build_object('replayed', true)");
  const lock = body.indexOf('pg_advisory_xact_lock');
  assert.ok(claim > 0 && claim < replay && replay < lock);
  assert.match(booking, /on conflict \(business_id, idempotency_key\) do nothing/);
  assert.match(booking, /'IDEMPOTENCY_CONFLICT'/);
  assert.match(booking, /'ACTION_INCOMPLETE'/);
  assert.match(booking, /v_action\.request_payload is distinct from v_request/);
  assert.match(booking, /current_setting\('transaction_isolation'\) <> 'read committed'/);
});

test('19. customer reuse is unchanged', () => {
  assert.match(booking, /where c\.business_id = p_business_id\s+and c\.phone = btrim\(p_customer_phone\)/);
  assert.match(booking, /order by\s+c\.is_active desc,\s+c\.created_at asc\s+limit 1;/);
});

test('20. archived customer reactivation is unchanged', () => {
  assert.match(booking, /update public\.customers\s+set\s+full_name = btrim\(p_customer_name\),\s+email = v_email,\s+is_active = true/);
  assert.match(booking, /'Created by AnaAI phone booking'/);
});

test('a capacity rejection does not touch customer state', () => {
  const body = code(booking);
  const capacity = body.indexOf('anaai_private.check_appointment_capacity_business');
  const guard = body.indexOf('if v_receipt is null then', capacity);
  const customerWrite = body.indexOf('insert into public.customers');
  assert.ok(capacity < guard && guard < customerWrite);
  // The customer block only runs while no rejection receipt has been produced.
  assert.match(body.slice(capacity, customerWrite), /if v_receipt is null then/);
});

test('booking keeps its signature, SECURITY DEFINER and service_role-only grant', () => {
  assert.match(
    booking,
    /create or replace function public\.voice_book_appointment_business\(\s*p_business_id uuid,\s*p_idempotency_key uuid,\s*p_request_fingerprint text,\s*p_customer_name text,\s*p_customer_phone text,\s*p_customer_email text,\s*p_service_id uuid,\s*p_appointment_date date,\s*p_appointment_time time without time zone,\s*p_notes text default null\s*\)/
  );
  assert.match(code(booking), /^\s*security definer$/m);
  assert.match(booking, /set search_path = pg_catalog, public/);
  assert.match(
    booking,
    /revoke all on function public\.voice_book_appointment_business\([\s\S]*?\) from public, anon, authenticated;/
  );
  assert.match(
    booking,
    /grant execute on function public\.voice_book_appointment_business\([\s\S]*?\) to service_role;/
  );
  assert.doesNotMatch(code(booking), /\bto\s+(authenticated|anon|public)\b/);
});

test('booking preserves status, receipt, notification and lifecycle behaviour', () => {
  assert.match(booking, /'Booked',/);
  assert.doesNotMatch(code(booking), /status = 'Confirmed'|status = 'Completed'|status = 'Cancelled'/);
  assert.match(booking, /'receipt_scope', 'action_outcome'/);
  assert.match(booking, /insert into public\.appointment_notifications/);
  assert.match(booking, /'notification_kind'|'confirmation'/);
  assert.match(booking, /raise exception 'invalid voice booking receipt'/);
  // A phone action is never attributed to a user account.
  assert.match(booking, /actor_user_id,[\s\S]{0,400}?values \(\s*p_business_id,\s*null,/);
  // Appointment scheduling arithmetic stays business-local; only the action
  // ledger's completed_at is a timestamptz, exactly as deployed.
  assert.doesNotMatch(code(booking), /at time zone/i);
  assert.equal((code(booking).match(/timestamptz/g) || []).length, 1);
  assert.match(deployedBooking, /completed_at'\)::timestamptz/);
});

test('the inline overlap loop is gone from both Voice functions', () => {
  for (const [label, sql] of [['availability', availability], ['booking', booking]]) {
    assert.doesNotMatch(code(sql), /for v_existing in/, label);
    assert.doesNotMatch(code(sql), /v_existing_duration/, label);
    assert.doesNotMatch(code(sql), /v_requested_start < v_existing_end/, label);
  }
  // The deployed versions being replaced did contain them.
  assert.match(deployedAvailability, /for v_existing in/);
  assert.match(deployedBooking, /for v_existing in/);
});

// --------------------------------------------------------------------------
// Capacity security
// --------------------------------------------------------------------------

test('the capacity helper stays private and is never granted to browser roles', () => {
  assert.match(checker, /create or replace function anaai_private\.check_appointment_capacity_business\(/);
  assert.doesNotMatch(checker, /create or replace function public\.check_appointment_capacity_business/);
  assert.match(checker, /revoke all on schema anaai_private from public;/);
  assert.match(
    checker,
    /revoke all on function anaai_private\.check_appointment_capacity_business\([^)]*\) from public, anon;/
  );
  // No Voice migration may relocate, re-grant or expose the helper.
  for (const [label, sql] of [['availability', availability], ['booking', booking]]) {
    assert.doesNotMatch(code(sql), /grant[^;]*check_appointment_capacity_business/i, label);
    assert.doesNotMatch(code(sql), /create schema|alter schema|alter (table|policy)|drop policy/i, label);
    assert.doesNotMatch(code(sql), /row level security/i, label);
  }
});

test('no Voice capacity authority exists in browser or API code', () => {
  for (const file of [
    'lib/voice-booking.ts',
    'lib/voice-handler.ts',
    'lib/voice-slots.ts',
    'app/appointments/page.tsx',
    'app/business/page.tsx',
  ]) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /appointment_capacity|check_appointment_capacity_business|anaai_private/, file);
  }
});

test('Voice still reaches the database only through the two service_role RPCs', () => {
  const source = fs.readFileSync('lib/voice-booking.ts', 'utf8');
  const rpcs = [...source.matchAll(/db\.rpc\(\s*\n?\s*"([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(rpcs)].sort(),
    [
      'voice_book_appointment_business',
      'voice_check_appointment_availability',
      'voice_claim_appointment_notification',
      'voice_finish_appointment_notification',
    ]
  );
  assert.match(source, /createSupabaseServiceClient/);
});
