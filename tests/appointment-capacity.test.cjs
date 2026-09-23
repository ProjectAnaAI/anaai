// Run: node --test tests/appointment-capacity.test.cjs
//
// Static migration contracts plus a JS port of the capacity sweep. These tests
// do NOT execute PostgreSQL. They prove the algorithm the migration encodes and
// the security/ordering properties of the SQL text. Real concurrency, RLS and
// PL/pgSQL behavior still require the disposable-database fixtures listed in
// tests/appointment-capacity.README.md.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const column = fs.readFileSync('supabase/migrations/202609210001_add_appointment_capacity.sql', 'utf8');
const checker = fs.readFileSync('supabase/migrations/202609210002_appointment_capacity_checker.sql', 'utf8');
const scheduling = fs.readFileSync('supabase/migrations/202609210003_capacity_based_manual_scheduling.sql', 'utf8');
const deployed = fs.readFileSync('supabase/migrations/202609140001_atomic_manual_appointments.sql', 'utf8');
const idempotent = fs.readFileSync('supabase/migrations/202609150004_classify_ai_booking_rejections.sql', 'utf8');
const route = fs.readFileSync('server/handlers/appointments.ts', 'utf8');

// Statement text with commentary removed, so security assertions below cannot
// be satisfied (or defeated) by prose in a comment.
const code = (sql) =>
  sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*--.*$/gm, '');
const checkerCode = code(checker);
const schedulingCode = code(scheduling);

// --------------------------------------------------------------------------
// JS port of anaai_private.check_appointment_capacity_business.
//
// Times are minutes-from-midnight so the port stays independent of any JS date
// or timezone behavior, matching the SQL which works purely in business-local
// date + time. ACTIVE mirrors the SQL status filter exactly.
// --------------------------------------------------------------------------
const ACTIVE = ['Booked', 'Confirmed'];

function resolveDuration(appointment, services) {
  // Mirrors the SQL: service_id match wins outright (inactive services
  // included, NULL duration fails closed); the case-insensitive name fallback
  // applies ONLY when no service row matches service_id, and is ambiguous-safe.
  const byId = services.find((s) => s.id === appointment.service_id);
  if (byId) return byId.duration_minutes;
  const byName = services.filter(
    (s) => appointment.service != null && s.name.toLowerCase() === String(appointment.service).toLowerCase()
  );
  return byName.length === 1 ? byName[0].duration_minutes : null;
}

function checkCapacity({
  capacity,
  appointments = [],
  services = [],
  start,
  duration,
  excludeId = null,
  date = '2026-10-05',
  requestDate = '2026-10-05',
}) {
  if (capacity == null || capacity < 1) return 'INTERNAL_ERROR';
  if (start == null || duration == null || duration <= 0) return 'INVALID_SCHEDULE';

  const requestedStart = start;
  const requestedEnd = start + duration;

  const active = appointments
    .filter(
      (a) =>
        a.appointment_date === requestDate &&
        ACTIVE.includes(a.status) &&
        (excludeId === null || a.id !== excludeId)
    )
    .map((a) => ({ time: a.appointment_time, duration: resolveDuration(a, services) }));

  const usable = active.filter((a) => a.time != null && a.duration != null && a.duration > 0);
  if (active.length - usable.length > 0) return 'INVALID_EXISTING_SCHEDULE';

  const clipped = usable
    .map((a) => ({ s: a.time, e: a.time + a.duration }))
    .filter((i) => i.s < requestedEnd && i.e > requestedStart)
    .map((i) => ({ s: Math.max(i.s, requestedStart), e: Math.min(i.e, requestedEnd) }));

  // Group events at the same instant BEFORE running the total. This is what
  // makes [start, end) half-open: a -1 and a +1 at one instant net to zero.
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

  void date;
  return peak >= capacity ? 'SLOT_CONFLICT' : 'AVAILABLE';
}

const SERVICES = [
  { id: 'svc-30', name: 'Cut', duration_minutes: 30 },
  { id: 'svc-60', name: 'Colour', duration_minutes: 60 },
  { id: 'svc-null', name: 'Broken', duration_minutes: null },
];

const MIN = (h, m = 0) => h * 60 + m;

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

const base = (extra) => ({ services: SERVICES, ...extra });

// --------------------------------------------------------------------------
// Required capacity scenarios
// --------------------------------------------------------------------------

test('capacity 1 rejects an overlapping active appointment', () => {
  assert.equal(
    checkCapacity(base({
      capacity: 1,
      appointments: [appt(MIN(16), 'svc-30')],
      start: MIN(16, 15),
      duration: 30,
    })),
    'SLOT_CONFLICT'
  );
});

test('capacity 1 still allows a non-overlapping time', () => {
  assert.equal(
    checkCapacity(base({
      capacity: 1,
      appointments: [appt(MIN(16), 'svc-30')],
      start: MIN(17),
      duration: 30,
    })),
    'AVAILABLE'
  );
});

test('capacity 2 allows a second simultaneous appointment', () => {
  assert.equal(
    checkCapacity(base({
      capacity: 2,
      appointments: [appt(MIN(16), 'svc-30')],
      start: MIN(16),
      duration: 30,
    })),
    'AVAILABLE'
  );
});

test('capacity 2 rejects a third simultaneous appointment', () => {
  assert.equal(
    checkCapacity(base({
      capacity: 2,
      appointments: [appt(MIN(16), 'svc-30'), appt(MIN(16), 'svc-30')],
      start: MIN(16),
      duration: 30,
    })),
    'SLOT_CONFLICT'
  );
});

test('capacity 3 allows the third and rejects the fourth', () => {
  const two = [appt(MIN(16), 'svc-30'), appt(MIN(16), 'svc-30')];
  assert.equal(
    checkCapacity(base({ capacity: 3, appointments: two, start: MIN(16), duration: 30 })),
    'AVAILABLE'
  );
  assert.equal(
    checkCapacity(base({
      capacity: 3,
      appointments: [...two, appt(MIN(16), 'svc-30')],
      start: MIN(16),
      duration: 30,
    })),
    'SLOT_CONFLICT'
  );
});

for (const status of ['Booked', 'Confirmed']) {
  test(`${status} consumes capacity`, () => {
    assert.equal(
      checkCapacity(base({
        capacity: 1,
        appointments: [appt(MIN(16), 'svc-30', status)],
        start: MIN(16),
        duration: 30,
      })),
      'SLOT_CONFLICT'
    );
  });
}

for (const status of ['Cancelled', 'Completed']) {
  test(`${status} does not consume capacity`, () => {
    assert.equal(
      checkCapacity(base({
        capacity: 1,
        appointments: [appt(MIN(16), 'svc-30', status)],
        start: MIN(16),
        duration: 30,
      })),
      'AVAILABLE'
    );
  });

  test(`${status} does not consume capacity even when its schedule is malformed`, () => {
    assert.equal(
      checkCapacity(base({
        capacity: 1,
        appointments: [appt(null, 'svc-30', status)],
        start: MIN(16),
        duration: 30,
      })),
      'AVAILABLE'
    );
  });
}

test('exact end/start boundary does not overlap at capacity 1', () => {
  assert.equal(
    checkCapacity(base({
      capacity: 1,
      appointments: [appt(MIN(16), 'svc-30')],
      start: MIN(16, 30),
      duration: 30,
    })),
    'AVAILABLE'
  );
  // The mirrored boundary: candidate ends exactly when the existing one starts.
  assert.equal(
    checkCapacity(base({
      capacity: 1,
      appointments: [appt(MIN(16, 30), 'svc-30')],
      start: MIN(16),
      duration: 30,
    })),
    'AVAILABLE'
  );
});

test('one minute of overlap on either side still conflicts at capacity 1', () => {
  assert.equal(
    checkCapacity(base({
      capacity: 1,
      appointments: [appt(MIN(16), 'svc-30')],
      start: MIN(16, 29),
      duration: 30,
    })),
    'SLOT_CONFLICT'
  );
  assert.equal(
    checkCapacity(base({
      capacity: 1,
      appointments: [appt(MIN(16, 31), 'svc-30')],
      start: MIN(16),
      duration: 32,
    })),
    'SLOT_CONFLICT'
  );
});

test('peak concurrency: A 16:00-16:30, B 16:30-17:00, candidate 16:00-17:00 at capacity 2 is AVAILABLE', () => {
  const appointments = [appt(MIN(16), 'svc-30'), appt(MIN(16, 30), 'svc-30')];
  assert.equal(
    checkCapacity(base({ capacity: 2, appointments, start: MIN(16), duration: 60 })),
    'AVAILABLE'
  );
  // A naive "count overlapping appointments" rule would see 2 and reject.
  assert.equal(appointments.length, 2);
  // The same pair at capacity 1 must still reject.
  assert.equal(
    checkCapacity(base({ capacity: 1, appointments, start: MIN(16), duration: 60 })),
    'SLOT_CONFLICT'
  );
});

test('peak concurrency rejects when the back-to-back pair actually stacks', () => {
  // A 16:00-16:30, B 16:15-17:00 genuinely reach 2 simultaneously at 16:15.
  assert.equal(
    checkCapacity(base({
      capacity: 2,
      appointments: [appt(MIN(16), 'svc-30'), appt(MIN(16, 15), 'svc-60')],
      start: MIN(16),
      duration: 60,
    })),
    'SLOT_CONFLICT'
  );
});

test('occupancy outside the requested interval never counts', () => {
  // Three stacked at 14:00 cannot block an unrelated 16:00 request.
  assert.equal(
    checkCapacity(base({
      capacity: 2,
      appointments: [appt(MIN(14), 'svc-30'), appt(MIN(14), 'svc-30'), appt(MIN(14), 'svc-30')],
      start: MIN(16),
      duration: 30,
    })),
    'AVAILABLE'
  );
});

test('reschedule excludes itself', () => {
  const self = appt(MIN(16), 'svc-30');
  // Without exclusion this same-slot move would self-conflict at capacity 1.
  assert.equal(
    checkCapacity(base({ capacity: 1, appointments: [self], start: MIN(16), duration: 30 })),
    'SLOT_CONFLICT'
  );
  assert.equal(
    checkCapacity(base({
      capacity: 1,
      appointments: [self],
      start: MIN(16),
      duration: 30,
      excludeId: self.id,
    })),
    'AVAILABLE'
  );
});

test('reschedule still rejects when the target interval is genuinely at capacity', () => {
  const self = appt(MIN(9), 'svc-30');
  const others = [appt(MIN(16), 'svc-30'), appt(MIN(16), 'svc-30')];
  assert.equal(
    checkCapacity(base({
      capacity: 2,
      appointments: [self, ...others],
      start: MIN(16),
      duration: 30,
      excludeId: self.id,
    })),
    'SLOT_CONFLICT'
  );
  // Excluding itself must not excuse one of the other two.
  assert.equal(
    checkCapacity(base({
      capacity: 2,
      appointments: [self, others[0]],
      start: MIN(16),
      duration: 30,
      excludeId: self.id,
    })),
    'AVAILABLE'
  );
});

test('reschedule exclusion does not hide another appointment malformed on the target date', () => {
  const self = appt(MIN(9), 'svc-30');
  assert.equal(
    checkCapacity(base({
      capacity: 5,
      appointments: [self, appt(null, 'svc-30')],
      start: MIN(16),
      duration: 30,
      excludeId: self.id,
    })),
    'INVALID_EXISTING_SCHEDULE'
  );
});

test('malformed existing active schedules fail closed, never silently AVAILABLE', () => {
  const malformed = [
    ['null appointment_time', appt(null, 'svc-30')],
    ['unknown service_id and unknown name', appt(MIN(16), 'svc-missing', 'Booked', { service: 'Nope' })],
    ['unknown service_id and null name', appt(MIN(16), 'svc-missing', 'Booked', { service: null })],
    ['matched service with NULL duration', appt(MIN(16), 'svc-null')],
  ];
  for (const [label, row] of malformed) {
    assert.equal(
      checkCapacity(base({ capacity: 5, appointments: [row], start: MIN(16), duration: 30 })),
      'INVALID_EXISTING_SCHEDULE',
      label
    );
  }
});

test('ambiguous legacy service-name fallback fails closed; a unique name resolves', () => {
  const ambiguous = [
    { id: 'a1', name: 'Trim', duration_minutes: 30 },
    { id: 'a2', name: 'trim', duration_minutes: 60 },
  ];
  const legacy = appt(MIN(16), 'svc-missing', 'Booked', { service: 'Trim' });
  assert.equal(
    checkCapacity({ capacity: 5, services: ambiguous, appointments: [legacy], start: MIN(16), duration: 30 }),
    'INVALID_EXISTING_SCHEDULE'
  );
  assert.equal(
    checkCapacity({
      capacity: 1,
      services: [ambiguous[0]],
      appointments: [legacy],
      start: MIN(16),
      duration: 30,
    }),
    'SLOT_CONFLICT'
  );
});

test('appointments on another date never consume capacity', () => {
  assert.equal(
    checkCapacity(base({
      capacity: 1,
      appointments: [appt(MIN(16), 'svc-30', 'Booked', { appointment_date: '2026-10-06' })],
      start: MIN(16),
      duration: 30,
    })),
    'AVAILABLE'
  );
});

test('invalid requested schedule and unreadable capacity fail without booking', () => {
  assert.equal(checkCapacity(base({ capacity: 2, start: MIN(16), duration: 0 })), 'INVALID_SCHEDULE');
  assert.equal(checkCapacity(base({ capacity: 2, start: MIN(16), duration: null })), 'INVALID_SCHEDULE');
  assert.equal(checkCapacity(base({ capacity: 2, start: null, duration: 30 })), 'INVALID_SCHEDULE');
  assert.equal(checkCapacity(base({ capacity: null, start: MIN(16), duration: 30 })), 'INTERNAL_ERROR');
  assert.equal(checkCapacity(base({ capacity: 0, start: MIN(16), duration: 30 })), 'INTERNAL_ERROR');
});

test('capacity 1 is exactly the deployed any-overlap rule across a swept grid', () => {
  // Exhaustive equivalence check against the previous single-slot semantics.
  const existing = [appt(MIN(16), 'svc-30'), appt(MIN(17), 'svc-60')];
  const intervals = existing.map((a) => ({
    s: a.appointment_time,
    e: a.appointment_time + SERVICES.find((x) => x.id === a.service_id).duration_minutes,
  }));
  for (let start = MIN(14); start <= MIN(20); start += 5) {
    for (const duration of [15, 30, 45, 60, 90]) {
      const legacyConflict = intervals.some((i) => start < i.e && start + duration > i.s);
      assert.equal(
        checkCapacity(base({ capacity: 1, appointments: existing, start, duration })),
        legacyConflict ? 'SLOT_CONFLICT' : 'AVAILABLE',
        `start=${start} duration=${duration}`
      );
    }
  }
});

test('capacity N is never stricter than capacity N-1 for the same calendar', () => {
  const existing = [appt(MIN(16), 'svc-30'), appt(MIN(16, 30), 'svc-30'), appt(MIN(16, 15), 'svc-60')];
  let sawAvailable = false;
  for (let capacity = 1; capacity <= 6; capacity += 1) {
    const result = checkCapacity(base({ capacity, appointments: existing, start: MIN(16), duration: 60 }));
    if (result === 'AVAILABLE') sawAvailable = true;
    else assert.equal(sawAvailable, false, `capacity ${capacity} regressed to ${result}`);
  }
  assert.equal(sawAvailable, true);
});

// --------------------------------------------------------------------------
// SQL contract: security architecture of the shared helper
// --------------------------------------------------------------------------

test('column migration keeps capacity NOT NULL, defaulted to 1, with a minimum of 1', () => {
  assert.match(column, /alter column appointment_capacity set default 1/);
  assert.match(column, /alter column appointment_capacity set not null/);
  assert.match(column, /appointment_capacity >= 1/);
});

test('the helper lives in a non-public schema and is never granted to public or anon', () => {
  assert.match(checker, /create schema if not exists anaai_private;/);
  assert.match(checker, /create or replace function anaai_private\.check_appointment_capacity_business\(/);
  assert.doesNotMatch(checker, /create or replace function public\.check_appointment_capacity_business/);
  assert.match(checker, /revoke all on schema anaai_private from public;/);
  assert.match(
    checker,
    /revoke all on function anaai_private\.check_appointment_capacity_business\([^)]*\) from public, anon;/
  );
  assert.doesNotMatch(checker, /grant\s+(execute|usage)[^;]*to[^;]*\banon\b/i);
});

test('an earlier public draft of the helper is dropped rather than left callable', () => {
  assert.match(checker, /drop function if exists public\.check_appointment_capacity_business\(/);
});

test('the capacity migrations grant nothing new in the public schema', () => {
  // 003 must not re-grant the helper; only the two pre-existing public RPCs.
  assert.doesNotMatch(scheduling, /check_appointment_capacity_business\([^)]*\)\s*to\s+authenticated/);
  const grants = scheduling.match(/grant execute on function public\.(\w+)/g) || [];
  assert.deepEqual(
    [...new Set(grants)].sort(),
    [
      'grant execute on function public.create_appointment_atomic_business',
      'grant execute on function public.reschedule_appointment_atomic_business',
    ]
  );
  assert.doesNotMatch(checker + scheduling, /alter (table|policy)|drop policy|disable row level security/i);
});

test('helper is read-only, invoker, search_path pinned, and mutates nothing', () => {
  assert.match(checker, /^\s*stable$/m);
  assert.match(checker, /^\s*security invoker$/m);
  assert.match(checker, /set search_path = pg_catalog, public/);
  assert.doesNotMatch(checkerCode, /\b(insert into|update public\.|delete from)\b/i);
  assert.doesNotMatch(checkerCode, /security definer/i);
  assert.doesNotMatch(checker, /SQLERRM/);
});

// --------------------------------------------------------------------------
// SQL contract: the checker encodes the required capacity semantics
// --------------------------------------------------------------------------

test('checker counts only Booked and Confirmed and honours the reschedule exclusion', () => {
  assert.match(checker, /a\.status in \('Booked', 'Confirmed'\)/);
  assert.doesNotMatch(checker, /'Cancelled'|'Completed'/);
  assert.match(
    checker,
    /p_exclude_appointment_id is null\s+or a\.id <> p_exclude_appointment_id/
  );
});

test('checker groups same-instant events before the running total (half-open intervals)', () => {
  const grouped = checker.indexOf('group by event_time');
  const running = checker.indexOf('sum(delta) over (');
  const peak = checker.indexOf('max(occupancy)');
  assert.ok(grouped > 0 && grouped < running && running < peak);
  assert.match(checker, /select clipped_start as event_time, 1 as delta from clipped/);
  assert.match(checker, /select clipped_end as event_time, -1 as delta from clipped/);
  // Strict comparisons on both sides are what make [start, end) half-open.
  assert.match(checker, /where existing_start < v_requested_end\s+and existing_end > v_requested_start/);
});

test('checker compares peak occupancy against capacity, not a raw overlap count', () => {
  assert.match(checker, /if v_peak >= v_capacity then\s+return 'SLOT_CONFLICT';/);
  assert.doesNotMatch(checker, /count\(\*\) >= v_capacity/);
});

test('checker validates existing rows and sweeps occupancy in one statement', () => {
  // A single SELECT ... INTO means validation and the sweep share one snapshot.
  assert.equal((checker.match(/^\s*with active as \(/gm) || []).length, 1);
  assert.match(checker, /into v_malformed, v_peak;/);
  assert.match(checker, /if v_malformed > 0 then\s+return 'INVALID_EXISTING_SCHEDULE';/);
  assert.ok(checker.indexOf('into v_malformed, v_peak;') < checker.indexOf("return 'SLOT_CONFLICT'"));
});

test('checker duration resolution matches the deployed fail-closed rule', () => {
  // service_id match wins outright; the name fallback is only for no match.
  assert.match(checker, /when exists \(\s+select 1\s+from public\.services s\s+where s\.id = a\.service_id/);
  assert.match(checker, /case when count\(\*\) = 1 then min\(s\.duration_minutes\) end/);
  assert.match(checker, /lower\(s\.name\) = lower\(a\.service\)/);
  assert.match(checker, /duration_minutes is not null\s+and duration_minutes > 0/);
  // The deployed function used the same ambiguous-name guard.
  assert.match(deployed, /case when count\(\*\) = 1 then min\(s\.duration_minutes\) end/);
});

test('checker returns only codes the deployed callers already allowlist', () => {
  const returned = [...checker.matchAll(/return '([A-Z_]+)';/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(returned)].sort(),
    ['AVAILABLE', 'INTERNAL_ERROR', 'INVALID_EXISTING_SCHEDULE', 'INVALID_SCHEDULE', 'SLOT_CONFLICT']
  );
  for (const code of ['SLOT_CONFLICT', 'INVALID_EXISTING_SCHEDULE', 'INVALID_SCHEDULE']) {
    assert.ok(idempotent.includes(`'${code}'`), `${code} missing from the idempotent allowlist`);
    assert.ok(route.includes(`${code}: [`), `${code} missing from the API error map`);
  }
  // INTERNAL_ERROR is the deliberate fail-closed path: the wrapper raises on it
  // and rolls the whole action back rather than persisting a terminal receipt.
  assert.match(idempotent, /in \('INTERNAL_ERROR','UNSUPPORTED_ISOLATION'\) then raise exception/);
});

test('capacity misconfiguration fails closed instead of assuming a default', () => {
  assert.match(checker, /if not found or v_capacity is null or v_capacity < 1 then\s+return 'INTERNAL_ERROR';/);
  assert.doesNotMatch(checker, /coalesce\(\s*v_capacity/);
});

// --------------------------------------------------------------------------
// SQL contract: 003 preserves every non-capacity scheduling guarantee
// --------------------------------------------------------------------------

test('both scheduling RPCs stay SECURITY INVOKER and validate auth.uid() then membership', () => {
  assert.equal((schedulingCode.match(/security invoker/gi) || []).length, 2);
  assert.doesNotMatch(schedulingCode, /security definer/i);
  assert.equal((scheduling.match(/v_user_id uuid := auth\.uid\(\);/g) || []).length, 2);
  assert.equal(
    (scheduling.match(/not coalesce\(public\.is_business_member\(p_business_id\), false\)/g) || []).length,
    2
  );
  assert.equal((scheduling.match(/'code', 'UNAUTHORIZED'/g) || []).length, 2);
  assert.equal((scheduling.match(/'code', 'FORBIDDEN'/g) || []).length, 2);
});

test('advisory lock expressions are byte-identical to the deployed RPCs', () => {
  assert.equal(
    (scheduling.match(/hashtext\(\s*p_business_id::text\s*\|\|\s*':'\s*\|\|\s*p_appointment_date::text\s*\)/g) || []).length,
    1
  );
  assert.equal(
    (scheduling.match(/hashtext\(\s*p_business_id::text\s*\|\|\s*':'\s*\|\|\s*v_scheduling_date::text\s*\)/g) || []).length,
    1
  );
  assert.match(deployed, /hashtext\(p_business_id::text \|\| ':' \|\| p_appointment_date::text\)/);
  assert.match(deployed, /hashtext\(p_business_id::text \|\| ':' \|\| v_scheduling_date::text\)/);
});

test('the inline overlap loop is gone and the capacity check replaces it in place', () => {
  assert.doesNotMatch(scheduling, /for v_existing in/);
  assert.equal(
    (scheduling.match(/anaai_private\.check_appointment_capacity_business\(/g) || []).length,
    2
  );
  assert.match(scheduling, /v_service\.duration_minutes,\s+null\s+\);/);
  assert.match(scheduling, /v_service\.duration_minutes,\s+p_appointment_id\s+\);/);
  assert.match(scheduling, /if v_capacity_result <> 'AVAILABLE' then/);
});

for (const [label, fn] of [
  ['create', scheduling.slice(scheduling.indexOf('create or replace function public.create_appointment_atomic_business'), scheduling.indexOf('create or replace function public.reschedule_appointment_atomic_business'))],
  ['reschedule', scheduling.slice(scheduling.indexOf('create or replace function public.reschedule_appointment_atomic_business'))],
]) {
  test(`${label}: lock, then validation, then capacity, then mutation`, () => {
    const lock = fn.indexOf('perform pg_advisory_xact_lock');
    const customer = fn.search(/select \*\s+into v_customer/);
    const service = fn.search(/select \*\s+into v_service/);
    const hours = fn.indexOf('select business_hours');
    const outside = fn.indexOf("'code', 'OUTSIDE_HOURS'");
    const capacity = fn.indexOf('anaai_private.check_appointment_capacity_business');
    const mutation = Math.max(fn.indexOf('insert into public.appointments'), fn.indexOf('update public.appointments'));
    assert.ok(lock > 0 && lock < customer, 'lock must precede customer validation');
    assert.ok(customer < service && service < hours && hours < outside, 'validation order preserved');
    assert.ok(outside < capacity, 'business hours are checked before capacity');
    assert.ok(capacity < mutation, 'capacity is checked before any write');
    assert.ok(fn.indexOf('transaction_isolation') < lock, 'READ COMMITTED is asserted first');
  });

  test(`${label}: customer, service, duration, hours and timezone behavior unchanged`, () => {
    assert.match(fn, /where id = p_customer_id\s+and business_id = p_business_id;/);
    assert.match(fn, /where id = p_service_id\s+and business_id = p_business_id\s+and is_active = true;/);
    assert.match(fn, /v_service\.duration_minutes is null\s+or v_service\.duration_minutes <= 0/);
    assert.match(fn, /order by created_at desc\s+limit 1;/);
    assert.match(fn, /v_hours := v_hours_text::jsonb;/);
    assert.match(fn, /'code', 'CLOSED'/);
    // Business-local date+time arithmetic only: no timestamptz, no time zone shift.
    assert.doesNotMatch(fn, /timestamptz|at time zone|now\(\)|current_date/i);
  });
}

test('reschedule keeps its lifecycle, self-exclusion, stale-source and identity rules', () => {
  const fn = scheduling.slice(scheduling.indexOf('create or replace function public.reschedule_appointment_atomic_business'));
  const discovery = fn.search(/select appointment_date\s+into v_source_date/);
  const dates = fn.indexOf('select distinct d.scheduling_date');
  const lock = fn.indexOf('perform pg_advisory_xact_lock');
  const row = fn.indexOf('for update');
  const changed = fn.indexOf('is distinct from v_source_date');
  const terminal = fn.indexOf("not in ('Booked', 'Confirmed')");
  const capacity = fn.indexOf('anaai_private.check_appointment_capacity_business');
  assert.ok(discovery > 0 && discovery < dates && dates < lock && lock < row);
  assert.ok(row < changed && changed < terminal && terminal < capacity);
  assert.match(fn, /'code', 'SOURCE_DATE_CHANGED'/);
  assert.match(fn, /'code', 'TERMINAL_APPOINTMENT'/);
  assert.match(fn, /order by d\.scheduling_date/);
  // SET clause only: the WHERE clause legitimately filters on business_id.
  const setStart = fn.indexOf('update public.appointments');
  const setClause = code(fn.slice(setStart, fn.indexOf('where id = p_appointment_id', setStart)));
  assert.match(setClause, /customer_id = v_customer\.id/);
  assert.doesNotMatch(setClause, /\b(user_id|status|business_id)\s*=/);
});

test('create still stamps auth.uid() and inserts Booked only', () => {
  const fn = scheduling.slice(0, scheduling.indexOf('create or replace function public.reschedule_appointment_atomic_business'));
  assert.match(fn, /p_business_id,\s+v_user_id,\s+v_customer\.id,\s+v_service\.id,/);
  assert.match(fn, /'Booked'\s+\)/);
  assert.doesNotMatch(scheduling, /insert into public\.customers|create trigger/i);
});

test('capacity authority stays in the database, never in the browser', () => {
  for (const file of ['app/appointments/page.tsx', 'app/business/page.tsx']) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /appointment_capacity/);
  }
  assert.doesNotMatch(route, /appointment_capacity|capacity/i);
});
