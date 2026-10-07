# M05 — Time Clock + My Time

Employees clock themselves in and out, take Paid and Meal Breaks, and see their own current workweek. M05 builds on M04 identity: Supabase account → `business_members` → registered ZUDE device → PIN-verified employee → opaque employee session.

**Status:** code complete and tested locally. Migration `202610010001_m05_time_clock.sql` is **not applied**. API and physical-iPad verification are still outstanding.

## 1. Product invariants

- PIN unlock is not Clock In. Lock, app background, employee-session expiry, device revocation and account sign-out are not Clock Out. None of them write time events. Tests prove this on the server, in SQL and in native code.
- Clock state belongs to the employee in the business, not to the session or the iPad. An employee can clock in, Lock, unlock later, or move to another registered device of the same business, and still be working.
- The client is never the authority. The device clock, client timezone, employee ID, business ID, role and durations are never trusted or even sent.

## 2. Ledger: `public.employee_time_events`

An append-only ledger and the only source of time state. There is no mutable "current status" column.

| Column | Meaning |
| --- | --- |
| `seq` | Identity; the employee's total event order (writes are serialized, so seq order is commit order) |
| `business_id`, `employee_id`, `device_id` | Composite FKs to `employees (business_id, id)` and `zude_devices (business_id, id)`. An event can never mix businesses |
| `event_type` | `CLOCK_IN`, `BREAK_START`, `BREAK_END`, `CLOCK_OUT` |
| `break_type` | `PAID` or `MEAL` on both `BREAK_START` and `BREAK_END` (BREAK_END copies the open break's type); NULL on clock events. Enforced by CHECK |
| `occurred_at` | Database `clock_timestamp()`, never earlier than the employee's previous event |
| `request_id` | Client idempotency key; unique per (business, employee, request, event_type) |
| `source` | `device_pin` only (requires a device). M06 corrections must add their own source deliberately |

**Integrity**
- UPDATE and TRUNCATE triggers raise an error, even for the table owner.
- A DELETE trigger refuses any delete while the event's business still exists, so even a future grant can't delete history.
  - Whole-business deletion still cascades. PostgreSQL fires the row trigger during the cascade only after the business row is gone. Tests prove both.
- `service_role` may only SELECT. INSERT, UPDATE and DELETE go only through the functions below.
- `anon` and `authenticated` have no access. RLS is enabled with no policies.
- Employee and device FKs are NO ACTION, so an employee or device with history can't be hard-deleted. Deleting the business still removes its tenant data.

**Indexes**
- `(business_id, employee_id, seq desc)`: current state.
- `(business_id, employee_id, occurred_at)`: My Time.
- `(business_id, occurred_at)`: M06 manager range queries.
- `(business_id, device_id)`.

## 3. State machine: `m05_record_time_event`

States: `OFF_CLOCK`, `WORKING`, `ON_PAID_BREAK`, `ON_MEAL_BREAK`, derived from the latest event.

| From | Action | Writes | To |
| --- | --- | --- | --- |
| OFF_CLOCK | CLOCK_IN | CLOCK_IN | WORKING |
| WORKING | BREAK_START (PAID / MEAL) | BREAK_START | ON_PAID_BREAK / ON_MEAL_BREAK |
| ON_*_BREAK | BREAK_END | BREAK_END | WORKING |
| WORKING | CLOCK_OUT | CLOCK_OUT | OFF_CLOCK |
| ON_*_BREAK | CLOCK_OUT | BREAK_END then CLOCK_OUT, same `occurred_at`, one transaction | OFF_CLOCK |

Anything else returns `TIME_INVALID_TRANSITION` and writes nothing. This covers double clock-in, a break or clock-out while off the clock, a nested break, and BREAK_END while working.

**Serialization and identity**
- The function is `security definer` with an empty `search_path`, executable only by `service_role`.
- It takes `pg_advisory_xact_lock` per business + employee, so concurrent requests from any device or server worker are serialized.
- Inside the transaction it re-verifies, with row locks, that:
  - the employee is active,
  - the device is unrevoked,
  - the employee session is unrevoked, unexpired, bound to that employee and device, and still the device's current PIN generation (as M04 validates it).
- A change racing the request fails closed with SQLSTATE `42501`.

**Idempotency**
- Every action carries a client `Idempotency-Key` (UUID).
- The same key and the same action returns `{ ok: true, replayed: true }` and writes nothing. A late retry never acts on a newer state.
- The same key for a different action returns `TIME_REQUEST_CONFLICT`.

## 4. Breaks

| | Paid Break | Meal Break |
| --- | --- | --- |
| Intended | 10 minutes | 30 minutes |
| Worked time | Included (continues) | Excluded (unpaid) |

- 10 and 30 minutes are intended durations only. Breaks never end automatically.
- The app shows elapsed time and how far a break is over its intended length. The actual timestamps stay authoritative.
- Clocking out during a break ends the break atomically; the employee doesn't need to end it first.

## 5. Calculation (`server/time-calculation.ts`)

- **Worked time** = elapsed clock time − Meal Break time. Paid Break time is reported separately and never subtracted.
  - Example: 09:00–17:00 with a 10-minute Paid Break and a 30-minute Meal Break is 7h 30m worked, 10m paid break, 30m meal break.
- **Open shifts and breaks** run to the server's `now` (`max(server clock, latest event)`), returned as `serverNow`. The iPad only advances the display between refreshes.
- **Workweek:** Monday 00:00 to the next Monday 00:00 in the business's configured `businesses.timezone`.
  - Day boundaries are local midnights found by binary search on the timezone, so DST days are 23 or 25 hours, including zones that skip midnight.
  - The appointment calendar's Sunday-first display week is a separate UI convention.
- **Attribution:** time counts in the local day and week in which it was worked.
  - A shift crossing midnight contributes to both days and is flagged "Continues past midnight" / "Started the previous day".
  - A shift still open at Monday 00:00 counts in this week only from the week start. Time Clock still shows the whole open shift.

## 6. API (`server/handlers/time-clock.ts`)

**Authentication** is `Authorization: ZudeDevice <device credential>` plus `x-zude-employee-session: <session>`.
- Business, employee and device come only from those verified credentials (`employeeIdentity()`).
- An account bearer token alone gets `401 IDENTITY_UNAUTHORIZED`.
- Query strings and `x-anaai-business-id` are refused at the credential boundary.
- Bodies use strict allow-lists, so `employeeId`, `businessId`, `role`, `occurredAt` and `workedMs` are rejected with 400.

| Endpoint | Body | Result |
| --- | --- | --- |
| `GET /api/time-clock` | — | state, employee, open shift, open break, today's totals, `serverNow` |
| `POST /api/time-clock/clock-in` | `{}` + Idempotency-Key | same view, `replayed` |
| `POST /api/time-clock/break-start` | `{ breakType: "PAID" \| "MEAL" }` + key | same |
| `POST /api/time-clock/break-end` | `{}` + key | same |
| `POST /api/time-clock/clock-out` | `{}` + key | same |
| `GET /api/my-time` | — | the employee's current week: totals, days up to today with shifts and breaks, their own reports this week |
| `POST /api/my-time/issues` | `{ note, workDate?, eventId? }` + key | `201` new report; `200` exact replay; `409 TIME_REQUEST_CONFLICT` for the same key with a different payload |

**Codes**
- `TIME_INVALID_TRANSITION` / `TIME_REQUEST_CONFLICT` (409).
- `INVALID_REQUEST` (400).
- `IDENTITY_UNAUTHORIZED`, `DEVICE_INVALID`, `DEVICE_REVOKED` (401). These are M04's codes, unchanged, so native device recovery works exactly as before.
- `TIME_CONFIGURATION_UNAVAILABLE`, `TIME_UNAVAILABLE` (503).
- A race inside the write transaction is reported as `IDENTITY_UNAUTHORIZED`, never as a device code.

Every PIN role (employee, manager, owner) can use these endpoints, and always only for themselves. M05 has no way to act on another employee.

## 7. Report a time issue: `public.employee_time_issues`

- **Contents:** an append-only note from an employee to a manager. Business, reporting employee and device, an optional business-local `work_date` (current week, up to today), an optional `time_event_id`, a 1–1000 character note, and the server timestamp.
- **Event reference:** a composite FK guarantees any referenced event is the same employee's.
- **Lifecycle:** `open`, or `resolved` with `resolved_at`, `resolved_by_user_id` and `resolution_note`. The CHECK requires consistency. Resolution belongs to M06.
- **Write path:** `m05_report_time_issue` (definer, `service_role` only, identity re-verified). Reports never change the ledger.
- **Idempotency:**
  - The same key with the same note (trimmed), day and event replays the original report (`200`, `replayed: true`).
  - The same key with any different value returns `409 TIME_REQUEST_CONFLICT` and writes nothing.

## 8. Native app

- **Navigation:** My Work → **Time Clock** (`/time-clock`) and **My Time** (`/my-time`), available to every role with no permission filter. They also appear in the collapsed rail.
- **Time Clock:** shows the employee's name, a status badge, clock-in time, shift elapsed, shift worked, the current break (type, intended length, elapsed, over-intended in amber), and today's worked, paid-break and meal-break totals. Actions depend on state:
  - OFF_CLOCK: Clock In.
  - WORKING: Start Break and Clock Out.
  - On a break: End Break and Clock Out.
  - Start Break opens a deliberate choice: "Paid Break · 10 minutes · Paid time continues" or "Meal Break · 30 minutes · Unpaid". Opening the chooser starts nothing.
  - Clock Out asks for confirmation, and says when it also ends the current break.
- **My Time:** "This Week" with the business-local date range; worked, paid-break and meal-break totals; an in-progress indicator; days from today back to Monday, each with shifts, breaks and midnight flags; and Report a time issue (day + note) with the employee's own reports and their status. There is no week navigation, no employee picker, no editing, no pay amounts and no team data. Loading, error and empty states are real.
- **Safety:**
  - One request at a time; duplicate taps are ignored.
  - After an unknown outcome (network error or 5xx), retrying the same action reuses the same idempotency key, so it is recorded at most once.
  - Mutation responses are the server's freshly computed view, and a failure triggers a refresh.
- **Account mode** (iPad not registered as a shared device) explains that Time Clock needs a registered device and an employee PIN, and sends no request.

## 8a. Post-PIN routing and Clock Out

**One decision per PIN session.** `ShiftGate` sits between the PIN gate and the workspace (`AuthGate`: `EmployeeIdentityGate → ShiftGate → AppShell`). After every PIN unlock it fetches `GET /api/time-clock` and routes on the server state, never on the calendar or the employee's role:

| State | Destination |
| --- | --- |
| `OFF_CLOCK` | Clock-In Landing (full screen, no workspace) |
| `WORKING` (including overnight) | Today |
| `ON_PAID_BREAK` / `ON_MEAL_BREAK` | Time Clock, where the break can be ended |

- While the state is loading, or if the fetch fails, the gate shows a loading or error screen with Retry and Lock. It never falls through to the workspace.
- `DEVICE_INVALID` / `DEVICE_REVOKED` / `IDENTITY_UNAUTHORIZED` from this fetch run M04 recovery as before.

**Clock-In Landing**
- Left side: the employee's name, the current date and time in the business timezone, a "Not clocked in" badge, Clock In and Lock.
- Right side: the employee's own current week from My Time (total, paid and meal breaks, worked time per day). It has no navigation and no editing.
- Duplicate taps are ignored. An uncertain outcome keeps its idempotency key for the retry. A 409 re-checks the state from the server.
- Only a server-returned `WORKING` enters Today.

**Clock Out**
- The confirmation is unchanged.
- After the server confirms `OFF_CLOCK`, the Time Clock calls the existing Lock with a "You are clocked out" notice. This revokes only the employee session and returns to the universal PIN keypad.
- The registered device and the account sign-in are untouched, and no extra time event is written.
- Returning later, even the same day, finds `OFF_CLOCK` and goes to the landing again.

## 9. Deactivation and M06 follow-ups

- Deactivating an employee with an open shift does **not** fabricate a CLOCK_OUT. The ledger stays honest: the shift remains open and the employee can no longer act.
- **M06 must add:**
  - manager timesheets over `(business_id, occurred_at)`;
  - a correction mechanism, such as appended correction events with a distinct `source` and actor, rather than edits;
  - reconciliation of orphaned open shifts;
  - the resolve workflow for `employee_time_issues`.

## 10. Tests

- `tests/m05-time-clock-sql.test.cjs`: real PostgreSQL via PGlite with the M04 and M05 migrations and Supabase-like default grants.
- `tests/m05-time-clock-api.test.cjs`: real M04 PIN/Lock and M05 handlers over PGlite.
- `tests/m05-time-calculation.test.cjs`.
- `tests/native-time-clock.test.cjs`.

The two PGlite suites need `ZUDE_PGLITE_MODULE=/path/to/@electric-sql/pglite/dist/index.cjs` (PGlite is not a project dependency); otherwise they report as skipped.

**PGlite limitation:** PGlite is single-connection, so it serializes concurrent calls itself. The advisory lock and in-transaction re-checks are verified structurally there, not under true parallelism. Verify concurrent double-tap behavior against the real database.

## 11. Requires live verification

- Applying the migration.
- Concurrent requests against real Postgres.
- The physical iPad flow: clock in, Lock, unlock and still working; background; both breaks; clock out during a break; My Time totals in the business timezone.
