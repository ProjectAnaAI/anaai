import "server-only";

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

export function gatherOptions(
  stage?: string,
  services: string[] = []
): VoiceResponse.GatherAttributes {
  const hints =
    stage === "service"
      ? services
          .filter(
            (name) =>
              name.length <= 80 &&
              !/[<>\x00-\x1f,]/.test(
                name
              )
          )
          .slice(0, 30)
          .join(",")
      : stage === "confirm"
        ? "yes,no,correct,book it,go ahead,yes please,sounds good,that works,cancel"
        : stage === "time"
          ? "AM,PM,noon,midnight"
          : "";

  /*
   * Booking turns use conversational recognition.
   *
   * Confirmation is not a yes/no-only turn: callers
   * may naturally provide a replacement service, date,
   * or time. Keep enough end-of-speech tolerance for
   * those complete correction phrases.
   */
  return {
    input: [
      "speech",
      "dtmf",
    ],
    numDigits: 1,
    method: "POST",
    timeout: 10,

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