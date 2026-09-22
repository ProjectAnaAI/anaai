# Voice appointment management checkpoint

Implementation is complete in the working tree. Migration 008 is **not applied**.
No database or historical appointment data was changed during implementation.

## Architecture and reuse

The information-only receptionist previously rejected appointment actions, and
there was no existing-appointment state in the signed Voice handler. Dashboard
RPCs require an authenticated member; service-role Voice calls cannot satisfy
that contract and must not impersonate a member.

The handler now dispatches explicit cancellation/rescheduling intent before its
information fallback. New-booking dispatch and its conversation remain intact.
Human transfer still preempts both flows, including the bare word `person`.

Migration 008 moves the existing 007 rescheduler implementation into
`anaai_private.reschedule_appointment_core`. The public manual entry point keeps
its original signature, SECURITY INVOKER, ACL and user/membership checks. The
private invoker core also checks membership for non-service requests, preserving
RLS defense in depth. Its authenticated EXECUTE grant is required for the
existing invoker wrapper, exactly as with the private capacity helper; it is not
a public Voice RPC. The core adds check-only mode and changes capacity acceptance
to explicit `AVAILABLE` (NULL fails closed). A source-equivalence test pins the
remaining scheduling body to 007.

Likewise, the existing completion-era lifecycle executor becomes a fully revoked
private core. The existing `_appointment_lifecycle_action` entry point retains
its guards, security mode and ACL. The private core can accept the Voice bridge's
already-claimed ledger row, preventing a second action claim and preserving
ledger-before-date-before-appointment lock ordering. Manual callers use its
ordinary claim path. The cancellation transition and outbox logic are shared.

No booking, legacy AI, capacity checker, or applied migration file was rewritten.

## State machine and conversation

`management.action`: `cancel | reschedule`.

- `select`: resolve a unique upcoming appointment. Persist selectors, not a list
  of candidate customers. Ambiguity asks for service/date/time. A replacement
  supplied in the initial request survives target clarification.
- `replacement`: collect replacement date and time. A bare clock hour asks AM/PM.
  Date-only corrections preserve time; time-only corrections preserve date.
  Corrections invalidate availability, including unparseable corrections.
- `confirm`: cancellation has a selected target; rescheduling also has a complete
  replacement and authoritative check-only receipt. Speak the exact target or
  old-to-new schedule. Only a separate whole-turn affirmative or DTMF 1 commits.
- DTMF 2 or a plain decline ends without mutation. Low/invalid-confidence speech
  cannot authorize. A detail-bearing affirmative is a correction. Changing action
  clears confirmation. Backend conflicts return to replacement collection with a
  new operation key; uncertain results stop without claiming success.

State includes action, stage, operation UUID, selected appointment/customer/service
IDs, service label, original schedule/status, selector fields, replacement fields,
AM/PM options, and availability verification. It includes no phone, customer name,
transcript or secret. Exact-key validation rejects impossible combinations. Existing
AES-GCM, call/business/ingress binding, token-size cap, lifetime and turn limits stay
in force. The selected target's business is checked against the encryption binding.

## Identity and authorization

The signed Twilio webhook resolves the business from `To`; the trusted server passes
`From` through the same E.164 normalization rules as existing Voice booking.
Management does not accept a customer phone, customer UUID, or appointment UUID from
speech as authorization. Trial ingress retains its existing protected ingress policy.

The database requires exactly one business-scoped customer with that canonical
stored phone. Archived customers may match; duplicate phone records fail closed.
Only that customer's future `Booked`/`Confirmed` appointments are returned. Lookup
returns at most 20 appointments and rejects overflow rather than truncating into a
false unique match. Missing timezone, unresolved schedule, non-minute times, bad
identity, and malformed receipts fail closed. No names/phones are returned.

The commit bridge checks the customer again, takes ordered business/date advisory
locks, locks the selected appointment, and checks its expected customer, service,
service label, date, time and status. Stale target summaries fail. A customer row
share lock protects against concurrent phone reassignment during the transaction.

The two public Voice RPCs are SECURITY DEFINER, pinned to `pg_catalog, public`,
revoked from PUBLIC/anon/authenticated, granted only to service_role, and additionally
check `auth.role()`. They never use phone callers as business members.

## Exact signatures

```sql
public.voice_find_appointments_business(
  p_business_id uuid, p_caller_phone text
) returns jsonb

public.voice_manage_appointment_business(
  p_business_id uuid, p_caller_phone text, p_appointment_id uuid,
  p_action_type text, p_idempotency_key uuid, p_request_fingerprint text,
  p_expected jsonb, p_date date default null, p_time time default null,
  p_check_only boolean default false
) returns jsonb

anaai_private.reschedule_appointment_core(
  p_business_id uuid, p_appointment_id uuid, p_customer_id uuid,
  p_service_id uuid, p_appointment_date date, p_appointment_time time,
  p_notes text default null, p_check_only boolean default false
) returns jsonb

anaai_private.appointment_lifecycle_core(
  p_business_id uuid, p_appointment_id uuid, p_idempotency_key uuid,
  p_request_fingerprint text, p_action_type text,
  p_preclaimed_action uuid default null
) returns jsonb

anaai_private.voice_customer(p_business_id uuid, p_caller_phone text) returns uuid
```

The existing public reschedule and private-public lifecycle entry point signatures
remain unchanged. `cancel_appointment_atomic_business` and
`schedule_appointment_idempotent_business` remain unchanged and continue through
those entry points.

## Scheduling, lifecycle, retries and receipts

Rescheduling retains the selected service/customer and existing Booked/Confirmed
status. Notes follow the original reschedule contract. The current active service's
duration determines the replacement interval and refreshes `duration_minutes`.
Deleted/inactive/unusable services cannot be rescheduled. Cancellation does not
require a current service and preserves the historical duration snapshot.

The unchanged 007 capacity helper uses snapshots, peak simultaneous occupancy,
half-open intervals, Booked + Confirmed occupancy, and target self-exclusion.
Cancelled/Completed consume no capacity. Unresolvable competing schedules fail
closed. Check-only and commit use the same scheduler; commit checks capacity again
under the shared date locks. Completed/Cancelled targets cannot be resurrected.

The ledger claim precedes date locks and row locks. The database binds both the
fingerprint and canonical structured request, including original target snapshot
and resolved customer. Same-key retries return the original bounded receipt;
different fingerprints/payloads fail. Internal errors roll back the claim, mutation
and notification together. A replay message describes the original outcome and
explicitly says that the retry made no new change.

Application success requires the expected business, appointment, customer, service,
action, action UUID, APPLIED/changed/success, replay boolean and action-outcome scope.
Cancellation additionally requires Cancelled and the original schedule. Rescheduling
requires the replacement schedule, original status and a positive integer duration.
Availability receipts must match target/customer/service/business and replacement.

The outbox is created transactionally. Management does not attempt SMS delivery or
claim that a text was sent. Existing new-booking SMS failure isolation is untouched.
New diagnostics contain fixed stage/result categories or database SQLSTATE only;
no raw RPC payloads, IDs, phones, names, state tokens, transcripts or secrets are logged.

## Manual application and acceptance

1. Review `supabase/migrations/202609210008_voice_appointment_management.sql` and
   confirm 007 is already applied. Keep `anaai_private` outside PostgREST's exposed
   schemas. Use the same trusted migration owner as the existing definer functions.
2. Manually execute **only 008** in the Supabase SQL editor (the file includes its
   transaction). Do not reapply 002–007 or run any historical backfill.
3. Inspect `pg_get_functiondef` and ACLs for the signatures above and the retained
   manual wrappers. Anon/authenticated must not execute either public Voice bridge.
4. On disposable future test appointments, validate the cases below before real
   callers use management. This implementation session did not execute them.

Database acceptance cases:

- Correct business + unique caller resolves only that customer's rows; wrong tenant,
  wrong phone, duplicate phone, missing timezone and terminal targets fail closed.
- Check-only writes no appointment, ledger or notification. Cancel/reschedule each
  writes one action and one outbox row; the same confirmation retried concurrently
  yields one original action and replay receipts. Changed fingerprint or payload
  with the same key fails. Inject an internal failure to verify complete rollback.
- Race Voice versus manual scheduling on capacity 1 and capacity >1; inspect peak
  occupancy and action count. Test opposite-direction cross-date moves and a stale
  target moved while waiting for its date lock. Verify no success on stale locks.
- Self-exclusion, adjacent half-open intervals, sequential overlapping intervals
  whose peak is below capacity, and genuinely over-capacity intervals.
- Existing snapshot overrides an edited/deleted service; current duration refreshes
  on a successful move; an unresolved competing historical schedule rejects.
  Cancellation of an identifiable deleted-service appointment keeps its snapshot.
- Confirmed stays Confirmed on move; Completed/Cancelled cannot be changed by a
  fresh Voice action. A retry of an earlier completed action returns original outcome.
- Repeat manual confirm/cancel/complete/reschedule and AI/new-Voice booking checks.
- Real Twilio calls: cancellation, reschedule, AM/PM clarification, correction,
  disambiguation, DTMF, low confidence, and human handoff in each management stage.

## Automated coverage and limitations

`tests/voice-appointment-management.test.cjs` runs real TypeScript through the
repository's VM test pattern, with deterministic dates and mocked database transport.
It covers parsing, state transitions, encrypted tokens, receipt validation, webhook
handler dispatch and replay, handoff, authorization boundaries and SQL source
contracts. Existing capacity/snapshot tests exercise the shared algorithm's semantics.
SQL-source checks and mocked races are **not PostgreSQL concurrency/RLS execution**.
The existing opt-in local database integration test remains skipped without fixtures.

Caller-number matching is the selected identity policy, not an OTP challenge. It
cannot distinguish people sharing a number or independently establish ownership of
a caller-ID number. Unmatched and ambiguous records require human help. Parsing is
deterministic and bounded; unsupported wording asks for clarification. There is no
model mutation authority. More than 20 upcoming appointments requires human help.

## Files inspected

- `AGENTS.md`, `package.json`, local Next.js guide
  `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`.
- `app/api/voice/route.ts`, `app/api/appointments/route.ts`, `app/api/ai/route.ts`.
- `lib/voice-handler.ts`, `lib/voice-state.ts`, `lib/voice-slots.ts`,
  `lib/voice-parsing.ts`, `lib/voice-understanding.ts`, `lib/voice-receptionist.ts`,
  `lib/voice-booking.ts`, `lib/voice-config.ts`, `lib/business-context.ts`,
  `lib/appointment-actions.ts`.
- `supabase/migrations/202609150003_appointment_action_foundation.sql`,
  `202609150004_classify_ai_booking_rejections.sql`,
  `202609160001_voice_booking_bridge.sql`,
  `202609180002_harden_business_tenant_invariants.sql`,
  `202609190001_add_appointment_completion.sql`,
  `202609190003_voice_customer_lifecycle.sql`,
  `202609210002_appointment_capacity_checker.sql`,
  `202609210003_capacity_based_manual_scheduling.sql`,
  `202609210004_voice_capacity_availability.sql`,
  `202609210005_voice_capacity_booking.sql`,
  `202609210006_capacity_based_legacy_ai_booking.sql`,
  `202609210007_appointment_duration_snapshot.sql`.
- `tests/voice-conversation.test.cjs`, `tests/voice-receptionist.test.cjs`,
  `tests/voice-capacity.test.cjs`, `tests/appointment-duration-snapshot.test.cjs`,
  `tests/atomic-appointments.integration.cjs`, and the current diffs in
  `tests/voice-parsing.test.cjs`, `tests/voice-understanding.test.cjs`,
  `tests/appointment-capacity.README.md`.

## Files changed for this checkpoint

Created:

- `lib/voice-appointment-management.ts`
- `supabase/migrations/202609210008_voice_appointment_management.sql`
- `tests/voice-appointment-management.test.cjs`
- `tests/voice-appointment-management.README.md`

Extended existing work:

- `lib/voice-handler.ts` — dispatch and management gathers; bare-person handoff.
- `lib/voice-state.ts` — management union, validator and target business binding.
- `tests/voice-conversation.test.cjs` — load the new handler dependency.
- `tests/voice-receptionist.test.cjs` — load the new handler dependency.

All other pre-existing dirty files are retained without edits by this checkpoint.

## Observed validation results

| Command | Result |
|---|---|
| `node --test tests/voice-appointment-management.test.cjs` | 64 passed, 0 failed |
| `node --test tests/voice-*.test.cjs` | 380 passed, 0 failed (includes management) |
| `node --test tests/appointment-capacity.test.cjs tests/voice-capacity.test.cjs tests/legacy-ai-capacity.test.cjs` | 112 passed, 0 failed |
| `node --test tests/appointment-duration-snapshot.test.cjs` | 28 passed, 0 failed |
| `node --test tests/appointment-lifecycle.test.cjs tests/phase2-actions.test.cjs tests/atomic-appointments.test.cjs tests/ai-actions.test.cjs tests/ai-booking-rejections.test.cjs` | 141 passed, 0 failed |
| `node --test tests/*.test.cjs tests/*.integration.cjs` | 751 total: 750 passed, 0 failed, 1 skipped (opt-in local database integration) |
| `npx tsc --noEmit` | Passed, exit 0 |
| `git diff --check` | Passed, exit 0 |
| `npx next build` | Failed twice: Turbopack CSS processing could not bind a local port (`Operation not permitted`) |
| `npx next build --webpack` | Passed, exit 0; all 22 static pages generated |

The default build was also retried with requested local build permissions; the
same process/port restriction persisted. Webpack completed the production build.
No application configuration was changed to switch bundlers.

No commit, push, migration application, env/secret edit, reset, stash, clean,
revert, restore, checkout, or historical-appointment modification was performed.
Applied migration files 002–007 were not edited.

Final `git status --short` (includes the user's preserved pre-existing changes):

```text
 M lib/voice-booking.ts
 M lib/voice-config.ts
 M lib/voice-handler.ts
 M lib/voice-parsing.ts
 M lib/voice-state.ts
 M lib/voice-understanding.ts
 M tests/appointment-capacity.README.md
 M tests/voice-parsing.test.cjs
 M tests/voice-receptionist.test.cjs
 M tests/voice-understanding.test.cjs
?? lib/voice-appointment-management.ts
?? lib/voice-slots.ts
?? supabase/migrations/202609210004_voice_capacity_availability.sql
?? supabase/migrations/202609210005_voice_capacity_booking.sql
?? supabase/migrations/202609210006_capacity_based_legacy_ai_booking.sql
?? supabase/migrations/202609210007_appointment_duration_snapshot.sql
?? supabase/migrations/202609210008_voice_appointment_management.sql
?? tests/appointment-duration-snapshot.README.md
?? tests/appointment-duration-snapshot.test.cjs
?? tests/legacy-ai-capacity.test.cjs
?? tests/voice-appointment-management.README.md
?? tests/voice-appointment-management.test.cjs
?? tests/voice-capacity.README.md
?? tests/voice-capacity.test.cjs
?? tests/voice-conversation.test.cjs
```
