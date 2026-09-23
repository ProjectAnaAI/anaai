import type VoiceResponse from "twilio/lib/twiml/VoiceResponse";

const VOICES = [
  "Polly.Joanna-Neural",
  "Polly.Joanna",
  "alice",
] as const;

export function voiceOptions(): VoiceResponse.SayAttributes {
  const configured =
    process.env.TWILIO_TTS_VOICE?.trim();

  const voice =
    VOICES.find(
      (value) =>
        value === configured
    ) ||
    (configured
      ? "alice"
      : "Polly.Joanna-Neural");

  return {
    voice,
    language: "en-US",
  };
}

/*
 * Scheduling vocabulary supplied to Twilio at every booking turn.
 *
 * Callers now answer any booking question with any detail, so biasing
 * recognition toward only the stage's own vocabulary works against us: a
 * caller answering "which service?" with "Facial on October second at 2:30"
 * needs the month and clock words biased too.
 *
 * Hints bias recognition; they do not restrict it, and they cannot remove
 * background noise.
 */
const SCHEDULING_HINTS = [
  "today",
  "tomorrow",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
  "AM",
  "PM",
  "noon",
  "midnight",
  "in the morning",
  "in the afternoon",
  "in the evening",
  "o'clock",
  "thirty",
  "fifteen",
  "forty five",
];

const CONFIRM_HINTS = [
  "yes",
  "no",
  "correct",
  "book it",
  "go ahead",
  "yes please",
  "sounds good",
  "that works",
  "cancel",
  "change it",
  "actually",
  "instead",
];

/*
 * Twilio rejects hint lists containing control characters, angle brackets or
 * embedded commas, and very long lists are counterproductive.
 */
function safeHints(
  values: string[]
): string {
  return [
    ...new Set(
      values.filter(
        (value) =>
          value.length > 0 &&
          value.length <= 80 &&
          !/[<>\x00-\x1f,]/.test(
            value
          )
      )
    ),
  ]
    .slice(0, 100)
    .join(",");
}

export function gatherOptions(
  stage?: string,
  services: string[] = []
): VoiceResponse.GatherAttributes {
  const booking =
    stage === "name" ||
    stage === "service" ||
    stage === "date" ||
    stage === "time" ||
    stage === "confirm";

  const hints = booking
    ? safeHints([
        ...services,
        ...SCHEDULING_HINTS,
        ...(stage === "confirm"
          ? CONFIRM_HINTS
          : []),
      ])
    : "";

  /*
   * Booking turns use conversational recognition.
   *
   * Confirmation is not a yes/no-only turn: callers
   * may naturally provide a replacement service, date,
   * or time. Keep enough end-of-speech tolerance for
   * those complete correction phrases.
   *
   * `timeout` (6s) and `speechTimeout` (2s) are deliberately unchanged: they
   * were tuned against real calls, and shortening either truncates the
   * multi-detail sentences this flow now depends on.
   */
  return {
    input: [
      "speech",
      "dtmf",
    ],
    numDigits: 1,
    method: "POST",
    timeout: 6,

    speechModel:
      "experimental_conversations",

    speechTimeout: "2",

    language: "en-US",
    actionOnEmptyResult: true,

    ...(hints
      ? {
          hints,
        }
      : {}),
  };
}
