# Capacity-based concurrent scheduling

Covers `202609210001` (column), `202609210002` (shared checker) and
`202609210003` (capacity-based manual create/reschedule).

Nothing in these tests applies migrations. No hosted database was used during
implementation, and no PostgreSQL binary was available in the authoring
environment, so **the SQL has not been compiled**.

## Local tests

Run `node --test tests/appointment-capacity.test.cjs`.

Two kinds of check, neither of which executes PL/pgSQL:

1. A JS port of `anaai_private.check_appointment_capacity_business` exercising
   the capacity matrix (status consumption, boundaries, peak concurrency,
   reschedule exclusion, fail-closed malformed rows). It is a transcription of
   the SQL, so it proves the *algorithm*, not the *implementation*. If the SQL
   changes, the port must change with it.
2. SQL text contracts over the migration files: helper placement and grants,
   statement ordering (lock → validation → capacity → mutation), preserved
   advisory-lock expressions, SECURITY INVOKER, lifecycle rules, and the return
   vocabulary.

## Capacity rule

`businesses.appointment_capacity` is the maximum number of simultaneously
active appointments. Booked and Confirmed consume one unit each; Cancelled and
Completed consume nothing. Intervals are the real service duration, half-open
`[start, end)`.

The decision is **peak simultaneous occupancy inside the requested interval**,
not a count of overlapping appointments:

```
capacity 2
existing  A 16:00-16:30   B 16:30-17:00
candidate 16:00-17:00                     -> AVAILABLE (peak with candidate = 2)
```

At capacity 1 this is byte-for-byte the previous "any overlap conflicts" rule;
the local suite asserts that equivalence across a swept start/duration grid.

## Security architecture

The helper is in the non-public `anaai_private` schema. PostgREST exposes only
`public`, so the helper has no client RPC surface even though `authenticated`
holds EXECUTE on it. EXECUTE is unavoidable: both scheduling RPCs are SECURITY
INVOKER and run as `authenticated` when a member calls them directly, so a
fully revoked helper would make them fail closed with `INTERNAL_ERROR`.

The repository's stronger pattern (`public._appointment_lifecycle_action`,
revoked from `authenticated` outright) is only reachable from SECURITY DEFINER
callers. Converting the manual scheduling RPCs to SECURITY DEFINER to reuse it
would remove the RLS defense-in-depth they rely on today and was deliberately
not done.

**Never add `anaai_private` to the PostgREST exposed-schema list.**

## Required database acceptance tests before release

Beyond everything already listed in `tests/atomic-appointments.README.md`,
which must all still pass unchanged:

- Compile both migrations against a disposable local database before anything
  else. No PL/pgSQL in this milestone has been executed.
- `select has_function_privilege('authenticated', 'anaai_private.check_appointment_capacity_business(uuid,date,time,integer,uuid)', 'execute')`
  is true, the same for `anon` is false, and a PostgREST `POST /rest/v1/rpc/check_appointment_capacity_business`
  with a member JWT returns 404, not a result.
- `select has_schema_privilege('anon', 'anaai_private', 'usage')` is false.
- Capacity 1 business: every pre-existing scheduling acceptance test passes
  with identical result codes to the deployed functions.
- Capacity 2 business: two simultaneous bookings succeed, a third is
  `SLOT_CONFLICT`; then the peak case above books successfully.
- Capacity raised from 1 to 2 with an existing appointment in place: the second
  concurrent booking succeeds without touching the first row.
- Capacity lowered below current occupancy: existing appointments are NOT
  mutated or cancelled; only new bookings into over-occupied intervals fail.
- Reschedule a Booked and a Confirmed appointment into a slot occupied only by
  itself: succeeds at capacity 1. Reschedule into a genuinely full interval:
  `SLOT_CONFLICT`, and every column of the row is unchanged.
- Cross-business: a member of business A cannot create, reschedule or observe
  capacity for business B. Two businesses at the same time never interact.
- Insert a Booked row whose service_id is missing and whose `service` name is
  absent/ambiguous, then attempt a booking in that interval: it must return
  `INVALID_EXISTING_SCHEDULE`, never succeed. Repeat with a matched service
  whose `duration_minutes` is NULL.
- Repeat the same malformed row with status Cancelled and Completed: booking
  must succeed, because terminal rows are never inspected.
- Concurrency: with capacity N, run N+1 competing transactions into one
  interval under the business/date advisory lock and confirm exactly N commit.
- RLS: create blocking appointments as a different member of the same business
  and confirm the invoker still counts them. Restricted visibility would
  under-count occupancy and overbook.
- Delete the business row mid-transaction / revoke visibility so the capacity
  read returns nothing: the RPC must return `INTERNAL_ERROR` and write nothing.

## Boundaries retained deliberately

Voice booking (`voice_book_appointment_business`), Voice availability
(`voice_check_appointment_availability`) and the legacy
`book_appointment_atomic_business` still use their own single-slot overlap
rules and are unchanged in this milestone. Until they adopt the shared helper,
a capacity > 1 business will have Voice under-book relative to manual
scheduling. The dashboard, calendar and any capacity editing UI are also out of
scope; `appointment_capacity` has no client-side authority and no UI surface
yet. No exclusion constraint or trigger was added, so direct table writes still
bypass the capacity protocol.
