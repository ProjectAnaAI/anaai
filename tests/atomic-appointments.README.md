# Atomic appointment validation

Nothing in these tests applies migrations. No hosted database was used during implementation.

## Local mocks

Run `node --test tests/atomic-appointments.test.cjs tests/atomic-appointments.integration.cjs`.
The integration test skips unless explicitly enabled. Mocks check routing, error mapping,
no fallback writes, and post-RPC SMS behavior. SQL text checks verify selected contract
properties, not SQL compilation, RLS correctness, rollback, or concurrency.

## Opt-in local PostgreSQL scaffolding

After separately reviewing/applying the migration to a disposable LOCAL Supabase database,
prepare a member account, business with valid hours, customer, active service with a positive
duration, and a completely empty open date/slot. Set:

- `ANAAI_RUN_LOCAL_SCHEDULING_TESTS=1`
- `ANAAI_LOCAL_SUPABASE_URL` (only localhost/127.0.0.1/::1 allowed)
- `ANAAI_TEST_ANON_KEY`, `ANAAI_TEST_USER_TOKEN` (authenticated test user, never service-role)
- `ANAAI_TEST_BUSINESS_ID`, `ANAAI_TEST_CUSTOMER_ID`, `ANAAI_TEST_SERVICE_ID`
- `ANAAI_TEST_DATE`, `ANAAI_TEST_TIME`, `ANAAI_TEST_SECOND_DATE` (another empty open date)

Run `node --test tests/atomic-appointments.integration.cjs`.
This creates one appointment, reschedules it to the same slot, runs competing
cross-date moves of that appointment, and moves it back. It intentionally does not
clean up data automatically. Use a fresh disposable fixture for another run.

## Required database acceptance tests before release

Use independent authenticated transactions with explicit start/lock barriers, repeat each
race, and inspect committed rows. Concurrent HTTP starts alone may execute sequentially.

- Create/create, create/AI, create/reschedule, reschedule/AI, and two different appointments
  moving to one slot: exactly one conflicting destination acquisition succeeds.
- Adjacent half-open intervals succeed; partial overlaps with different start times fail.
- Different businesses can book the same time. Verify membership rejection directly at RPC.
- Two edits of one appointment serialize and recheck its current status. Last successful
  request may win; there is no optimistic version/idempotency contract in this milestone.
- Source and destination dates are locked once each in chronological DATE order, before the
  appointment row lock. Opposite-direction cross-date moves terminate without lock cycles. A conflicting old
  interval can cause a conservative rejection; simultaneous swaps are not supported.
- Hold a source-date advisory lock in transaction A, start a reschedule in B so its
  preliminary read completes and it waits, then move the appointment in A to a third
  date using the RPC and commit. B must return SOURCE_DATE_CHANGED and must not
  change any field from A's committed result. Repeat with deletion/status changes
  before the locked reread. Verify same-date changes serialize using current row state.
- Same-slot reschedule excludes itself. Failed reschedule leaves every column unchanged,
  including user_id, status, customer/service IDs, snapshots, notes, date/time.
- Cross-business/missing customer/service, inactive service, nonpositive/null duration,
  invalid dates/times, closed day, malformed/missing hours, before opening/after closing fail.
- Booked/Confirmed block; Cancelled/Completed do not. Neither terminal status can reschedule.
- Existing service lookup includes inactive services, then legacy name fallback. Missing or
  ambiguous duration information fails closed. Customer creation never occurs.
- DB snapshots override spoofed client fields; create sets user_id=auth.uid(); reschedule
  preserves the original user_id even when another member performs it.
- Exercise RLS with rows created by a different member: the invoker must see ALL blocking
  appointments in the business. Restricted visibility would invalidate overlap checks.
- Check effective EXECUTE permissions, READ COMMITTED, and identical DateStyle/lock keys
  across the existing AI RPC and both new functions.
- Verify normal SMS failure and unexpected notification exceptions leave mutation success.
  Missing RPCs must fail safely; deploy the approved migration before the application.

## Boundaries retained deliberately

No global overlap trigger/exclusion constraint, direct-table-write lockdown, status redesign,
service-duration snapshot, or customer creation was added. Direct writes and generic status
reactivation can still bypass this protocol. Concurrent service/hours edits are not serialized
with scheduling. Intervals use business-local date/time and same-day hours; no overnight or
DST redesign. Live legacy overnight/invalid rows need review before relying on same-date checks.
The index is created normally inside the migration transaction and can briefly block writers;
review deployment timing and table size. No SQL has been executed against production.

## Latest-profile JSON regression

Both RPCs now select the newest business_hours as TEXT, explicitly reject no row/NULL,
and only then cast that variable to jsonb in a separate PL/pgSQL statement. Malformed
historical rows are never parsed; a malformed newest row still fails safely.
Local tests assert the SQL statement boundary and exercise a mocked selection/parser.
They do not prove PostgreSQL scheduling behavior. In a disposable database fixture test
BOTH RPCs with: valid newest plus malformed older rows (success at a free open slot),
malformed newest (INVALID_HOURS), no visible profile (INVALID_HOURS), and NULL hours
(INVALID_HOURS). Assert failed reschedules preserve the complete original row. Do not
repair/delete historical production rows as part of deploying this correction.
