import "server-only";
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

// State is a convenience, never authorization. Ingress authentication and called-
// number routing must succeed again before opening it on every callback.
export type VoiceBinding = {
  businessId: string;
  callSid: string;
  ingress: "production" | "trial";
};
export type VoiceState = {
  version: 1;
  expires: number;
  turns: number;
  silence: number;
  mode: "menu" | "info";
};
export function initialVoiceState(now = Date.now()): VoiceState {
  return { version: 1, expires: now + 30 * 60_000, turns: 0, silence: 0, mode: "menu" };
}
function key(): Buffer {
  const secret = process.env.VOICE_STATE_SECRET;
  if (!secret || !/^[a-f0-9]{64}$/i.test(secret)) throw Error("Voice state unavailable");
  return Buffer.from(secret, "hex");
}
export function voiceStateConfigured(): boolean {
  return /^[a-f0-9]{64}$/i.test(process.env.VOICE_STATE_SECRET || "");
}
function scope(binding: VoiceBinding): Buffer {
  if (!/^CA[0-9a-f]{32}$/i.test(binding.callSid)) throw Error("Invalid voice scope");
  return createHmac("sha256", key()).update(JSON.stringify([
    "voice-state-v1", binding.businessId, binding.callSid, binding.ingress,
  ])).digest();
}
export function sealVoiceState(state: VoiceState, binding: VoiceBinding): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), nonce);
  cipher.setAAD(scope(binding));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(state), "utf8"), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64url");
}
export function openVoiceState(token: string, binding: VoiceBinding, now = Date.now()): VoiceState {
  if (!token || token.length > 600 || !/^[\w-]+$/.test(token)) throw Error("Invalid voice state");
  const data = Buffer.from(token, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key(), data.subarray(0, 12));
  decipher.setAAD(scope(binding));
  decipher.setAuthTag(data.subarray(12, 28));
  const state: unknown = JSON.parse(Buffer.concat([
    decipher.update(data.subarray(28)), decipher.final(),
  ]).toString("utf8"));
  if (!state || typeof state !== "object" || Array.isArray(state)) throw Error("Invalid voice state");
  const value = state as Record<string, unknown>;
  if (Object.keys(value).length !== 5 || value.version !== 1 ||
    typeof value.expires !== "number" || !Number.isSafeInteger(value.expires) ||
    value.expires <= now || value.expires > now + 30 * 60_000 ||
    typeof value.turns !== "number" || !Number.isSafeInteger(value.turns) || value.turns < 0 || value.turns >= 30 ||
    typeof value.silence !== "number" || !Number.isInteger(value.silence) || value.silence < 0 || value.silence > 1 ||
    (value.mode !== "menu" && value.mode !== "info")) throw Error("Expired or invalid voice state");
  return value as VoiceState;
}
