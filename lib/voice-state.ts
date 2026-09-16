import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
} from "node:crypto";

export type VoiceBinding = {
  businessId: string;
  callSid: string;
  ingress: "production" | "trial";
};

type VoiceMenuState = {
  version: 2;
  expires: number;
  turns: number;
  silence: number;
  mode: "menu" | "info";
};

export type VoiceBookingStage =
  | "name"
  | "service"
  | "date"
  | "time"
  | "confirm";

export type VoiceBookingState = {
  version: 2;
  expires: number;
  turns: number;
  silence: number;
  mode: "booking";
  booking: {
    stage: VoiceBookingStage;
    idempotencyKey: string;
    customerName: string | null;
    serviceId: string | null;
    serviceName: string | null;
    date: string | null;
    time: string | null;
  };
};

export type VoiceState = VoiceMenuState | VoiceBookingState;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CALL_SID = /^CA[0-9a-f]{32}$/i;

const MAX_STATE_TOKEN_LENGTH = 1800;
const MAX_TURNS = 30;
const MAX_LIFETIME_MS = 30 * 60_000;

export function initialVoiceState(now = Date.now()): VoiceState {
  return {
    version: 2,
    expires: now + MAX_LIFETIME_MS,
    turns: 0,
    silence: 0,
    mode: "menu",
  };
}

export function initialBookingState(
  now = Date.now()
): VoiceBookingState {
  return {
    version: 2,
    expires: now + MAX_LIFETIME_MS,
    turns: 0,
    silence: 0,
    mode: "booking",
    booking: {
      stage: "name",
      idempotencyKey: randomUUID(),
      customerName: null,
      serviceId: null,
      serviceName: null,
      date: null,
      time: null,
    },
  };
}

function key(): Buffer {
  const secret = process.env.VOICE_STATE_SECRET;

  if (!secret || !/^[a-f0-9]{64}$/i.test(secret)) {
    throw new Error("Voice state unavailable");
  }

  return Buffer.from(secret, "hex");
}

export function voiceStateConfigured(): boolean {
  return /^[a-f0-9]{64}$/i.test(
    process.env.VOICE_STATE_SECRET || ""
  );
}

function scope(binding: VoiceBinding): Buffer {
  if (!CALL_SID.test(binding.callSid)) {
    throw new Error("Invalid voice scope");
  }

  return createHmac("sha256", key())
    .update(
      JSON.stringify([
        "voice-state-v2",
        binding.businessId,
        binding.callSid,
        binding.ingress,
      ])
    )
    .digest();
}

function validText(
  value: unknown,
  max: number
): value is string | null {
  return (
    value === null ||
    (typeof value === "string" &&
      value.length > 0 &&
      value.length <= max &&
      !/[\x00-\x1f<>]/.test(value))
  );
}

function validBookingState(
  value: Record<string, unknown>
): value is VoiceBookingState {
  if (value.mode !== "booking") {
    return false;
  }

  if (
    !value.booking ||
    typeof value.booking !== "object" ||
    Array.isArray(value.booking)
  ) {
    return false;
  }

  const booking = value.booking as Record<string, unknown>;

  const expectedKeys = [
    "stage",
    "idempotencyKey",
    "customerName",
    "serviceId",
    "serviceName",
    "date",
    "time",
  ];

  if (
    Object.keys(booking).length !== expectedKeys.length ||
    expectedKeys.some((field) => !(field in booking))
  ) {
    return false;
  }

  if (
    !["name", "service", "date", "time", "confirm"].includes(
      String(booking.stage)
    )
  ) {
    return false;
  }

  if (
    typeof booking.idempotencyKey !== "string" ||
    !UUID.test(booking.idempotencyKey)
  ) {
    return false;
  }

  if (!validText(booking.customerName, 120)) {
    return false;
  }

  if (
    booking.serviceId !== null &&
    (typeof booking.serviceId !== "string" ||
      !UUID.test(booking.serviceId))
  ) {
    return false;
  }

  if (!validText(booking.serviceName, 120)) {
    return false;
  }

  if (
    booking.date !== null &&
    (typeof booking.date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(booking.date))
  ) {
    return false;
  }

  if (
    booking.time !== null &&
    (typeof booking.time !== "string" ||
      !/^\d{2}:\d{2}$/.test(booking.time))
  ) {
    return false;
  }

  return true;
}

function validateState(
  state: unknown,
  now: number
): VoiceState {
  if (
    !state ||
    typeof state !== "object" ||
    Array.isArray(state)
  ) {
    throw new Error("Invalid voice state");
  }

  const value = state as Record<string, unknown>;

  if (
    Object.keys(value).some(
      (field) =>
        ![
          "version",
          "expires",
          "turns",
          "silence",
          "mode",
          "booking",
        ].includes(field)
    ) ||
    value.version !== 2 ||
    typeof value.expires !== "number" ||
    !Number.isSafeInteger(value.expires) ||
    value.expires <= now ||
    value.expires > now + MAX_LIFETIME_MS ||
    typeof value.turns !== "number" ||
    !Number.isSafeInteger(value.turns) ||
    value.turns < 0 ||
    value.turns >= MAX_TURNS ||
    typeof value.silence !== "number" ||
    !Number.isInteger(value.silence) ||
    value.silence < 0 ||
    value.silence > 1
  ) {
    throw new Error("Expired or invalid voice state");
  }

  if (value.mode === "menu" || value.mode === "info") {
    if (Object.keys(value).length !== 5) {
      throw new Error("Invalid voice state");
    }

    return value as VoiceMenuState;
  }

  if (
    Object.keys(value).length !== 6 ||
    !validBookingState(value)
  ) {
    throw new Error("Invalid voice state");
  }

  return value;
}

export function sealVoiceState(
  state: VoiceState,
  binding: VoiceBinding
): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    key(),
    nonce
  );

  cipher.setAAD(scope(binding));

  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(state), "utf8"),
    cipher.final(),
  ]);

  return Buffer.concat([
    nonce,
    cipher.getAuthTag(),
    ciphertext,
  ]).toString("base64url");
}

export function openVoiceState(
  token: string,
  binding: VoiceBinding,
  now = Date.now()
): VoiceState {
  if (
    !token ||
    token.length > MAX_STATE_TOKEN_LENGTH ||
    !/^[\w-]+$/.test(token)
  ) {
    throw new Error("Invalid voice state");
  }

  const data = Buffer.from(token, "base64url");

  if (data.length <= 28) {
    throw new Error("Invalid voice state");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    key(),
    data.subarray(0, 12)
  );

  decipher.setAAD(scope(binding));
  decipher.setAuthTag(data.subarray(12, 28));

  let decoded: unknown;

  try {
    decoded = JSON.parse(
      Buffer.concat([
        decipher.update(data.subarray(28)),
        decipher.final(),
      ]).toString("utf8")
    );
  } catch {
    throw new Error("Invalid voice state");
  }

  return validateState(decoded, now);
}
