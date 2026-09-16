# Voice service regression investigation

## Finding and scope

The reported live failure cannot be reproduced with the supplied exact SpeechResult values in the current checkout. Before changing production code, the new exact-phrase and encrypted recovery tests passed. The only failures were the newly requested `Could I book a facial` / `I'd like to book a facial` wrappers and their ambiguity test (177/180 focused tests passed).

The sole production change adds controlled booking prefixes in `lib/voice-parsing.ts`. There is no evidence justifying a retry, state, cancellation, authentication, or RPC change. This is not a verified fix of the live incident. Establishing its cause requires the deployed revision and actual provider SpeechResult values; neither was supplied or fetched. A caller's recollection of spoken words does not establish the webhook transcription.

## Exact state trace

`beginBooking` creates name state with turns=1 and a fresh idempotency key. A normal Randy callback increments turns to 2, resets failures to 0, records the name and asks for services. With facial/haircut/waxing:

- `I would like a facial, please.` normalizes to `i would like a facial please`, strips to `facial`, and uniquely matches facial. It already worked before this patch.
- One invalid service increments failures to 1, leaves stage=service, and seals the updated state (turns=3).
- A subsequent `Facial` callback successfully opens that state, increments turns to 4, fails the negative-confirmation check, selects facial, sets failures=0 and stage=date, and asks for a date.
- After two invalid services the same success occurs at turns=5, from failures=2. Only a third actual failed answer invokes exhaustion.
- A valid date resets failures and moves to time. A valid unambiguous time resets failures and moves to confirm. An explicit affirmative at confirm executes booking only after required fields and caller phone validation. Confirmation failures are not incremented on a successful affirmative; there is no subsequent stage/state to serialize.

The exact quoted `Okay. No appointment was booked. Thanks for calling. Goodbye.` occurs only at `lib/voice-handler.ts:393`: `interpretConfirmation(speech) === "no"`, before stage dispatch. Neither failure count nor turn count causes that message. `confirmation('Facial')` is `ambiguous`, not `no`. In this checkout there is no branch by which the supplied valid service causes that cancellation.

## Termination path audit

Counts below are at handler evaluation, after the callback turn increment. “Open” means the supplied encrypted callback state opened successfully; first requests may have no token. Ordinary booking callbacks must have turns below 30 and an unexpired lifetime to reach bookingTurn. Retry counts are missing (legacy) or 0–2 on entry.

| Path / source | Stage | Retry / turns | Input and state | Can literal Facial at service trigger it? |
| --- | --- | --- | --- | --- |
| Exact “Okay…” / handler:393 | Any booking stage | Any accepted retries; turns <30 | Nonempty explicit negative/cancel; open | No |
| “couldn't verify those details” / handler:402 | Current booking stage | Increment from 2 to 3; turns <30 | Invalid/ambiguous answer for that stage; open | No, matcher succeeds before retry |
| “couldn't hear you” / handler:355 | Any booking stage | Failures unchanged; turns <30 | Empty SpeechResult with silence already 1; open | No |
| No services / handler:432 | Name -> service | Failures reset to 0; turns <30 | Valid name but routed service lookup empty/error; open | No, stage must be name |
| Incomplete details / handler:545 | Confirm | Any accepted retries; turns <30 | Explicit affirmative, incomplete booking fields; open | No |
| Invalid callback phone / handler:565 | Confirm | Any accepted retries; turns <30 | Explicit affirmative, invalid From; open | No |
| Booking result failure / handler:589 | Confirm | Any accepted retries; turns <30 | Explicit affirmative; open; booking module returns failure | No |
| Booking module:295,316 | Confirm through handler | Same as above | Invalid canonical request or service no longer authoritative; no mutation | No |
| RPC error/rejection/unverified receipt / booking module | Confirm through handler | Same as above | Explicit affirmative; open; no spoken success without verified receipt. RPC error/unverified result can have uncertain mutation outcome | No |
| “conversation has expired” / handler:669 | Untrusted/unavailable | Invalid/expired state, including turns >=30 or retries outside 0–2 | Open failed; transcription is irrelevant | Yes, independently of service validity; different message |
| “conversation has ended” / handler:694 | Any | turns reaches 30 or lifetime elapsed | Open succeeded, then guard; transcription irrelevant | Yes, at the safety limit; different message |
| Gather lifetime guard / handler:250 | Any | turns >=30 or lifetime elapsed during processing | Open/new state; transcription irrelevant | Yes, if lifetime expires during service processing; different message |
| Unrouted number / handler:639 | No trusted stage | Counts unavailable | Before opening state; any input | Yes, if routing unavailable; different message |
| General goodbye / handler:734 | Menu/info only | Any accepted counts | Explicit goodbye, not booking dispatch | No |
| General silence / handler:751 | Menu/info only | silence already 1 | Empty input; open or legacy stateless retry mode | No |
| Route exception fallback | Any/unknown | Unavailable | Exception; state-open success depends on failing operation | Could interrupt any request; different message, no explicit Hangup |

Successful booking/replay also hangs up after authoritative success. It is not a failure path. Authentication rejection returns HTTP 403 before handler execution and never emits the quoted message.

## State and Gather audit

`voice-state.ts` accepts missing legacy failures and integer failures 0–2. JSON encryption preserves the counter; a third failure exits without issuing another token. AES-256-GCM, business/call/ingress AAD, token-size validation, 30-turn limit, and 30-minute lifetime are unchanged. Caller phone remains absent from encrypted state. The same idempotency key and expiry survive clarification and successful selection.

Service clarification invokes Gather with the mutated service state and current routed service names. Production action uses the configured production URL with mode/state; trial action uses `/api/voice/trial` with trial token/mode/state. Tests use the generated action's state in the next callback and verify both ingress bindings. Existing route tests verify signature/token gates separately. Production configuration itself was not inspected or changed.

Settings remain speech+DTMF, POST, one digit, en-US, timeout=6, speechTimeout=2, experimental_utterances, actionOnEmptyResult=true. Service hints use only the supplied routed names, at most 30 names, each at most 80 characters, excluding commas/control characters/angle brackets. For this call they are `facial,haircut,waxing`. The first silence reprompt currently omits service hints because that branch passes no names; it remains bounded and a valid following service recovers. This pre-existing omission is not the unmatched-service clarification path and was not changed.

## Tests and security scope

New coverage includes all nine requested phrases, absent/ambiguous business services, strict-match priority, both ingresses with zero/one/two failures, exact Randy sequence, all adjacent stage retry resets, third-failure exit, silence/recovery, legacy state, stable idempotency/expiry, no caller phone in state, current clarification state and Gather settings. Recovery continues through natural date/time and exactly one execution after yes. Integration tests run the real booking module with simulated RPC receipts, rejecting malformed success before spoken success.

No changes to handler, encrypted state, ingress routes, tenant routing, secure booking/notification RPCs, SQL/RLS/permissions, actor/system semantics, SMS, idempotency, logging, dependencies, or configuration. Existing security tests and the consolidated local gate remain required. No commit, staging, push, deployment, migration, external configuration changes, or production calls were made.

## Consolidated local validation

After `rm -rf .next`: `node --test tests/*.test.cjs` passed 403/403 (26 added); `npx tsc --noEmit` exited 0. `npm run build` exited 1 with `TurbopackInternalError: Failed to write app endpoint /page`, caused by `[project]/app/globals.css [app-client] (css)` -> `creating new process` -> `binding to a port` -> `Operation not permitted (os error 1)`. No configuration workaround or escalation was attempted. `git diff --check` passed.

SHA-256 comparisons and status comparisons confirm all seven pre-existing dirty files remained unchanged: app/analytics/page.tsx, app/api/business-test/route.ts, app/business-test/page.tsx, app/business/page.tsx, app/dashboard/page.tsx, app/knowledge/page.tsx, docs/appointment-snapshots.md.

Residual limitations: production transcription/deployment evidence is missing; local tests cannot establish live recognition quality or deployed behavior; the production build remains unverified beyond the sandbox failure. Database/provider calls in these tests are simulated. Authentication, SQL privilege boundaries, idempotency and notification behavior are covered by the existing local suite, not a new live infrastructure audit.
