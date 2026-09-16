# Phone receptionist V1: review and controlled pilot

This change is not a deployment or proof of real-call recognition quality. No SQL, credentials, provider configuration, or SMS architecture was changed.

## Findings and boundaries

The former deterministic time parser handled digits, including literal `1 p.m.`, but did not support spoken number words or spaced `p m`. We cannot reconstruct the failed call's transcription and must not attribute every missed utterance to parsing. Empty SpeechResult means there is no text to interpret. The old `speechTimeout=auto` ended recognition at the first pause. Missing model guidance and service hints may contribute; live measurement is still required.

The old service fallback removed separators but not conversational filler. Date parsing tested an unanchored month expression before the year-first expression, allowing a leading year to be ignored. Relative-date arithmetic previously added 24 hours before timezone conversion, which could cross a DST boundary incorrectly. Transcribed invalid replies were bounded only by the total turn limit. These are source-verified defects or limitations.

The new pipeline is transcription → bounded deterministic parsing → canonical service/date/time → explicit summary and affirmative → existing authoritative voice RPC → verified receipt → success speech. OpenAI remains restricted to informational fact selection; no model call was added to booking turns.

## Speech and state

- Services: existing strict shared matcher first, then case/spacing/punctuation normalization, limited filler removal and conservative singular/plural comparison. Only unique matches are selected. Ambiguities list up to three current-business options. No synonyms, edit distance, global salon catalog, or cross-tenant cache.
- Times: digit and English number forms, o'clock, AM/PM including punctuation/spacing, morning/afternoon/evening, half/quarter past, noon/midday/midnight and explicit two-digit-hour colon times. Output is HH:mm. Bare 1–12-hour forms remain ambiguous and require a full answer with AM/PM. Midnight is only a parsed value; the existing database hours checks decide availability. Unsupported phrasing fails closed.
- Dates: ISO; today/tomorrow; month/day with optional year; year/month/day; spoken ordinals; “the 24th of September”; this/next weekday. Relative dates use the business timezone. This/next weekday means the current/following Monday-start calendar week; final summary exposes the chosen date. Explicit past dates are rejected by the handler. Yearless dates use the next occurrence. No arbitrary natural-language Date parsing.
- Names retain existing bounded validation without semantic correction.
- Affirmatives are an exact normalized allowlist: yes, yeah, yep, correct, confirm, that's/that is correct, that's/that is right, looks good, sounds good, book it, please book it, yes please. Mixed or vague statements never book.
- Negatives: no, nope, cancel, stop, never mind, nevermind, go back, start over, don't/do not book it, that's/that is wrong, no thanks, goodbye, bye. They exit without booking; this does not implement editing prior answers.
- Invalid/ambiguous transcribed input: two retries, then safe exit on the third failure at that stage. A valid answer resets the counter. No-input: one stage-specific retry, then exit on consecutive silence. No raw transcription is repeated as an error message.
- Existing encrypted business/call/ingress-bound state, stable booking idempotency key, token bound and lifetime remain. Optional validated failures counter is backward-compatible with existing state. Total turn/lifetime guard now also precedes final booking execution.
- Twilio Confidence is not used as a fabricated universal accuracy threshold: Twilio does not guarantee its presence or accuracy. Parser ambiguity, summary, and explicit confirmation remain the checks.

## Twilio configuration and sources

Checked against official documentation and installed Twilio 6.1.1 types:

| Setting | Selection |
|---|---|
| input / method | speech + DTMF / POST, unchanged |
| numDigits / timeout | 1 / 6 seconds, unchanged |
| language | en-US, unchanged |
| actionOnEmptyResult | true, unchanged |
| speechModel | experimental_utterances for booking; experimental_conversations for menu/information |
| speechTimeout | integer 1 second for confirmation, 2 seconds otherwise; replaces auto |
| hints | up to 30 current-business service names (80 characters each, unsafe separators excluded); controlled time and confirmation hints |
| TTS | Polly.Joanna-Neural with en-US, replacing alice |

[Twilio Gather documentation](https://www.twilio.com/docs/voice/twiml/gather) documents positive integer speechTimeout with speechModel, the first-pause behavior of auto, and generic models that retain provider failover. Despite their names, experimental_utterances/conversations are GA. Enhanced is deprecated and is not used. DTMF and speech remain first-input-wins; keypad booking-field entry is not added.

[Twilio supported TTS voices](https://www.twilio.com/docs/voice/twiml/say/text-speech) lists the neural voice and provider-prefixed syntax. Generative voices are not selected for this pilot. The optional server variable TWILIO_TTS_VOICE accepts Polly.Joanna-Neural, Polly.Joanna or alice; absent selects neural and invalid configuration falls back to alice. This is configuration fallback, not automatic recovery from a provider outage. No environment file was changed.

Recognition and neural TTS are metered; verify account capabilities and [current Twilio US Voice pricing](https://www.twilio.com/en-us/voice/pricing/us) before rollout. No claim of lower provider latency or free neural output is made. [Twilio trial limitations](https://www.twilio.com/docs/usage/trials) and the confirmed predefined-template restriction still prevent this trial account's custom SMS; account upgrade/appropriate messaging setup remains manual.

## Latency and security review

Each callback still performs one trusted called-number lookup. Name response loads active services for the next prompt; service response loads them again for authoritative selection; date/time turns perform no extra business queries or OpenAI calls. Final affirmative reloads services, calls the existing booking RPC, and then claims/sends/finalizes SMS. Rechecking across separate requests intentionally avoids stale service selection. The service selection read now supplies both matching candidates and hints without a second query. No new redirect, extra conversational turn on valid input, or model call was introduced.

Caller speech, Twilio endpointing/transcription, webhook/network/cold-start time, DB work, notification provider work and TTS remain latency contributors. The 2-second pause window intentionally tolerates natural pauses at a latency cost versus auto; confirmation uses 1 second. No real-call latency or audio quality measurement was performed. SMS is still awaited after commit before final TwiML, an existing latency contributor deliberately not redesigned here.

Production signature verification and trial token checks remain before privileged access. Called-number routing remains the sole tenant source. No SQL/grants/user compatibility/actor handling changed. No client service key exposure, caller impersonation, logging of transcripts/identifiers, mutation tools, or provider objects was added. The booking receipt validator and mutation/SMS execution body are unchanged. Existing idempotent replay tests are mocks, not a new PostgreSQL concurrency proof.

SMS remains: valid provider acceptance receipt → accepted; verified HTTP 4xx except 408 → failed; 408, transport, 5xx or malformed acceptance → uncertain. The confirmed trial restriction is failed. SMS failure cannot invalidate an authoritative booking. No automatic resend was added.

## Review and manual acceptance

No Twilio console or environment update is required for the default code path. After review, deploy normally with existing secure webhook/token/state settings. Optionally set TWILIO_TTS_VOICE to an allowlisted voice; use alice for an explicit rollback if neural is unavailable. Verify account voice support, pricing, and actual pronunciation on a controlled call. Do not change production routing to bypass signature checks.

| Controlled test | Required outcome |
|---|---|
| Greeting on both ingresses | Correct business; same authenticated callback path |
| Conversational service phrases | Correct unique service; ambiguous alternatives require clarification |
| Spoken dates and timezone boundary | Correct calendar date, repeated in summary |
| one p.m., two thirty PM, noon | Correct canonical time, repeated in summary |
| bare three / invalid time | Clarification; no mutation |
| silence / repeated invalid input | Bounded stage-specific prompts, safe exit |
| vague confirmation / explicit no | No appointment or notification |
| clear yes with available slot | One verified booking; dashboard matches summary |
| conflicting slot | Controlled failure, no fabricated success |
| replay same confirmed callback | No duplicate booking/notification |
| custom SMS trial rejection | Booking stays successful; no delivered-text claim |
| Neural TTS and alice rollback | Understandable output; measure end-of-speech to answer latency |
| Separate business routing | Only that business's names/services; state cannot cross calls/tenants |

Use authorized test data and deliberate explicit confirmation; successful phone booking creates real records. No calls were made by this task. Real-call STT/TTS quality, provider latency and account capability remain pilot gates. Broader languages, clarification of previously entered fields, larger service catalogs (existing 50-service lookup cap), asynchronous notifications and streaming/realtime are future work, not implemented here.
