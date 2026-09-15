# Phase 2 hardened appointment actions — forward correction pending

Foundation `202609150003_appointment_action_foundation.sql` is already deployed.
Review and deploy only the new forward correction
`supabase/migrations/202609150004_classify_ai_booking_rejections.sql` for this fix.
No production SQL was executed by the agent. The historical manual migration and live booking/reschedule definitions are
not replaced. No version, snapshot, voice, or legacy-user-RPC change is included.

## Database API

- `confirm_appointment_atomic_business(p_business_id uuid, p_appointment_id uuid,
  p_idempotency_key uuid, p_request_fingerprint text) returns jsonb`
- `cancel_appointment_atomic_business` has the same signature.
- `schedule_appointment_idempotent_business(p_business_id uuid,
  p_idempotency_key uuid, p_request_fingerprint text, p_operation text,
  p_request jsonb) returns jsonb`
- `claim_appointment_notification(p_business_id uuid, p_action_id uuid) returns jsonb`
- `finish_appointment_notification(p_business_id uuid, p_notification_id uuid,
  p_claim_token uuid, p_status text, p_provider_id text default null) returns boolean`

`p_operation` is manual_book, ai_book, or reschedule. Structured scheduling input:
service_id, customer_id (manual/reschedule), appointment_id (reschedule), date,
time, notes; AI additionally supplies customer_name, customer_phone, optional
customer_email, and an origin_hash binding its HTTP message. The wrapper calls the
existing corresponding atomic RPC. It does not copy its availability algorithm.

Private `_appointment_lifecycle_action` is revoked from PUBLIC/anon/authenticated.
All elevated entry points explicitly verify auth.uid and business membership.
Trusted migration-owned SECURITY DEFINER is necessary for the non-client-writable
ledger/outbox. Review live function owners, custom/inherited grants, public-schema
CREATE privileges, helper definitions and the existing RPCs before deployment.
Existing SECURITY INVOKER scheduling functions run under the wrapper's effective
role; explicit membership/reference validation in the underlying functions and
wrapper remains essential. No service-role application client is introduced.

New table RLS enables membership SELECT. Direct authenticated INSERT/UPDATE/DELETE
are revoked with no write policies. Notification SELECT excludes payload/claim token.
The notification/action composite FK enforces tenant equality and ON DELETE NO ACTION:
a referenced action cannot be deleted by cascading away delivery history. Separate
business deletion cascades remain; actor deletion nulls actor_user_id. Appointment
IDs retain historical identity without an appointment FK, including after deletion.

## Idempotency and completion

UNIQUE(business_id,idempotency_key) serializes competing calls. Insertion waits for
the winner's commit/rollback; replay uses a fresh READ COMMITTED snapshot. Key,
action, fingerprint and target bind lifecycle intent. Scheduling additionally stores
and compares canonical structured request_payload, preventing callers from reusing
a fingerprint with different arguments. Booking stores generated appointment identity
separately from its NULL original target in request_payload.

Unfinished claims have completed_at SQL NULL, success=false, changed=false, result
SQL NULL. Completed claims require a nonempty JSON receipt object. changed implies
success. No durable pending-action recovery system is introduced. Mutation, receipt,
and notification enqueue share one transaction/protected block.

Unexpected failures roll back the claim, mutation and notification together; they
are NOT persisted terminal outcomes, because nothing from the action committed and
retry is permitted. Manual scheduling/lifecycle controlled business-rule failures
are persisted and replayed. The forward correction maps only the 19 exact legacy AI reason strings verified by
the project owner; the complete allowlist is in 150004. These rejection paths occur
before customer/appointment writes and now persist success=false, changed=false
receipts with stable codes. Replays return the same rejection without calling the
legacy RPC or enqueueing a notification. Raw reason text is never persisted in a
receipt or exposed. Unknown reasons, malformed failure shapes, SQL exceptions and
invariant violations still roll back and return INTERNAL_ERROR. No new customer
survives an unexpected AI wrapper failure. The legacy RPC itself is unchanged. A deliberate new action after a
persisted rejection needs a new key; editing form payload produces one.

## Lifecycle and locks

| Initial | Confirm | Cancel | Reschedule |
|---|---|---|---|
| Booked | Confirmed | Cancelled | Allowed |
| Confirmed | successful no-op | Cancelled | Allowed |
| Cancelled | Reject | successful no-op | Reject |
| NULL/unknown/other | Reject | Reject | Reject |

Claim precedes scheduling advisory locks; date locks precede appointment row lock.
Lifecycle discovers source date, locks that date, then rereads/locks target and rejects
a changed source date. Legacy NULL dates have no bucket but still use row locking.
Reschedule takes source/destination date locks in chronological order, rechecks source,
then invokes the existing RPC under those same locks. Same-date locks are deduplicated.
READ COMMITTED and consistent DateStyle with the AI RPC remain required.

Identical reschedule customer/service/date/time/normalized-notes is a no-op after
checking current status and tenant customer/active-service validity. No-op does not
re-evaluate hours or refresh appointment fields: it changes no capacity. Other edits
use the existing RPC, including its hours/duration, overlap and self-exclusion checks.
Only changed date/time/service enqueues reschedule SMS, preserving existing product
behavior for notes/customer-only edits. Manual creation still does not enqueue SMS.

No version means same-date concurrent edits are serialized, not optimistically rejected.
The locked current appointment determines the outcome. Existing direct table writers
and old callable RPCs are not retired here: they can bypass idempotency/lifecycle policy.
This is a remaining compatibility boundary, not a global database invariant claim.

## Receipts/application boundary

Receipts contain success, changed, code, replayed, action_id, action_type, business_id,
appointment_id, receipt_scope='action_outcome', completed_at; successful receipts include
status and the committed appointment. Lifecycle adds previous_status; booking/reschedule
add customer_id, service_id, service, date, time for strict AI receipt validation.
APPLIED means success/changed true. ALREADY_IN_TARGET_STATE means success true/changed
false. Replays return original outcome with replayed true, not current appointment state.

The API verifies receipt identity/action/tenant/target/status; scheduling also verifies
selected customer/service/date/time. AI retains its strict Phase 1 booking validator.
All wording is server-authored. Replayed successes explicitly describe the original
action; no-op wording says no new change. SMS errors cannot convert action success
to failure. Metadata-only generic PATCH is no longer accepted; existing form edits
send the full scheduling intent. Notification type supplied by the browser is ignored.

Fingerprints are SHA-256 of sorted structured JSON. Service/customer/appointment IDs,
time, notes and AI customer fields are canonicalized. Equivalent PostgreSQL time
representations and common US phone formatting produce equivalent intent. The model
never provides the key. Manual forms keep a UUID for the current submitted intent in
memory and optional per-tab sessionStorage until success; changed submissions get a
different key. The storage signature includes authenticated user and business. Retry
after a network failure or re-entering the identical intent after same-tab refresh
retains it. Closing the tab/blocked storage can lose identity: check appointments
before repeating an uncertain operation when the original key is unavailable.

Live AI callers must supply a stable Idempotency-Key header across retries. Before
model interpretation the API looks up the key and checks the separately stored message
origin hash. Same key with changed origin rejects. Concurrent different interpretations
of the same message conflict at the structured database payload binding, not mutate twice.
Test AnaAI remains preview-only and requires no live action key. AI reschedule/confirm/
cancel remain disabled: safe appointment selection needs explicit conversation context.

Manual prospective customer creation remains the existing separate flow. Retained
selection prevents duplicate creation after appointment conflict, but a lost response
to a name-only customer insert itself has no durable customer idempotency guarantee.

## Notifications

Unique(action_id,channel,kind) prevents duplicate enqueue. Actual booking/lifecycle
changes and applicable reschedules enqueue; no-op/replay never enqueue. Stored
notification payload contains recipient/date/time/action, freezing notification intent
rather than rereading a potentially changed appointment at send time.

Claim changes pending -> uncertain with a random token BEFORE provider I/O. Only one
claim wins. Finish consumes that token and records accepted/failed/uncertain with a
fixed error code. Provider acceptance is not delivery. Definite preflight failures
are failed; provider exceptions are conservatively uncertain. A crash after acceptance
but before recording leaves uncertain and is never blindly resent. Replaying an action
may claim a previously pending notification (crash before claim), but cannot reclaim
accepted/failed/uncertain. No worker/reconciliation or automatic resend is introduced.

A member who can invoke notification RPCs can report provider state for a claimed send;
this is not cryptographic provider attestation. Delivery webhooks/reconciliation and
stricter server-only notification authority remain future work. No exactly-once delivery
claim is made. Keep action keys until a defined expiration/tombstone policy exists;
no automatic retention cleanup is introduced.

## Local validation and required database/browser checks

Run `node --test tests/*.test.cjs`, plus `npx tsc --noEmit` and `git diff --check`.
Phase 2 tests run actual TypeScript helpers/API handlers with an in-memory DB protocol
double; SQL tests inspect contracts. They do NOT compile or execute PostgreSQL.
The existing integration harness is explicitly opt-in/local-only and targets manual
RPCs. No psql/docker/local DB was available here, so database tests were not fabricated.

Before production, in an isolated database with the verified live functions/schema:
1. Compile the full migration; verify grants, helper ownership, member reads, denied
   direct DML/private execution and hidden notification claim tokens.
2. Race identical keys for all four actions. Assert one mutation, one stored result,
   same receipt on replay, at most one applicable notification/customer/appointment.
3. Change fingerprint/action/target/payload under the same key: no writes, conflict.
4. Test the full status matrix, NULL/unknown, no-op, cross-tenant and zero-row cases.
5. Race reschedule/create/AI booking, opposite date moves and confirm/cancel; verify
   lock order, half-open overlap, self-exclusion and SOURCE_DATE_CHANGED rejection.
6. Inject failures after inner scheduling, after notification enqueue and before
   receipt completion. Everything rolls back; no false successful ledger row remains.
7. Reject invalid completion states, verify action deletion cannot remove notifications,
   and independently verify existing business-delete and actor-delete behavior.
8. Race notification claims; crash before send and after provider acceptance; assert
   uncertain/accepted rows are not automatically resent and replay never re-enqueues.
9. Browser: manual create, edit, confirm/cancel; inspect stable retry key on dropped
   responses, changed key for edits, replay/no-op wording and unchanged preview safety.
10. Live authenticated AI request with a caller-generated key: retry after commit before
    response, verify model is not rerun and original receipt is returned safely.
