// Run: node --test tests/legacy-ai-capacity.test.cjs
//
// Capacity semantics for the legacy AI-chat booking path,
// public.book_appointment_atomic_business (migration 202609210006).
//
// This function is not defined anywhere else in the repository: 202609210006
// restates its deployed body verbatim with only the per-appointment overlap
// loop replaced. These tests therefore do two jobs -- prove the capacity
// algorithm, and pin every deployed behaviour the migration promised to
// preserve, so a future edit cannot quietly drift from the deployed contract.
//
// No PostgreSQL is executed. See tests/appointment-capacity.README.md for the
// database acceptance tests required before deployment.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const legacy = fs.readFileSync('supabase/migrations/202609210006_capacity_based_legacy_ai_booking.sql', 'utf8');
const checker = fs.readFileSync('supabase/migrations/202609210002_appointment_capacity_checker.sql', 'utf8');
const manual = fs.readFileSync('supabase/migrations/202609210003_capacity_based_manual_scheduling.sql', 'utf8');
const voiceBooking = fs.readFileSync('supabase/migrations/202609210005_voice_capacity_booking.sql', 'utf8');
const wrapper = fs.readFileSync('supabase/migrations/202609150004_classify_ai_booking_rejections.sql', 'utf8');

/* Statement text with prose removed, so ordering and absence assertions
 * cannot be satisfied or defeated by a comment. */
const code = (sql) =>
  sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*--.*$/gm, '');

const body = code(legacy);

// --------------------------------------------------------------------------
// Capacity port. Same semantics as the ports in appointment-capacity and
// voice-capacity; all three must move together with the SQL.
// --------------------------------------------------------------------------
const ACTIVE = ['Booked', 'Confirmed'];
const MIN = (h, m = 0) => h * 60 + m;
const DATE = '2026-10-05';

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
    appointment_date: DATE,
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

function checkCapacity({ capacity, appointments = [], services = SERVICES, start, duration }) {
  if (capacity == null || capacity < 1) return 'INTERNAL_ERROR';
  if (start == null || duration == null || duration <= 0) return 'INVALID_SCHEDULE';

  const active = appointments
    .filter((a) => a.appointment_date === DATE && ACTIVE.includes(a.status))
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

const CONFLICT = 'That time overlaps an existing appointment.';
const MALFORMED =
  'An existing appointment does not have a valid service duration, so availability cannot be checked safely.';

/* This function's mapping of a helper result onto its legacy response,
 * transcribed from 202609210006. A raise is modelled as a thrown error,
 * which is what reaches the 150004 wrapper's handler. */
function legacyBooking(input) {
  const result = checkCapacity(input);
  if (result === 'SLOT_CONFLICT') return { success: false, reason: CONFLICT };
  if (result === 'INVALID_EXISTING_SCHEDULE') return { success: false, reason: MALFORMED };
  if (result !== 'AVAILABLE') throw new Error('legacy capacity check unavailable');
  return { success: true, booked: true };
}

// --------------------------------------------------------------------------
// 1-6. The deployed contract this migration promised to preserve
// --------------------------------------------------------------------------

test('1. the exact deployed signature is restated', () => {
  assert.match(
    legacy,
    /create or replace function public\.book_appointment_atomic_business\(\s*p_business_id uuid,\s*p_customer_name text,\s*p_customer_phone text,\s*p_customer_email text,\s*p_service_id uuid,\s*p_appointment_date date,\s*p_appointment_time time without time zone,\s*p_notes text default null::text\s*\)\s*returns jsonb/
  );
  // A different argument list would create a SECOND overload rather than
  // replacing the deployed function, leaving the old one reachable.
  assert.equal((body.match(/create or replace function/g) || []).length, 1);
});

test('2. SECURITY INVOKER is preserved and never becomes SECURITY DEFINER', () => {
  assert.match(body, /^\s*security invoker$/m);
  assert.doesNotMatch(body, /security definer/i);
  // Converting this to definer would let anon reach the private helper and
  // bypass RLS on customers and appointments.
  for (const [label, sql] of [['manual', manual]]) {
    assert.match(code(sql), /security invoker/, label);
  }
});

test('3. search_path is preserved exactly as deployed', () => {
  assert.match(body, /set search_path to 'public'/);
  // NOT the pg_catalog, public form used elsewhere: changing it is separate
  // hardening work that 202609150004 already recorded as outstanding.
  assert.doesNotMatch(body, /search_path = pg_catalog/);
});

test('4. the auth.uid() check is preserved and precedes everything else', () => {
  assert.match(body, /v_user_id := auth\.uid\(\);/);
  assert.match(body, /'reason', 'Authentication is required\.'/);
  const auth = body.indexOf('auth.uid()');
  assert.ok(auth > 0);
  assert.ok(auth < body.indexOf('is_business_member'), 'auth precedes membership');
  assert.ok(auth < body.indexOf('pg_advisory_xact_lock'), 'auth precedes the lock');
});

test('4b. the auth guard runs before the capacity helper, which anon cannot execute', () => {
  // anon holds EXECUTE on this function but NOT on the helper. If the helper
  // were reachable before the auth guard, an unauthenticated caller would get
  // a raw permission error instead of the allowlisted reason string.
  assert.ok(body.indexOf('auth.uid()') < body.indexOf('anaai_private.'));
  assert.doesNotMatch(checker, /to\s+anon\b/);
});

test('5. the business membership check is preserved verbatim', () => {
  assert.match(body, /if not public\.is_business_member\(p_business_id\) then/);
  assert.match(body, /'reason', 'You do not have access to this business\.'/);
  assert.ok(
    body.indexOf('is_business_member') < body.indexOf('anaai_private.'),
    'membership is validated before any capacity work'
  );
});

test('6. the business/date advisory lock is byte-identical to every other path', () => {
  const lock = /hashtext\(\s*p_business_id::text\s*\|\|\s*':'\s*\|\|\s*p_appointment_date::text\s*\)/;
  assert.match(body, lock);
  assert.match(code(manual), lock);
  assert.match(code(voiceBooking), lock);
  assert.equal((body.match(/pg_advisory_xact_lock/g) || []).length, 1);
});

// --------------------------------------------------------------------------
// 7-8. Ordering: after the lock, before any mutation
// --------------------------------------------------------------------------

test('7. capacity is evaluated only after the advisory lock and full interval validation', () => {
  const lock = body.indexOf('pg_advisory_xact_lock');
  const service = body.indexOf('from public.services s');
  const hours = body.indexOf('from public.business_profiles bp');
  const closing = body.indexOf('would finish after closing time');
  const capacity = body.indexOf('anaai_private.check_appointment_capacity_business');

  assert.ok(lock > 0 && lock < service, 'lock precedes service lookup');
  assert.ok(service < hours && hours < closing, 'validation order preserved');
  assert.ok(closing < capacity, 'the whole candidate interval is validated first');
});

test('8. capacity is evaluated before any customer or appointment mutation', () => {
  const capacity = body.indexOf('anaai_private.check_appointment_capacity_business');
  const customerRead = body.indexOf('from public.customers c');
  const customerInsert = body.indexOf('insert into public.customers');
  const customerUpdate = body.indexOf('update public.customers');
  const appointmentInsert = body.indexOf('insert into public.appointments');

  for (const [label, index] of [
    ['customer lookup', customerRead],
    ['customer insert', customerInsert],
    ['customer update', customerUpdate],
    ['appointment insert', appointmentInsert],
  ]) {
    assert.ok(index > 0, `${label} present`);
    assert.ok(capacity < index, `capacity precedes ${label}`);
  }
});

// --------------------------------------------------------------------------
// 9-18. Capacity semantics
// --------------------------------------------------------------------------

test('9. capacity 1 rejects an overlapping appointment', () => {
  assert.deepEqual(
    legacyBooking({ capacity: 1, appointments: [appt(MIN(16), 'svc-30')], start: MIN(16, 15), duration: 30 }),
    { success: false, reason: CONFLICT }
  );
});

test('9b. capacity 1 preserves the previous single-overlap behaviour across a swept grid', () => {
  const existing = [appt(MIN(16), 'svc-30'), appt(MIN(17), 'svc-60')];
  const intervals = existing.map((a) => ({
    s: a.appointment_time,
    e: a.appointment_time + SERVICES.find((x) => x.id === a.service_id).duration_minutes,
  }));
  for (let start = MIN(14); start <= MIN(20); start += 5) {
    for (const duration of [15, 30, 45, 60, 90]) {
      const overlaps = intervals.some((i) => start < i.e && start + duration > i.s);
      assert.equal(
        legacyBooking({ capacity: 1, appointments: existing, start, duration }).success,
        !overlaps,
        `start=${start} duration=${duration}`
      );
    }
  }
});

test('10. capacity 2 allows a second concurrent booking', () => {
  assert.equal(
    legacyBooking({ capacity: 2, appointments: [appt(MIN(16), 'svc-30')], start: MIN(16), duration: 30 }).success,
    true
  );
});

test('11. capacity 2 rejects a third concurrent booking', () => {
  assert.deepEqual(
    legacyBooking({
      capacity: 2,
      appointments: [appt(MIN(16), 'svc-30'), appt(MIN(16), 'svc-30')],
      start: MIN(16),
      duration: 30,
    }),
    { success: false, reason: CONFLICT }
  );
});

for (const [n, status] of [[12, 'Booked'], [13, 'Confirmed']]) {
  test(`${n}. ${status} consumes capacity`, () => {
    assert.equal(
      legacyBooking({
        capacity: 1,
        appointments: [appt(MIN(16), 'svc-30', status)],
        start: MIN(16),
        duration: 30,
      }).success,
      false
    );
  });
}

for (const [n, status] of [[14, 'Cancelled'], [15, 'Completed']]) {
  test(`${n}. ${status} does not consume capacity`, () => {
    assert.equal(
      legacyBooking({
        capacity: 1,
        appointments: [appt(MIN(16), 'svc-30', status)],
        start: MIN(16),
        duration: 30,
      }).success,
      true
    );
    // Not even when its own schedule is unusable.
    assert.equal(
      legacyBooking({
        capacity: 1,
        appointments: [appt(null, 'svc-30', status)],
        start: MIN(16),
        duration: 30,
      }).success,
      true
    );
  });
}

test('16. an exact end/start boundary does not overlap', () => {
  assert.equal(
    legacyBooking({ capacity: 1, appointments: [appt(MIN(16), 'svc-30')], start: MIN(16, 30), duration: 30 }).success,
    true
  );
  assert.equal(
    legacyBooking({ capacity: 1, appointments: [appt(MIN(16, 30), 'svc-30')], start: MIN(16), duration: 30 }).success,
    true
  );
  // One minute of real overlap still conflicts.
  assert.equal(
    legacyBooking({ capacity: 1, appointments: [appt(MIN(16), 'svc-30')], start: MIN(16, 29), duration: 30 }).success,
    false
  );
});

test('17. peak concurrency: A 16:00-16:30, B 16:30-17:00, candidate 16:00-17:00 at capacity 2', () => {
  const appointments = [appt(MIN(16), 'svc-30'), appt(MIN(16, 30), 'svc-30')];
  assert.equal(legacyBooking({ capacity: 2, appointments, start: MIN(16), duration: 60 }).success, true);
  // A naive overlap COUNT would be 2 and would wrongly reject.
  assert.equal(appointments.length, 2);
  assert.equal(legacyBooking({ capacity: 1, appointments, start: MIN(16), duration: 60 }).success, false);
  // Genuinely stacked appointments still reject at capacity 2.
  assert.equal(
    legacyBooking({
      capacity: 2,
      appointments: [appt(MIN(16), 'svc-30'), appt(MIN(16, 15), 'svc-60')],
      start: MIN(16),
      duration: 60,
    }).success,
    false
  );
});

test('18. malformed existing active schedules fail closed', () => {
  for (const row of [
    appt(null, 'svc-30'),
    appt(MIN(16), 'svc-missing', 'Booked', { service: 'Nope' }),
    appt(MIN(16), 'svc-missing', 'Booked', { service: null }),
    appt(MIN(16), 'svc-null'),
  ]) {
    assert.deepEqual(
      legacyBooking({ capacity: 9, appointments: [row], start: MIN(16), duration: 30 }),
      { success: false, reason: MALFORMED }
    );
  }
});

test('18b. an indeterminate capacity result raises instead of booking', () => {
  // No allowlisted legacy reason exists for this, and the function has no
  // exception handler, so the raise reaches the 150004 wrapper's handler and
  // rolls the whole invocation back.
  assert.throws(
    () => legacyBooking({ capacity: null, start: MIN(16), duration: 30 }),
    /legacy capacity check unavailable/
  );
  assert.match(body, /if v_capacity is distinct from 'AVAILABLE' then\s+raise exception 'legacy capacity check unavailable';/);
  // The two deployed `when others` handlers are INNER blocks around the
  // business-hours parse and the open/close cast, and both return before the
  // capacity check. What matters is that the function has no top-level
  // handler, so nothing between the capacity raise and `end` can swallow it.
  assert.equal((body.match(/when others/g) || []).length, 2, 'only the two deployed inner handlers');
  const afterCapacity = body.slice(body.indexOf("raise exception 'legacy capacity check unavailable'"));
  assert.doesNotMatch(afterCapacity, /when others/i, 'nothing catches it downstream');
  assert.match(wrapper, /exception when others then[\s\S]{0,120}'INTERNAL_ERROR'/);
});

// --------------------------------------------------------------------------
// The legacy rejection contract required by 202609150004
// --------------------------------------------------------------------------

test('both capacity rejections use strings the wrapper allowlists', () => {
  for (const reason of [CONFLICT, MALFORMED]) {
    assert.ok(body.includes(`'reason', '${reason}'`), `006 returns: ${reason}`);
    assert.ok(wrapper.includes(`when '${reason}' then`), `150004 allowlists: ${reason}`);
  }
  // An unrecognised string would raise 'unknown legacy rejection'.
  assert.match(wrapper, /if v_rejection_code is null then raise exception 'unknown legacy rejection'/);
});

test('every rejection object carries exactly success and reason', () => {
  // 150004 rejects any other shape with 'malformed legacy rejection'.
  assert.match(wrapper, /\(v_result - 'success' - 'reason'\) <> '\{\}'::jsonb/);
  const rejections = [...body.matchAll(/jsonb_build_object\(\s*'success', false,([\s\S]*?)\);/g)];
  assert.ok(rejections.length >= 14, 'all rejection paths inspected');
  for (const [, tail] of rejections) {
    const keys = [...tail.matchAll(/'([a-z_]+)',/g)].map((m) => m[1]);
    assert.deepEqual(keys, ['reason'], `unexpected keys: ${keys}`);
  }
});

test('every deployed reason string survives unchanged', () => {
  for (const reason of [
    'Authentication is required.',
    'Business context is required.',
    'You do not have access to this business.',
    'Customer name is required.',
    'Customer phone number is required.',
    'Service is required.',
    'Appointment date is required.',
    'Appointment time is required.',
    'The selected service could not be found.',
    'The selected service does not have a valid duration.',
    'Business hours have not been configured.',
    'Business hours are not stored in a valid format.',
    'Business hours are not configured for that day.',
    'The business is closed on that day.',
    'Business hours for that day are invalid.',
    'The requested appointment starts before opening time.',
    'The requested appointment would finish after closing time.',
  ]) {
    assert.ok(body.includes(`'${reason}'`), `missing: ${reason}`);
    assert.ok(wrapper.includes(`'${reason}'`), `not allowlisted: ${reason}`);
  }
});

// --------------------------------------------------------------------------
// 19-20. Customer and appointment behaviour preserved verbatim
// --------------------------------------------------------------------------

test('19. customer lookup, reuse, creation and update are preserved', () => {
  // Business-scoped trimmed phone, oldest first. NOT the Voice function's
  // is_active-first ordering, and no archived-customer reactivation here.
  assert.match(
    body,
    /from public\.customers c\s+where c\.business_id = p_business_id\s+and c\.phone = trim\(p_customer_phone\)\s+order by c\.created_at asc\s+limit 1;/
  );
  // The customer block has no is_active handling at all: unlike the Voice
  // booking RPC this path neither filters nor reactivates archived customers.
  // (`s.is_active` in the service lookup above is deployed behaviour.)
  const customerBlock = body.slice(
    body.indexOf('from public.customers c'),
    body.indexOf('insert into public.appointments')
  );
  assert.doesNotMatch(customerBlock, /is_active/);
  assert.match(body, /and s\.is_active = true/, 'the deployed service filter stays');

  assert.match(body, /insert into public\.customers \(\s*business_id,\s*user_id,\s*full_name,\s*phone,\s*email,\s*notes\s*\)/);
  assert.match(body, /'Created by AnaAI booking'/);
  assert.match(body, /update public\.customers\s+set\s+full_name = trim\(p_customer_name\),\s+email = nullif\(/);
  assert.match(body, /where id = v_customer_id\s+and business_id = p_business_id;/);
});

test('20. the appointment insert and the success receipt are preserved', () => {
  assert.match(
    body,
    /insert into public\.appointments \(\s*business_id,\s*user_id,\s*customer_id,\s*service_id,\s*customer_name,\s*customer_phone,\s*customer_email,\s*service,\s*appointment_date,\s*appointment_time,\s*status,\s*notes\s*\)/
  );
  assert.match(body, /'Booked',/);
  assert.match(body, /'Booked by AnaAI'/);
  // user_id is the authenticated member on both the customer and the row.
  assert.equal((body.match(/v_user_id,/g) || []).length, 2);

  const receipt = body.slice(body.lastIndexOf('return jsonb_build_object('));
  for (const key of [
    'success', 'appointment_id', 'customer_id', 'customer_name', 'customer_phone',
    'service', 'service_id', 'business_id', 'date', 'time', 'status',
  ]) {
    assert.ok(receipt.includes(`'${key}'`), `receipt key missing: ${key}`);
  }
  // The wrapper reads appointment_id, then re-reads the authoritative row.
  assert.match(wrapper, /v_result ->> 'appointment_id'/);
});

test('the per-appointment overlap loop is gone and not duplicated anywhere', () => {
  assert.doesNotMatch(body, /for v_existing in/);
  for (const name of ['v_existing', 'v_existing_duration', 'v_existing_start', 'v_existing_end']) {
    assert.doesNotMatch(body, new RegExp(`\\b${name}\\b`), `${name} should be removed`);
  }
  assert.doesNotMatch(body, /v_requested_start < v_existing_end/);
  // The capacity algorithm lives only in the helper.
  assert.doesNotMatch(body, /make_interval\(mins => v_existing/);
  assert.equal((body.match(/anaai_private\.check_appointment_capacity_business/g) || []).length, 1);
  // v_requested_end is still needed for the closing-time check.
  assert.match(body, /v_requested_end >\s+\(p_appointment_date::timestamp \+ v_close_time\)/);
});

// --------------------------------------------------------------------------
// 21-23. Capacity security
// --------------------------------------------------------------------------

test('21. the helper remains private and is called schema-qualified', () => {
  assert.match(checker, /create or replace function anaai_private\.check_appointment_capacity_business\(/);
  assert.doesNotMatch(checker, /create or replace function public\.check_appointment_capacity_business/);
  // search_path is 'public' only, so the qualification is what resolves it.
  assert.match(body, /anaai_private\.check_appointment_capacity_business\(/);
  assert.doesNotMatch(body, /search_path[^\n]*anaai_private/);
});

test('22. no grant is added, and none to public or anon', () => {
  assert.doesNotMatch(body, /\bgrant\b/i, 'CREATE OR REPLACE preserves the existing ACL');
  assert.doesNotMatch(body, /\brevoke\b/i);
  assert.doesNotMatch(body, /create schema|alter schema|alter (table|policy)|drop policy|row level security/i);
  // The helper's own grants are unchanged and still exclude anon.
  assert.match(checker, /revoke all on function anaai_private\.check_appointment_capacity_business\([^)]*\) from public, anon;/);
  assert.doesNotMatch(checker, /grant\s+(execute|usage)[^;]*to[^;]*\banon\b/i);
});

test('23. no capacity authority exists in browser or API code', () => {
  for (const file of [
    'server/handlers/ai.ts',
    'server/handlers/appointments.ts',
    'app/appointments/page.tsx',
    'app/business/page.tsx',
    'lib/ai-actions.ts',
  ]) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(
      source,
      /appointment_capacity|check_appointment_capacity_business|anaai_private/,
      file
    );
  }
});

test('the AI path still reaches the database only through the idempotent wrapper', () => {
  const route = fs.readFileSync('server/handlers/ai.ts', 'utf8');
  assert.match(route, /rpc\("schedule_appointment_idempotent_business"/);
  assert.doesNotMatch(route, /rpc\(\s*"book_appointment_atomic_business"/);
  assert.match(wrapper, /v_result := public\.book_appointment_atomic_business\(p_business_id,/);
});
