# Hybrid phone receptionist and booking authorization review

## Scope of this checkpoint

The owner explicitly chose **keep phone booking disabled; prepare hybrid menu/state
and an authorization design for separate review**. No voice mutations, SMS,
booking drafts, migrations, or provider configuration changes are included.
The authenticated appointment/AI APIs and deployed scheduling migrations are unchanged.

Both ingress routes use the existing called-number routing, after their existing
authentication. Production remains signed-only. Trial requires its shared token;
that token is not equivalent to a signed Twilio payload and must remain private.
Business routing filters active Twilio numbers and resolves the associated business.
No business identifier from caller/model/state is used to authorize a request.

## Current call flow

- Initial speech + one-digit DTMF Gather includes the business name and options.
- 1: explain phone booking/changes are unavailable, offer informational help.
- 2: prompt for services, hours, location, or general business information.
- 3: controlled transfer-unavailable response. No Dial is emitted.
- 0: repeat menu. Unknown digits repeat the options with a short explanation.
- Speech continues through the existing fact-selection response boundary.
- Appointment requests cannot execute anything; no booking action module is imported.
- “Today” uses the business timezone's weekday to select listed hours. Invalid or
  absent timezone requires an explicit weekday; no live-open/holiday claim is inferred.
- Silence reprompts once, then hangs up. Goodbye/no thanks hangs up immediately.
- Every callback stays on the authenticated ingress; trial callbacks retain the token.

## Optional serverless state

`VOICE_STATE_SECRET` is a dedicated server-only 32-byte secret encoded as 64 hex
characters. Provision separately in the deployment environment if encrypted state
is wanted. This task does not set it, print it, or change deployment configuration.
Do not reuse the Twilio token or Supabase key. Rotation invalidates active tokens.

State travels as AES-256-GCM ciphertext in the Gather callback URL. Its authenticated
associated data is an HMAC over the freshly resolved business, opaque CallSid, and
ingress. This binds ciphertext to a call and business without embedding identifiers
in cleartext. Every callback authenticates and resolves routing before opening state.

The only state fields are version, mode, absolute expiration, turn count and silence
count. There are no customer details, transcripts, booking drafts or authorization
claims. Lifetime is 30 minutes, maximum 30 sequential turns, and one silence retry.
State can be decoded on any instance with the same configured key. It is not an
in-memory Map, and needs no database table or background cleanup job.

Malformed, tampered, expired, wrong-business, wrong-call and wrong-ingress state
fails closed with a controlled hangup. Goodbye issues no further state. There is
nothing persisted server-side to delete. Previously issued ciphertext expires;
there is no immediate token revocation or replay tracking. Limits are conversational
bounds, not abuse/rate-limit controls: an authenticated party can replay an older
callback. Future bookings MUST rely on the durable action ledger, not state counters,
for duplicate prevention.

If the key is unconfigured (or no valid CallSid exists), the previous stateless
read-only experience remains available. Silence still terminates after one retry;
there is no total-call turn limit in this fallback. Supplied invalid state is never
silently downgraded to a new session. No booking capability is gated merely on
possession of state or on this optional secret.

Do not log request/callback URLs: trial URLs contain the existing trial credential;
URLs with encrypted state contain an opaque session token. Application logs contain
fixed messages only. Check infrastructure access-log policies separately.

## Existing appointment infrastructure inspected

The reusable booking operation is:

```
schedule_appointment_idempotent_business(
  p_business_id uuid, p_idempotency_key uuid,
  p_request_fingerprint text, p_operation text, p_request jsonb
)
```

Use operation `ai_book`, which delegates customer reuse/creation and atomic booking
to `book_appointment_atomic_business`. Migration 150004 preserves 150003's ledger,
receipt, locking and outbox behavior while mapping exact known legacy rejections.
The outer operation re-reads the committed candidate appointment and verifies
business/service/date/time/customer relationships before completing a receipt.

The direct legacy booking function's complete live body is not in this repository.
Its signature, verified success contract and exact failure mapping are represented
by API code and 150004. Do not reconstruct or replace its live body from assumptions.

The existing `deliverActionNotification` helper claims the durable outbox intent,
then sends SMS, then records accepted/failed/uncertain delivery. Notification claims
prevent blind duplicate sending. SMS failure does not undo booking. Existing
notification RPCs also require `auth.uid()` and business membership.

`appointment-request-key.ts` is a browser/sessionStorage helper, unsuitable for
Twilio callbacks. The scheduling intent canonicalizer, fingerprint helper,
`bookingReceipt`, `actionReceipt`, `bookingRejection`, and durable DB ledger should
be reused by a future voice entry point rather than reimplemented.

## Authorization gap — decision required before phone mutations

Twilio ingress authenticates the provider, not a Supabase user. The server-only
Supabase secret supports existing read-only routing, but does not supply a member
`auth.uid()`. Passing that client straight to the booking/SMS RPCs does not satisfy
their explicit checks. Do not fix this by automatically selecting a business owner,
spoofing JWT claims, minting owner tokens, relaxing member checks, or directly writing
appointments/customers/outbox rows.

Recommended design for separate review:

1. Provision an explicit voice automation actor per enabled business. Its compatibility
   `user_id` and audit meaning must be approved, not inferred from the first owner.
   Avoid storing a staff password or long-lived owner access token.
2. Add a narrowly scoped, server-only database entry point restricted to the trusted
   server role. It must independently resolve an active called-number mapping and
   check explicit voice enablement/actor binding. Ordinary authenticated and anon
   users must not have EXECUTE. No caller-selected actor or business parameter may
   become an unverified authority.
3. Reuse the existing scheduling implementation through a private shared executor
   with explicit, already-validated actor context. Keep public member RPC authorization
   intact. Extract rather than duplicate the proven booking/ledger/locking code,
   after retrieving the complete deployed definitions and reviewing grants/RLS.
   This likely needs a forward migration; none is prepared or applied here.
4. Provide equally narrow access to notification claim/finish through the same
   trusted voice context. Reuse application SMS delivery; no provider calls in SQL.
5. Before allowing mutation on unsigned trial ingress, establish whether real-call
   metadata must be checked against Twilio's API. A leaked trial token permits
   fabricated To/From/CallSid; those values alone are not proof of a real caller.
   Keep trial narrowly controlled and never use Caller ID to authorize modification
   of an existing customer's appointments.

An alternative is an explicitly provisioned authenticated automation identity with
membership and secure short-lived credentials, allowing current RPCs unchanged.
Credential issuance, rotation, least privilege and audit semantics must be designed
before choosing that option. Neither approach is implemented by this checkpoint.

## Future booking state and action protocol (design only)

- Collect server-resolved active service, validated local date/time, customer name
  and required phone. Use authenticated From server-side when valid. If unavailable,
  collect/normalize it without sending it to the model. No appointment selection or
  changes to existing appointments until separate caller-identity safeguards exist.
- Model extracts language only; it cannot supply trusted service/business/customer
  identifiers. Resolve unique services with `uniqueService`; ambiguous names and
  ambiguous dates/AM-PM require clarification.
- Read back the exact service/date/time in the business timezone and require explicit
  confirmation. Do not book on the initial utterance or a generic informational question.
- Before issuing that confirmation Gather, seal the complete canonical draft and a
  stable attempt identifier. The confirmation callback does not call the model again
  to reconstruct the action. No PII should appear in a callback URL in cleartext.
- Derive an action UUID from a keyed hash of trusted business, opaque call scope and
  a stable attempt counter. Bind the canonical payload using existing fingerprint
  semantics. Retries of that callback keep both key and payload. Different payload
  under the same key returns IDEMPOTENCY_CONFLICT, never a second booking.
- Persist/replay through the existing Phase 2 action ledger. A definitive business
  rejection may start a new explicitly edited attempt; an unknown/transport failure
  must retain the same key and reconcile before allowing another booking.
- A genuinely new appointment after success needs explicit new intent and a distinct
  attempt identity. Stale token branches must be checked against durable outcomes;
  encrypted state by itself does not provide exactly-once execution or revocation.
- Require BOTH `bookingReceipt` and `actionReceipt`: exact true, UUIDs, tenant/service/
  date/canonical-time equality, Booked status, customer ID, action scope/type/ID,
  changed/replayed booleans, expected code, and nested appointment consistency.
- Only then issue server-authored success and call the existing notification helper.
  The SMS result cannot change successful booking speech. Replay must not resend an
  already claimed notification. Uncertain delivery remains uncertain.
- Map known SLOT_CONFLICT/CLOSED/OUTSIDE_HOURS rejections to new-time/day prompts;
  invalid references require clarification; internal or malformed results never
  imply either success or permission to retry with a fresh key.

## Review prerequisites

Read-only live inspection must verify complete definitions of the legacy booking,
Phase 2 scheduler, membership helpers and notification RPCs; function owners/ACLs;
service-role behavior; compatibility constraints; customer phone reuse; latest-hours
parsing; date lock protocol; actor audit semantics; and table RLS/grants. Do not
assume migration source equals live state. No live SQL was executed for this work.

## Validation and controlled call checklist

Run voice tests, all existing node test files, TypeScript, build and diff check.
Mocks demonstrate application behavior, not live RLS, PostgreSQL concurrency,
OpenAI accuracy or provider latency. Booking-success/idempotency/SMS phone tests
remain blocked by the explicit authorization decision and are not claimed passing.

After normal deployment review, a single read-only call should verify:
1. Business-specific greeting; speech and keypad both work.
2. Press 2, ask hours for today, a service price, and an unknown question.
3. Press 1 and ask to book: explicit unavailable response, no booking or SMS.
4. Ask to change/cancel: no action performed.
5. Press 3 or ask for somebody: no transfer, controlled unavailable response.
6. Press 9 then 0: safe invalid response and repeated menu.
7. Pause twice to test termination, or say “no thanks” to hang up.

A separate call is necessary if both silence termination and spoken goodbye need
end-to-end verification. Nothing here is deployed automatically.
