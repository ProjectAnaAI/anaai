import type { VoiceState } from "@/lib/voice-state";

export type VoiceConfidence = "missing" | "invalid" | "low" | "medium" | "high";
export type VoiceInput = {
  kind: "empty" | "dtmf" | "invalid" | "rejected" | "speech";
  reason: string;
};

export function voiceConfidence(raw: unknown): VoiceConfidence {
  if (raw === null || raw === undefined || raw === "") return "missing";
  if (typeof raw !== "string") return "invalid";
  const text = raw.trim();
  if (!text) return "missing";
  // Accept decimal scores only, not Number() coercions such as hexadecimal.
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return "invalid";
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0 || value > 1) return "invalid";
  return value < 0.35 ? "low" : value < 0.7 ? "medium" : "high";
}

/** Recognition quality precedes all intent, extraction and action handling. */
export function classifyVoiceInput(speech: string, digits: string, confidence: string): VoiceInput {
  speech = speech.trim();
  digits = digits.trim();
  if (!speech && !digits) return { kind: "empty", reason: "empty_input" };
  if (digits) {
    if (speech) return { kind: "invalid", reason: "mixed_input" };
    return /^[0-9]$/.test(digits)
      ? { kind: "dtmf", reason: "digit" }
      : { kind: "invalid", reason: "invalid_digit" };
  }
  if (!/[\p{L}\p{N}]/u.test(speech)) return { kind: "rejected", reason: "nonlexical_speech" };
  if (speech.length > 500 || /[<>\x00-\x08\x0b\x0c\x0e-\x1f]/.test(speech)) {
    return { kind: "rejected", reason: "unusable_speech" };
  }
  if (confidence === "low" || !["missing", "medium", "high"].includes(confidence)) {
    return { kind: "rejected", reason: confidence === "low" ? "low_confidence" : "invalid_confidence" };
  }
  // Fillers are not names or conversational progress. Do not impose a length
  // minimum: BJ, Jo, yes, no and PM are legitimate complete replies.
  if (/^(?:(?:u+h+|u+m+|h+m+|erm)[\s,.!?]*)+$/i.test(speech)) {
    return { kind: "rejected", reason: "filler" };
  }
  return { kind: "speech", reason: "candidate_speech" };
}

export function voiceDigitAllowed(state: VoiceState | null, digit: string): boolean {
  if (state?.mode === "booking") {
    return Boolean((state.booking.pendingTimeOptions ||
      state.booking.stage === "confirm" && state.booking.time) && /^[12]$/.test(digit));
  }
  if (state?.mode === "management") {
    return digit === "2" || digit === "1" && state.management.stage === "confirm";
  }
  return /^[0-3]$/.test(digit);
}

export type VoiceRecovery = { silence: number; recovery?: number };

/** Consecutive empties end at two; all unsuccessful turns share a budget of three. */
export function recoverVoiceInput(state: VoiceRecovery, empty = false): boolean {
  const consecutiveEmpty = empty && state.silence >= 1;
  state.silence = empty ? 1 : 0;
  state.recovery = (state.recovery || 0) + 1;
  return consecutiveEmpty || state.recovery >= 3;
}

export function acceptVoiceProgress(state: VoiceRecovery): void {
  state.silence = 0;
  state.recovery = 0;
}

// Only used by the existing information-only fallback when state is unavailable.
export function statelessVoiceRecovery(mode: string): VoiceRecovery {
  if (mode === "retry") return { silence: 1, recovery: 1 };
  const match = /^recovery-([12])-([01])$/.exec(mode);
  return { recovery: match ? Number(match[1]) : 0, silence: match ? Number(match[2]) : 0 };
}

export function voiceRecoveryMode(state: VoiceRecovery): string {
  return state.recovery === 1 && state.silence === 1 ? "retry" :
    `recovery-${state.recovery}-${state.silence}`;
}
