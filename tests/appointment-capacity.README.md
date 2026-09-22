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

## Scheduling paths and their capacity status

| Path | Function | Capacity |
|---|---|---|
| Manual create | `create_appointment_atomic_business` | 202609210003 |
| Manual reschedule | `reschedule_appointment_atomic_business` | 202609210003 |
| Voice availability | `voice_check_appointment_availability` | 202609210004 |
| Voice booking | `voice_book_appointment_business` | 202609210005 |
| AI chat booking | `book_appointment_atomic_business` | 202609210006 |

**All five scheduling paths now share one capacity rule** and take the
byte-identical business/date advisory lock
`hashtext(p_business_id::text || ':' || p_appointment_date::text)`, so they
serialize against each other.

> **Superseded by `202609210007`.** That migration adds
> `appointments.duration_minutes`, a durable per-appointment duration snapshot,
> and restates the capacity helper plus all four writers to record and prefer
> it. The definitions in 002, 003, 005 and 006 are applied history and must not
> be edited, but they are no longer the live bodies. Read
> `tests/appointment-duration-snapshot.README.md` before changing any of them.
>
> It exists because `appointments.service_id` is `ON DELETE SET NULL`: deleting
> a service made its historical appointments' durations unknowable, which
> correctly failed closed and blocked every later booking on that business/date.

### `book_appointment_atomic_business` (202609210006)

This function has no `CREATE FUNCTION` anywhere in this repository or in git
history — it predates the repo. 202609210006 therefore restates the deployed
body obtained from `pg_get_functiondef`, **verbatim**, with exactly one region
changed: the per-appointment overlap loop becomes a call to the shared helper.
The four declarations that loop owned (`v_existing`, `v_existing_duration`,
`v_existing_start`, `v_existing_end`) are dropped and `v_capacity` added.

Because the repository cannot cross-check that body, the migration's fidelity
is pinned by `tests/legacy-ai-capacity.test.cjs`, which asserts the signature,
SECURITY INVOKER, `search_path`, the `auth.uid()` and membership guards, the
lock expression, all 17 unrelated reason strings, the customer
lookup/create/update shape, the appointment insert and the full success
receipt. **Treat any future edit to this function as requiring a fresh
`pg_get_functiondef` comparison.**

Points worth knowing when reviewing it:

- It is reachable only through `public.schedule_appointment_idempotent_business`
  with `p_operation = 'ai_book'`, whose sole caller is `app/api/ai/route.ts`.
- **No grant was added or needed.** 202609210002 already grants schema USAGE
  and function EXECUTE to `authenticated` and `service_role`, which covers both
  callers of this SECURITY INVOKER function.
- `anon` holds EXECUTE on the outer function but **not** on the capacity
  helper. Its `auth.uid()` guard is load-bearing for *permissions*, not only
  authorization: it returns before the helper is reached, so an unauthenticated
  caller still gets `'Authentication is required.'` rather than a permission
  error. A test pins that ordering.
- `search_path` is `'public'` only, so `anaai_private` is not on the path and
  the call must stay schema-qualified.
- Rejections must be exactly `{"success": false, "reason": "<exact string>"}`
  with no other key — 202609150004 raises otherwise. Capacity reuses
  `'That time overlaps an existing appointment.'`; a malformed existing
  schedule reuses `'An existing appointment does not have a valid service
  duration, so availability cannot be checked safely.'`
- An indeterminate capacity result **raises**. This function has no top-level
  exception handler, so it propagates to the wrapper's handler, which rolls
  back the whole invocation including the durable action claim and returns
  `INTERNAL_ERROR`. Nothing is written; retry with the same key is permitted.

### Pre-existing items NOT addressed here

- `if not public.is_business_member(p_business_id)` is **not** wrapped in
  `coalesce(..., false)` as the manual RPCs are. A NULL return would make the
  guard fall through. Preserved verbatim because this patch had no evidence to
  change authorization behaviour; worth a separate hardening pass.
- `search_path=public` rather than `pg_catalog, public`, already recorded as
  outstanding by 202609150004.
- The deployed ACL (postgres, anon, authenticated, service_role) is untouched;
  `CREATE OR REPLACE` preserves it. Tightening `anon` is a separate decision.

## Boundaries retained deliberately

The dashboard, calendar and any capacity editing UI are out of scope;
`appointment_capacity` has no client-side authority and no UI surface yet. No
exclusion constraint or trigger was added, so direct table writes still bypass
the capacity protocol.
