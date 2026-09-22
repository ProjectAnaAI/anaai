# Voice capacity and conversation checkpoint

Covers `202609210004` (Voice availability capacity), `202609210005`
(authoritative Voice booking capacity) and the conversational rework in
`lib/voice-slots.ts`, `lib/voice-handler.ts`, `lib/voice-parsing.ts`,
`lib/voice-state.ts`, `lib/voice-understanding.ts` and `lib/voice-config.ts`.

Nothing here applies migrations, and **no PostgreSQL binary was available while
this was written, so neither migration has been compiled.** Voice remains
development-grade, not production-ready.

## Local tests

```
node --test tests/voice-conversation.test.cjs   # natural conversation
node --test tests/voice-capacity.test.cjs       # capacity, 13A then 13B
node --test tests/voice-receptionist.test.cjs   # existing Voice contracts
node --test tests/voice-parsing.test.cjs tests/voice-understanding.test.cjs
```

`tests/voice-conversation.test.cjs` runs with the semantic layer stubbed to
"unclear" by default. The booking flow must complete deterministically when
OpenAI is unavailable; the model may only ever supplement it.

`tests/voice-capacity.test.cjs` is a JS port of the capacity sweep plus SQL text
contracts. It proves the *algorithm* and the migrations' security and ordering
properties, not PL/pgSQL behaviour.

## Capacity rule

Identical to manual scheduling: `businesses.appointment_capacity` is the
maximum number of simultaneously active appointments. Booked and Confirmed
consume one unit each; Cancelled and Completed consume nothing. Intervals use
the real service duration and are half-open `[start, end)`. The decision is
**peak simultaneous occupancy**, not a count of overlapping appointments.

```
capacity 2
existing  A 16:00-16:30   B 16:30-17:00
candidate 16:00-17:00                     -> AVAILABLE (peak with candidate = 2)
```

At capacity 1 this is exactly the single-overlap rule both Voice functions used
before.

## Two fail-closed corrections

Both Voice functions previously diverged from manual scheduling:

1. An active appointment with a **NULL `appointment_time`** made the overlap
   comparison NULL, which read as "no conflict" and could overbook. It now
   returns `INVALID_EXISTING_SCHEDULE`.
2. The legacy service-name duration fallback used `limit 1`, silently picking
   one of several same-named services. An **ambiguous name now fails closed**.

## Race safety

Availability is advisory and takes no lock. `voice_book_appointment_business`
is authoritative and evaluates capacity **while holding the business/date
advisory lock**, using the byte-identical lock expression the manual scheduling
RPCs use — so a phone booking and a dashboard booking for one business/date
serialize against each other and agree on the rule.

Capacity is checked **before** any customer read, insert or reactivation, so a
capacity rejection never mutates customer state.

The legitimate race — availability says free, someone else takes the capacity,
the caller then says yes — is covered: the authoritative RPC returns
`SLOT_CONFLICT` and Ana speaks the failure. It never says the appointment was
booked.

## Required database acceptance tests before release

Everything in `tests/appointment-capacity.README.md` still applies. In addition:

- **Compile both migrations** against a disposable local database first.
- `voice_check_appointment_availability` and `voice_book_appointment_business`
  keep their exact signatures:
  `select oid::regprocedure, prosecdef, proconfig from pg_proc where proname in
  ('voice_check_appointment_availability','voice_book_appointment_business');`
  Expect `prosecdef = true` and `proconfig = {search_path=pg_catalog, public}`.
- `has_function_privilege('authenticated', '<sig>', 'execute')` is false for
  both; `has_function_privilege('service_role', '<sig>', 'execute')` is true.
- `has_schema_privilege('anon','anaai_private','usage')` is false, and a
  PostgREST `POST /rest/v1/rpc/check_appointment_capacity_business` returns 404.
- Capacity 1 business: every pre-existing Voice acceptance test in
  `docs/voice-receptionist.md` passes with identical result codes.
- Capacity 2 business: two concurrent phone bookings succeed, a third returns
  `SLOT_CONFLICT`; then the peak back-to-back case above books successfully.
- **Cross-path concurrency**: start a phone booking and a dashboard booking for
  the same business/date/interval in separate transactions. Exactly the
  configured capacity commits. Repeat with the order reversed.
- Insert a Booked row with `appointment_time` NULL and attempt a phone booking
  in that interval: must return `INVALID_EXISTING_SCHEDULE`, never succeed.
  Repeat with the row Cancelled and Completed: booking must succeed.
- Two active services with the same name, and a legacy appointment referencing
  that name with no `service_id`: a phone booking in that interval must fail
  closed.
- Idempotency: replay the same `p_idempotency_key` after a capacity rejection
  and after a success. The stored receipt is returned unchanged with
  `replayed: true`, and no duplicate appointment or customer is created.
- A capacity rejection must leave `public.customers` untouched: confirm no new
  row and no `is_active` flip for a phone number that is not yet a customer and
  for an archived one.
- Archived customer reactivation still works on a successful booking.
- Force the capacity helper to return something other than `AVAILABLE`/
  `SLOT_CONFLICT`/`INVALID_EXISTING_SCHEDULE` (for example by revoking the
  business row's visibility): the booking must roll back entirely, including
  the action claim, rather than persisting a terminal rejection receipt.

## Speech and background noise: what actually changed

Supported by the current `<Gather>` architecture and now used:

- **Hints on every booking turn**, combining the routed service names with
  scheduling vocabulary (weekdays, today/tomorrow, AM/PM, "in the afternoon",
  "thirty"). Previously only the service turn hinted services, which worked
  against a flow where any turn may carry any detail.
- **DTMF actually reaches the booking flow.** `Digits` was never passed into
  the booking turn, so "press 1 to confirm" did nothing. 1 confirms, 2
  declines, and 1/2 also answer an AM/PM clarification.
- **Reported low confidence cannot authorize a booking.** Twilio's
  `Confidence` was logged but unused. A score below 0.35 now re-asks instead of
  booking. It is a strict no-op when Twilio omits or malforms the value.

Deliberately unchanged: `timeout="6"`, `speechTimeout="2"`,
`speechModel="experimental_conversations"`, `language="en-US"`,
`actionOnEmptyResult="true"`.

## Remaining limitations

- **Background noise cannot be eliminated.** `<Gather>` returns one final
  transcript per turn; there is no streaming, no barge-in control, no
  diarization, and no way to tell the caller's voice from a television.
  Hints bias recognition, they do not filter audio. The mitigations here are
  recovery mitigations: focused re-asks, DTMF fallback on every critical turn,
  a bounded failure count, and refusing to read garbage as confirmation.
- `Confidence` is not documented as reliable for
  `experimental_conversations`; the gate is therefore best-effort and may
  never fire in production.
- Voice still has **no rescheduling or cancellation path**. Those requests are
  classified as `appointment_action` by `lib/voice-receptionist.ts` and
  answered with a "not available yet" message.
- `book_appointment_atomic_business` (the `ai_book` path) now uses the same
  capacity helper, via 202609210006. All five scheduling paths agree. That
  migration restates a deployed body the repository cannot cross-check, so its
  fidelity is pinned by `tests/legacy-ai-capacity.test.cjs`; see
  `tests/appointment-capacity.README.md` before editing it.
