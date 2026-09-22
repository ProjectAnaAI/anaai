// Run: node --test tests/appointment-duration-snapshot.test.cjs
//
// The durable appointment duration snapshot (migration 202609210007).
//
// A deleted service used to null appointments.service_id via ON DELETE SET
// NULL, which made the duration of already-scheduled appointments unknowable
// and blocked EVERY subsequent booking on that business/date. These tests pin
// the snapshot semantics that fix it, and the fail-closed behaviour that must
// survive for rows whose duration genuinely cannot be recovered.
//
// No PostgreSQL is executed; see tests/appointment-duration-snapshot.README.md
// for the database acceptance tests required before deployment.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const M = 'supabase/migrations/';
const snapshot = fs.readFileSync(M + '202609210007_appointment_duration_snapshot.sql', 'utf8');
const checker = fs.readFileSync(M + '202609210002_appointment_capacity_checker.sql', 'utf8');
const manual = fs.readFileSync(M + '202609210003_capacity_based_manual_scheduling.sql', 'utf8');
const voice = fs.readFileSync(M + '202609210005_voice_capacity_booking.sql', 'utf8');
const legacy = fs.readFileSync(M + '202609210006_capacity_based_legacy_ai_booking.sql', 'utf8');

const code = (sql) =>
  sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*--.*$/gm, '');

const body = code(snapshot);

/* One complete `create or replace function <name>( ... $function$;` slice. */
function fn(sql, name) {
  const start = sql.indexOf(`create or replace function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  return sql.slice(start, sql.indexOf('$function$;', start));
}

// --------------------------------------------------------------------------
// Capacity port with the NEW resolution order.
//
// A. appointment.duration_minutes (snapshot)   -- authoritative
// C. still-resolvable linked service row       -- legacy rows only
// D. unambiguous legacy service-name match     -- legacy rows only
// E. otherwise malformed -> INVALID_EXISTING_SCHEDULE
// --------------------------------------------------------------------------
const ACTIVE = ['Booked', 'Confirmed'];
const MIN = (h, m = 0) => h * 60 + m;
const DATE = '2026-10-02';

function resolveDuration(a, services) {
  if (a.duration_minutes != null) return a.duration_minutes;           // A
  const byId = services.find((s) => s.id === a.service_id && s.business_id === a.business_id);
  if (byId) return byId.duration_minutes;                              // C
  const byName = services.filter(                                      // D
    (s) =>
      s.business_id === a.business_id &&
      a.service != null &&
      s.name.toLowerCase() === String(a.service).toLowerCase()
  );
  return byName.length === 1 ? byName[0].duration_minutes : null;      // E via null
}

function checkCapacity({ capacity, appointments = [], services = [], start, duration, excludeId = null, business = 'biz' }) {
  if (capacity == null || capacity < 1) return 'INTERNAL_ERROR';
  if (start == null || duration == null || duration <= 0) return 'INVALID_SCHEDULE';

  const active = appointments
    .filter(
      (a) =>
        a.business_id === business &&
        a.appointment_date === DATE &&
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

  const events = new Map();
  for (const i of clipped) {
    events.set(i.s, (events.get(i.s) || 0) + 1);
    events.set(i.e, (events.get(i.e) || 0) - 1);
  }

  let running = 0;
  let peak = 0;
  for (const at of [...events.keys()].sort((x, y) => x - y)) {
    running += events.get(at);
    if (running > peak) peak = running;
  }

  return peak >= capacity ? 'SLOT_CONFLICT' : 'AVAILABLE';
}

/* The backfill's WHERE clause, transcribed from 202609210007. */
function backfill(appointments, services) {
  for (const a of appointments) {
    if (a.duration_minutes != null || a.service_id == null) continue;
    const s = services.find((x) => x.id === a.service_id && x.business_id === a.business_id);
    if (s && s.duration_minutes != null && s.duration_minutes > 0 && s.duration_minutes <= 1440) {
      a.duration_minutes = s.duration_minutes;
    }
  }
  return appointments;
}

let seq = 0;
const appt = (o = {}) => ({
  id: `a${(seq += 1)}`,
  business_id: 'biz',
  appointment_date: DATE,
  appointment_time: MIN(16),
  service_id: 'svc-cut',
  service: 'Cut',
  duration_minutes: null,
  status: 'Booked',
  ...o,
});

const CUT = { id: 'svc-cut', business_id: 'biz', name: 'Cut', duration_minutes: 30 };
const COLOUR = { id: 'svc-col', business_id: 'biz', name: 'Colour', duration_minutes: 60 };
const CATALOGUE = [CUT, COLOUR];

// --------------------------------------------------------------------------
// A-F. Snapshot semantics
// --------------------------------------------------------------------------

test('A. a new booking stores the authoritative service duration as its snapshot', () => {
  // Every authoritative insert writes the column in the same statement.
  for (const [label, sql, name, value] of [
    ['manual create', snapshot, 'public.create_appointment_atomic_business', 'v_service.duration_minutes'],
    ['voice booking', snapshot, 'public.voice_book_appointment_business', 'v_duration_minutes'],
    ['legacy AI booking', snapshot, 'public.book_appointment_atomic_business', 'v_duration_minutes'],
  ]) {
    const f = code(fn(sql, name));
    const insert = f.slice(f.indexOf('insert into public.appointments'));
    assert.match(insert, /duration_minutes,/, label);
    assert.ok(insert.includes(`${value},`), `${label} writes ${value}`);
  }
});

test('A2. the duration written is the one the database validated, never a client value', () => {
  for (const name of [
    'public.create_appointment_atomic_business',
    'public.voice_book_appointment_business',
    'public.book_appointment_atomic_business',
  ]) {
    const f = code(fn(snapshot, name));
    // The duration comes from the service row, and the > 0 guard precedes it.
    assert.match(f, /duration_minutes is null\s+or .*duration_minutes <= 0|duration_minutes is null or v_duration_minutes <= 0/);
    assert.doesNotMatch(f, /p_duration|p_duration_minutes/, `${name} takes no duration parameter`);
  }
});

test('B. a reschedule refreshes the snapshot from the newly selected service', () => {
  const f = code(fn(snapshot, 'public.reschedule_appointment_atomic_business'));
  const updateAt = f.indexOf('update public.appointments');
  const set = f.slice(updateAt, f.indexOf('where id = p_appointment_id', updateAt));
  assert.match(set, /duration_minutes = v_service\.duration_minutes,/);
  // Still never touches identity or lifecycle.
  assert.doesNotMatch(set, /\b(user_id|status|business_id)\s*=/);
});

test('C. an existing snapshot overrides a later change to the service duration', () => {
  const booked = appt({ duration_minutes: 30 });
  // The owner later re-times the service from 30 to 120 minutes.
  const retimed = [{ ...CUT, duration_minutes: 120 }, COLOUR];

  // The scheduled interval is still 16:00-16:30, so 16:30 stays bookable.
  assert.equal(
    checkCapacity({ capacity: 1, appointments: [booked], services: retimed, start: MIN(16, 30), duration: 30 }),
    'AVAILABLE'
  );
  // Without the snapshot the same row would occupy 16:00-18:00 and block it.
  assert.equal(
    checkCapacity({
      capacity: 1,
      appointments: [{ ...booked, duration_minutes: null }],
      services: retimed,
      start: MIN(16, 30),
      duration: 30,
    }),
    'SLOT_CONFLICT'
  );
});

test('D. THE REPORTED FAILURE: a deleted service no longer blocks the calendar', () => {
  // ON DELETE SET NULL nulls service_id; the `service` text survives.
  const orphaned = appt({ service_id: null, service: 'facial', duration_minutes: 60 });

  // With a snapshot the interval is still computable and capacity works.
  assert.equal(
    checkCapacity({ capacity: 1, appointments: [orphaned], services: CATALOGUE, start: MIN(17), duration: 30 }),
    'AVAILABLE'
  );
  assert.equal(
    checkCapacity({ capacity: 1, appointments: [orphaned], services: CATALOGUE, start: MIN(16, 30), duration: 30 }),
    'SLOT_CONFLICT'
  );

  // The real call booked Haircut on this date at 14:30 and was refused.
  assert.equal(
    checkCapacity({ capacity: 1, appointments: [orphaned], services: CATALOGUE, start: MIN(14, 30), duration: 30 }),
    'AVAILABLE'
  );
});

test('E. a legacy row with no snapshot but a resolvable service_id uses the safe fallback', () => {
  const legacyRow = appt({ duration_minutes: null, service_id: 'svc-cut' });
  assert.equal(
    checkCapacity({ capacity: 1, appointments: [legacyRow], services: CATALOGUE, start: MIN(16, 15), duration: 30 }),
    'SLOT_CONFLICT'
  );
  assert.equal(
    checkCapacity({ capacity: 1, appointments: [legacyRow], services: CATALOGUE, start: MIN(16, 30), duration: 30 }),
    'AVAILABLE'
  );
});

test('E2. a legacy row resolvable only by an unambiguous service name still works', () => {
  const named = appt({ duration_minutes: null, service_id: null, service: 'Colour' });
  assert.equal(
    checkCapacity({ capacity: 1, appointments: [named], services: CATALOGUE, start: MIN(16, 30), duration: 30 }),
    'SLOT_CONFLICT',
    'a 60 minute Colour at 16:00 still covers 16:30'
  );
  // Ambiguous names remain fail-closed rather than guessed.
  const ambiguous = [
    { id: 's1', business_id: 'biz', name: 'Trim', duration_minutes: 30 },
    { id: 's2', business_id: 'biz', name: 'trim', duration_minutes: 90 },
  ];
  assert.equal(
    checkCapacity({
      capacity: 5,
      appointments: [appt({ duration_minutes: null, service_id: null, service: 'Trim' })],
      services: ambiguous,
      start: MIN(16),
      duration: 30,
    }),
    'INVALID_EXISTING_SCHEDULE'
  );
});

test('F. no snapshot and an unresolvable deleted service still fails closed', () => {
  // This is the pre-migration state of the reported rows, and must NOT be
  // silently rescued by inventing a duration.
  const unknowable = appt({ duration_minutes: null, service_id: null, service: 'facial' });
  assert.equal(
    checkCapacity({ capacity: 9, appointments: [unknowable], services: CATALOGUE, start: MIN(16), duration: 30 }),
    'INVALID_EXISTING_SCHEDULE'
  );
  // A matched service whose own duration is NULL also fails closed.
  assert.equal(
    checkCapacity({
      capacity: 9,
      appointments: [appt({ duration_minutes: null, service_id: 'svc-broken' })],
      services: [...CATALOGUE, { id: 'svc-broken', business_id: 'biz', name: 'Broken', duration_minutes: null }],
      start: MIN(16),
      duration: 30,
    }),
    'INVALID_EXISTING_SCHEDULE'
  );
});

// --------------------------------------------------------------------------
// Backfill
// --------------------------------------------------------------------------

test('the backfill records only durations that are authoritative right now', () => {
  const rows = backfill(
    [
      appt({ id: 'keep', service_id: 'svc-cut' }),
      appt({ id: 'orphan', service_id: null, service: 'facial' }),
      appt({ id: 'named', service_id: null, service: 'Colour' }),
      appt({ id: 'cross', service_id: 'svc-cut', business_id: 'other' }),
      appt({ id: 'already', service_id: 'svc-col', duration_minutes: 45 }),
      appt({ id: 'zero', service_id: 'svc-zero' }),
    ],
    [...CATALOGUE, { id: 'svc-zero', business_id: 'biz', name: 'Zero', duration_minutes: 0 }]
  );
  const by = Object.fromEntries(rows.map((r) => [r.id, r.duration_minutes]));

  assert.equal(by.keep, 30, 'resolvable service_id is backfilled');
  assert.equal(by.orphan, null, 'a deleted service is never invented');
  assert.equal(by.named, null, 'the name fallback is not frozen into a snapshot');
  assert.equal(by.cross, null, 'a cross-business service never backfills');
  assert.equal(by.already, 45, 'an existing snapshot is never overwritten');
  assert.equal(by.zero, null, 'a nonpositive duration is never recorded');
});

test('the backfill statement matches those rules exactly', () => {
  const sql = body.slice(body.indexOf('update public.appointments a'), body.indexOf('create or replace function'));
  assert.match(sql, /set duration_minutes = s\.duration_minutes/);
  for (const clause of [
    /where a\.duration_minutes is null/,
    /and a\.service_id is not null/,
    /and s\.id = a\.service_id/,
    /and s\.business_id = a\.business_id/,
    /and s\.duration_minutes is not null/,
    /and s\.duration_minutes > 0/,
    /and s\.duration_minutes <= 1440/,
  ]) {
    assert.match(sql, clause);
  }
  // Nothing may resolve a backfill through the service NAME.
  assert.doesNotMatch(sql, /lower\(s\.name\)/);
  // No appointment is deleted or re-timed to make anything pass.
  assert.doesNotMatch(body, /delete from public\.appointments|delete from public\.services/i);
  assert.doesNotMatch(body, /insert into public\.services/i);
});

// --------------------------------------------------------------------------
// G-I. Capacity semantics unchanged
// --------------------------------------------------------------------------

test('G. peak concurrency, not naive overlap count', () => {
  const pair = [
    appt({ appointment_time: MIN(16), duration_minutes: 30 }),
    appt({ appointment_time: MIN(16, 30), duration_minutes: 30 }),
  ];
  // A 16:00-16:30 and B 16:30-17:00; candidate 16:00-17:00 peaks at 2.
  assert.equal(checkCapacity({ capacity: 2, appointments: pair, start: MIN(16), duration: 60 }), 'AVAILABLE');
  assert.equal(pair.length, 2, 'a naive count would be 2 and would reject');
  assert.equal(checkCapacity({ capacity: 1, appointments: pair, start: MIN(16), duration: 60 }), 'SLOT_CONFLICT');
  // Genuinely stacked appointments still reject.
  assert.equal(
    checkCapacity({
      capacity: 2,
      appointments: [appt({ duration_minutes: 30 }), appt({ appointment_time: MIN(16, 15), duration_minutes: 60 })],
      start: MIN(16),
      duration: 60,
    }),
    'SLOT_CONFLICT'
  );
});

test('H. exact end/start boundaries do not overlap', () => {
  const one = [appt({ appointment_time: MIN(16), duration_minutes: 30 })];
  assert.equal(checkCapacity({ capacity: 1, appointments: one, start: MIN(16, 30), duration: 30 }), 'AVAILABLE');
  assert.equal(checkCapacity({ capacity: 1, appointments: one, start: MIN(15, 30), duration: 30 }), 'AVAILABLE');
  assert.equal(checkCapacity({ capacity: 1, appointments: one, start: MIN(16, 29), duration: 30 }), 'SLOT_CONFLICT');
});

test('I. Cancelled and Completed never consume capacity, snapshot or not', () => {
  for (const status of ['Cancelled', 'Completed']) {
    for (const duration_minutes of [30, null]) {
      assert.equal(
        checkCapacity({
          capacity: 1,
          appointments: [appt({ status, duration_minutes, service_id: null, service: 'facial' })],
          services: CATALOGUE,
          start: MIN(16),
          duration: 30,
        }),
        'AVAILABLE',
        `${status} duration=${duration_minutes}`
      );
    }
  }
  for (const status of ['Booked', 'Confirmed']) {
    assert.equal(
      checkCapacity({
        capacity: 1,
        appointments: [appt({ status, duration_minutes: 30 })],
        start: MIN(16),
        duration: 30,
      }),
      'SLOT_CONFLICT',
      status
    );
  }
});

test('a reschedule still excludes the appointment being moved', () => {
  const self = appt({ duration_minutes: 30 });
  assert.equal(checkCapacity({ capacity: 1, appointments: [self], start: MIN(16), duration: 30 }), 'SLOT_CONFLICT');
  assert.equal(
    checkCapacity({ capacity: 1, appointments: [self], start: MIN(16), duration: 30, excludeId: self.id }),
    'AVAILABLE'
  );
});

test('another business never contributes occupancy', () => {
  assert.equal(
    checkCapacity({
      capacity: 1,
      appointments: [appt({ business_id: 'other', duration_minutes: 30 })],
      start: MIN(16),
      duration: 30,
    }),
    'AVAILABLE'
  );
});

// --------------------------------------------------------------------------
// Helper contract
// --------------------------------------------------------------------------

test('the helper prefers the snapshot and keeps both legacy fallbacks', () => {
  const f = code(fn(snapshot, 'anaai_private.check_appointment_capacity_business'));
  assert.match(f, /coalesce\(\s*a\.duration_minutes,/, 'snapshot is the first choice');
  assert.match(f, /where s\.id = a\.service_id/, 'linked-service fallback retained');
  assert.match(f, /case when count\(\*\) = 1 then min\(s\.duration_minutes\) end/, 'ambiguity-safe name fallback retained');
  // Still one statement, still fail-closed, still peak concurrency.
  assert.equal((f.match(/^\s*with active as \(/gm) || []).length, 1);
  assert.match(f, /if v_malformed > 0 then\s+return 'INVALID_EXISTING_SCHEDULE';/);
  assert.match(f, /if v_peak >= v_capacity then\s+return 'SLOT_CONFLICT';/);
  assert.match(f, /a\.status in \('Booked', 'Confirmed'\)/);
  assert.match(f, /where existing_start < v_requested_end\s+and existing_end > v_requested_start/);
  assert.match(f, /p_exclude_appointment_id is null\s+or a\.id <> p_exclude_appointment_id/);
});

test('the helper stays private, read-only and identically secured', () => {
  const f = code(fn(snapshot, 'anaai_private.check_appointment_capacity_business'));
  assert.match(f, /^\s*stable$/m);
  assert.match(f, /^\s*security invoker$/m);
  assert.match(f, /set search_path = pg_catalog, public/);
  assert.doesNotMatch(f, /\b(insert into|update public\.|delete from)\b/i);
  assert.match(body, /revoke all on function anaai_private\.check_appointment_capacity_business\([^)]*\) from public, anon;/);
  assert.doesNotMatch(body, /grant\s+(execute|usage)[^;]*to[^;]*\banon\b/i);
  assert.doesNotMatch(body, /create schema|alter schema/i);
});

// --------------------------------------------------------------------------
// J-P. No regressions in the surrounding contracts
// --------------------------------------------------------------------------

test('J. Voice availability is untouched and still delegates to the shared helper', () => {
  // 202609210004 is not restated, so Voice availability automatically picks up
  // the new resolution order through the helper it already calls.
  assert.doesNotMatch(body, /voice_check_appointment_availability/);
  const deployed = fs.readFileSync(M + '202609210004_voice_capacity_availability.sql', 'utf8');
  assert.match(deployed, /anaai_private\.check_appointment_capacity_business\(/);
  assert.match(deployed, /'available', false,\s*'code', 'INVALID_EXISTING_SCHEDULE'/);
});

test('K-M. every authoritative path keeps its security and lock contract', () => {
  const lock = /hashtext\(\s*p_business_id::text\s*\|\|\s*':'\s*\|\|\s*p_appointment_date::text\s*\)/;
  for (const [name, invoker] of [
    ['public.create_appointment_atomic_business', true],
    ['public.reschedule_appointment_atomic_business', true],
    ['public.voice_book_appointment_business', false],
    ['public.book_appointment_atomic_business', true],
  ]) {
    const f = code(fn(snapshot, name));
    assert.equal(/security invoker/.test(f), invoker, `${name} security clause`);
    assert.equal(/security definer/.test(f), !invoker, `${name} security clause`);
    assert.match(f, /pg_advisory_xact_lock/, `${name} takes the advisory lock`);
  }
  assert.match(code(fn(snapshot, 'public.create_appointment_atomic_business')), lock);
  assert.match(code(fn(snapshot, 'public.voice_book_appointment_business')), lock);
  assert.match(code(fn(snapshot, 'public.book_appointment_atomic_business')), lock);
});

test('K-M. capacity is still decided after the lock and before any mutation', () => {
  for (const name of [
    'public.create_appointment_atomic_business',
    'public.voice_book_appointment_business',
    'public.book_appointment_atomic_business',
  ]) {
    const f = code(fn(snapshot, name));
    const lock = f.indexOf('pg_advisory_xact_lock');
    const capacity = f.indexOf('anaai_private.check_appointment_capacity_business');
    const write = f.indexOf('insert into public.appointments');
    assert.ok(lock > 0 && lock < capacity, `${name}: lock precedes capacity`);
    assert.ok(capacity < write, `${name}: capacity precedes the appointment insert`);
  }
});

test('N. idempotency and replay receipts are unchanged', () => {
  const v = code(fn(snapshot, 'public.voice_book_appointment_business'));
  assert.match(v, /on conflict \(business_id, idempotency_key\) do nothing/);
  assert.match(v, /'IDEMPOTENCY_CONFLICT'/);
  assert.match(v, /'ACTION_INCOMPLETE'/);
  assert.match(v, /return v_action\.result \|\| jsonb_build_object\('replayed', true\);/);
  assert.match(v, /current_setting\('transaction_isolation'\) <> 'read committed'/);
  // The claim still precedes the lock.
  assert.ok(v.indexOf('insert into public.appointment_actions') < v.indexOf('pg_advisory_xact_lock'));
});

test('O. tenant isolation is unchanged on every path', () => {
  for (const name of [
    'public.create_appointment_atomic_business',
    'public.reschedule_appointment_atomic_business',
  ]) {
    const f = code(fn(snapshot, name));
    assert.match(f, /auth\.uid\(\)/, name);
    assert.match(f, /not coalesce\(public\.is_business_member\(p_business_id\), false\)/, name);
  }
  const l = code(fn(snapshot, 'public.book_appointment_atomic_business'));
  assert.match(l, /if not public\.is_business_member\(p_business_id\) then/);
  assert.match(l, /set search_path to 'public'/);
  // Every appointment read/write stays business-scoped.
  assert.doesNotMatch(body, /from public\.appointments\s+where\s+id\s*=\s*p_appointment_id\s*;/);
});

test('P. service validation is unchanged on every path', () => {
  for (const name of [
    'public.create_appointment_atomic_business',
    'public.reschedule_appointment_atomic_business',
  ]) {
    const f = code(fn(snapshot, name));
    assert.match(f, /where id = p_service_id\s+and business_id = p_business_id\s+and is_active = true;/, name);
    assert.match(f, /v_service\.duration_minutes is null\s+or v_service\.duration_minutes <= 0/, name);
    assert.match(f, /'code', 'INVALID_DURATION'/, name);
  }
  for (const name of ['public.voice_book_appointment_business', 'public.book_appointment_atomic_business']) {
    const f = code(fn(snapshot, name));
    assert.match(f, /and s\.business_id = p_business_id\s+and s\.is_active = true/, name);
  }
});

// --------------------------------------------------------------------------
// Schema and supersession
// --------------------------------------------------------------------------

test('the column is nullable, positive and bounded', () => {
  assert.match(body, /alter table public\.appointments\s+add column if not exists duration_minutes integer;/);
  assert.match(
    body,
    /check \(\s*duration_minutes is null\s+or \(duration_minutes > 0 and duration_minutes <= 1440\)\s*\)/
  );
  // NOT NULL would fail on rows that cannot be honestly backfilled.
  assert.doesNotMatch(body, /duration_minutes set not null/);
  assert.doesNotMatch(body, /alter column duration_minutes/);
});

test('deletion semantics are deliberately unchanged', () => {
  // ON DELETE SET NULL stays: the snapshot, not the FK, preserves the interval.
  assert.doesNotMatch(body, /on delete (cascade|restrict|no action)/i);
  assert.doesNotMatch(body, /drop constraint[^;]*service_id/i);
  assert.doesNotMatch(body, /references public\.services/i);
});

test('007 supersedes the earlier definitions and edits none of them', () => {
  // The four functions restated here now live in 007; 002/003/005/006 remain
  // as applied history and must not be edited.
  for (const [file, sql] of [
    ['202609210002', checker],
    ['202609210003', manual],
    ['202609210005', voice],
    ['202609210006', legacy],
  ]) {
    assert.doesNotMatch(sql, /a\.duration_minutes/, `${file} must stay as applied`);
  }
  assert.equal((body.match(/create or replace function/g) || []).length, 5);
  assert.match(body, /^begin;$/m);
  assert.match(body, /^commit;$/m);
});

test('no capacity or duration authority leaks into client code', () => {
  for (const file of [
    'lib/voice-booking.ts',
    'lib/voice-handler.ts',
    'app/api/appointments/route.ts',
    'app/api/ai/route.ts',
    'app/appointments/page.tsx',
  ]) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /appointment_capacity|anaai_private|check_appointment_capacity_business/, file);
    assert.doesNotMatch(source, /p_duration_minutes/, file);
  }
});

test('the Voice availability diagnostics stay privacy-safe', () => {
  const source = fs.readFileSync('lib/voice-booking.ts', 'utf8');
  const logs = [...source.matchAll(/console\.(?:error|warn|info|log)\(([\s\S]*?)\);/g)].map((m) => m[1]);
  assert.ok(logs.length > 0);
  for (const log of logs) {
    // Literal text is a bounded label (for example `field=service_id` names
    // WHICH check failed). Only an interpolated expression can emit a value,
    // so only those are inspected.
    for (const [, expr] of log.matchAll(/\$\{([\s\S]*?)\}/g)) {
      for (const banned of [
        'customerName', 'customerPhone', 'businessId', 'serviceId',
        'appointmentId', 'speech', 'transcript', 'stateToken', 'payload',
        'JSON.stringify', 'request', 'customer', 'phone', 'name',
      ]) {
        assert.ok(!expr.includes(banned), `log interpolates ${banned}: ${expr.trim()}`);
      }
      // Each interpolation must be a bounded enum: our own rpc code, the
      // PostgREST error code, or a fixed field label.
      assert.match(
        expr,
        /error\.code|data\.code|"unknown"|'unknown'/,
        `unbounded interpolation: ${expr.trim()}`
      );
    }
  }
  // The distinguishable failure reasons are retained.
  for (const failure of [
    'failure=invalid_input', 'failure=rpc_error', 'failure=malformed_payload',
    'failure=receipt_mismatch', 'failure=rpc_rejection', 'failure=exception',
  ]) {
    assert.ok(source.includes(failure), `missing diagnostic ${failure}`);
  }
});
