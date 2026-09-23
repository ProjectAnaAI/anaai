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
  recovery?: number;
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
  recovery?: number;
  mode: "booking";
  booking: {
    stage: VoiceBookingStage;
    failures?: number;
    idempotencyKey: string;
    customerName: string | null;
    serviceId: string | null;
    serviceName: string | null;
    date: string | null;
    /*
     * The caller's chosen time, which has NOT been checked against
     * availability. Changing the service, date or time sets this and clears
     * `time`, so stale availability can never survive a correction.
     */
    requestedTime?: string | null;
    /*
     * Availability state. Non-null only while the database has confirmed this
     * exact service/date/time combination is available. It is the single
     * signal that the summary may be offered for confirmation.
     */
    time: string | null;
    pendingTimeOptions?: [string, string];
  };
};

export type VoiceAppointmentTarget = {
  id: string;
  businessId: string;
  customerId: string;
  serviceId: string | null;
  serviceName: string;
  date: string;
  time: string;
  status: "Booked" | "Confirmed";
};

export type VoiceManagementState = {
  version: 2;
  expires: number;
  turns: number;
  silence: number;
  recovery?: number;
  mode: "management";
  management: {
    action: "cancel" | "reschedule";
    stage: "select" | "replacement" | "confirm";
    idempotencyKey: string;
    target: VoiceAppointmentTarget | null;
    selector: { date: string | null; time: string | null; serviceName: string | null };
    date: string | null;
    time: string | null;
    verified: boolean;
    pendingTimeOptions: [string, string] | null;
  };
};

export type VoiceState = VoiceMenuState | VoiceBookingState | VoiceManagementState;

export function initialManagementState(
  state: VoiceState,
  action: "cancel" | "reschedule"
): VoiceManagementState {
  return {
    version: 2, expires: state.expires, turns: state.turns, silence: state.silence,
    ...(state.recovery !== undefined ? { recovery: state.recovery } : {}),
    mode: "management",
    management: {
      action, stage: "select", idempotencyKey: randomUUID(), target: null,
      selector: { date: null, time: null, serviceName: null },
      date: null, time: null, verified: false, pendingTimeOptions: null,
    },
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).length === keys.length && keys.every(key => key in value);
}
function managementDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
function managementTime(value: unknown): value is string {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}
export function validVoiceTarget(value: unknown): value is VoiceAppointmentTarget {
  return record(value) && exactKeys(value, ["id", "businessId", "customerId", "serviceId", "serviceName", "date", "time", "status"]) &&
    [value.id, value.businessId, value.customerId].every(id => typeof id === "string" && UUID.test(id)) &&
    (value.serviceId === null || typeof value.serviceId === "string" && UUID.test(value.serviceId)) &&
    typeof value.serviceName === "string" && validText(value.serviceName, 120) &&
    managementDate(value.date) && managementTime(value.time) &&
    (value.status === "Booked" || value.status === "Confirmed");
}
function validManagementState(value: Record<string, unknown>): value is VoiceManagementState {
  const m = value.management;
  if (value.mode !== "management" || !record(m) || !exactKeys(m, [
    "action", "stage", "idempotencyKey", "target", "selector", "date", "time", "verified", "pendingTimeOptions"
  ]) || !["cancel", "reschedule"].includes(String(m.action)) ||
    !["select", "replacement", "confirm"].includes(String(m.stage)) ||
    typeof m.idempotencyKey !== "string" || !UUID.test(m.idempotencyKey) ||
    !record(m.selector) || !exactKeys(m.selector, ["date", "time", "serviceName"]) ||
    !(m.selector.date === null || managementDate(m.selector.date)) ||
    !(m.selector.time === null || managementTime(m.selector.time)) ||
    !validText(m.selector.serviceName, 120) ||
    !(m.date === null || managementDate(m.date)) || !(m.time === null || managementTime(m.time)) ||
    typeof m.verified !== "boolean" ||
    !(m.target === null || validVoiceTarget(m.target))) return false;
  if (m.pendingTimeOptions !== null && (!Array.isArray(m.pendingTimeOptions) ||
    m.pendingTimeOptions.length !== 2 || !m.pendingTimeOptions.every(managementTime) ||
    m.pendingTimeOptions[0] === m.pendingTimeOptions[1] || m.time !== null || m.verified)) return false;
  if ((m.stage === "select") !== (m.target === null)) return false;
  if (m.action === "cancel" && (m.date !== null || m.time !== null || m.verified ||
    m.pendingTimeOptions !== null || m.stage === "replacement")) return false;
  if (m.verified && (!m.target || !m.date || !m.time || m.stage !== "confirm")) return false;
  if (m.action === "reschedule" && m.stage === "confirm" && !m.verified) return false;
  return true;
}

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
      requestedTime: null,
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
    Object.keys(booking).some(
      (key) =>
        ![
          ...expectedKeys,
          "failures",
          "requestedTime",
          "pendingTimeOptions",
        ].includes(key)
    ) ||
    (booking.failures !== undefined &&
      (typeof booking.failures !== "number" ||
        !Number.isInteger(booking.failures) ||
        booking.failures < 0 ||
        booking.failures > 2)) ||
    expectedKeys.some(
      (field) =>
        !(field in booking)
    )
  ) {
    return false;
  }

  if (
    booking.pendingTimeOptions !== undefined &&
    (
      !Array.isArray(
        booking.pendingTimeOptions
      ) ||
      booking.pendingTimeOptions.length !== 2 ||
      booking.pendingTimeOptions.some(
        (option) =>
          typeof option !== "string" ||
          !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(
            option
          )
      ) ||
      booking.pendingTimeOptions[0] ===
        booking.pendingTimeOptions[1]
    )
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

  if (
    booking.requestedTime !== undefined &&
    booking.requestedTime !== null &&
    (typeof booking.requestedTime !== "string" ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(
        booking.requestedTime
      ))
  ) {
    return false;
  }

  /*
   * An availability-verified time must always be the time that was actually
   * requested. A token claiming otherwise is rejected rather than reconciled.
   */
  if (
    booking.time !== null &&
    booking.requestedTime !== undefined &&
    booking.requestedTime !== booking.time
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
          "recovery",
          "mode",
          "booking",
          "management",
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
    value.silence > 1 ||
    (value.recovery !== undefined &&
      (!Number.isInteger(value.recovery) || typeof value.recovery !== "number" ||
        value.recovery < 0 || value.recovery > 2))
  ) {
    throw new Error("Expired or invalid voice state");
  }

  if (value.mode === "menu" || value.mode === "info") {
    if (Object.keys(value).length !== (value.recovery === undefined ? 5 : 6)) {
      throw new Error("Invalid voice state");
    }

    return value as VoiceMenuState;
  }

  if (
    Object.keys(value).length !== (value.recovery === undefined ? 6 : 7) ||
    !(validBookingState(value) || validManagementState(value))
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

  const state = validateState(decoded, now);
  if (state.mode === "management" && state.management.target &&
    state.management.target.businessId !== binding.businessId) throw new Error("Invalid voice scope");
  return state;
}

/** Keyed, non-reversible operational correlation; never emit the binding itself. */
export function voiceDiagnosticId(binding: VoiceBinding, callback?: string): string | null {
  if (!voiceStateConfigured()) return null;
  return createHmac("sha256", key()).update(JSON.stringify([
    "voice-diagnostic-v1", binding.businessId, binding.callSid, binding.ingress,
    ...(callback === undefined ? [] : [callback]),
  ])).digest("hex").slice(0, 24);
}
