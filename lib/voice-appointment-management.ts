import {
  acceptVoiceProgress,
  classifyVoiceInput,
  recoverVoiceInput,
  voiceDigitAllowed,
} from "@/lib/voice-input";

import { randomUUID, createHash } from "node:crypto";
import { createSupabaseServiceClient } from "@/lib/supabase-server";
import { extractBookingDetails } from "@/lib/voice-slots";
import { businessLocalDate } from "@/lib/voice-parsing";
import {
  validVoiceTarget,
  type VoiceAppointmentTarget,
  type VoiceManagementState,
} from "@/lib/voice-state";

export function managementIntent(
  speech: string,
  booking = false
): "cancel" | "reschedule" | null {
  if (booking) return null;

  if (
    /\b(?:cancel|cancellation)\b/i.test(speech) &&
    /\b(?:my|appointment|booking|haircut|facial)\b/i.test(speech)
  ) {
    return "cancel";
  }

  if (
    /\b(?:reschedule|move|change)\b/i.test(speech) &&
    /\b(?:my|appointment|booking|it|haircut|facial)\b/i.test(speech)
  ) {
    return "reschedule";
  }

  return null;
}

export function managementPhone(value: string) {
  const digits = value.replace(/\D/g, "");

  const phone = value.trim().startsWith("+")
    ? `+${digits}`
    : digits.length === 10
      ? `+1${digits}`
      : `+${digits}`;

  return /^\+[1-9]\d{7,14}$/.test(phone) ? phone : null;
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);

const canonicalTime = (value: unknown) =>
  typeof value === "string" &&
  /^(?:[01]\d|2[0-3]):[0-5]\d(?::00)?$/.test(value)
    ? value.slice(0, 5)
    : null;

export async function lookupVoiceAppointments(
  businessId: string,
  callerPhone: string
): Promise<VoiceAppointmentTarget[] | null> {
  const phone = managementPhone(callerPhone);

  if (!uuid(businessId) || !phone) return null;

  try {
    const { data, error } =
      await createSupabaseServiceClient().rpc(
        "voice_find_appointments_business",
        {
          p_business_id: businessId,
          p_caller_phone: phone,
        }
      );

    if (
      error ||
      !object(data) ||
      data.success !== true ||
      data.business_id !== businessId ||
      !uuid(data.customer_id) ||
      !Array.isArray(data.appointments) ||
      data.appointments.length > 20
    ) {
      return null;
    }

    const customerId = data.customer_id;

    if (
      !data.appointments.every(
        (row) =>
          validVoiceTarget(row) &&
          row.businessId === businessId &&
          row.customerId === customerId
      ) ||
      new Set(data.appointments.map((row) => row.id)).size !==
        data.appointments.length
    ) {
      return null;
    }

    return data.appointments;
  } catch {
    console.info(
      "AnaAI voice management stage=lookup result=unverified"
    );
    return null;
  }
}

function expected(target: VoiceAppointmentTarget) {
  const {
    customerId,
    serviceId,
    serviceName,
    date,
    time,
    status,
  } = target;

  return {
    customerId,
    serviceId,
    serviceName,
    date,
    time,
    status,
  };
}

export function managementReceipt(
  value: unknown,
  state: VoiceManagementState,
  businessId: string,
  checkOnly: boolean
) {
  const m = state.management;
  const target = m.target;

  if (
    !target ||
    !object(value) ||
    value.business_id !== businessId ||
    value.appointment_id !== target.id ||
    value.customer_id !== target.customerId ||
    value.service_id !== target.serviceId
  ) {
    return false;
  }

  if (checkOnly) {
    return (
      value.available === true &&
      value.code === "AVAILABLE" &&
      value.date === m.date &&
      canonicalTime(value.time) === m.time
    );
  }

  if (
    value.success !== true ||
    value.changed !== true ||
    value.code !== "APPLIED" ||
    !uuid(value.action_id) ||
    value.action_type !== m.action ||
    typeof value.replayed !== "boolean" ||
    value.receipt_scope !== "action_outcome"
  ) {
    return false;
  }

  if (m.action === "cancel") {
    return (
      value.status === "Cancelled" &&
      value.date === target.date &&
      canonicalTime(value.time) === target.time
    );
  }

  return (
    value.status === target.status &&
    value.date === m.date &&
    canonicalTime(value.time) === m.time &&
    Number.isInteger(value.duration_minutes) &&
    Number(value.duration_minutes) > 0
  );
}

export async function manageVoiceAppointment(
  state: VoiceManagementState,
  businessId: string,
  callerPhone: string,
  checkOnly: boolean
) {
  const m = state.management;
  const phone = managementPhone(callerPhone);

  if (
    !phone ||
    !m.target ||
    m.target.businessId !== businessId ||
    !uuid(m.idempotencyKey) ||
    (checkOnly && m.action !== "reschedule") ||
    (!checkOnly && m.stage !== "confirm") ||
    (m.action === "reschedule" &&
      (!m.date ||
        !m.time ||
        (!checkOnly && !m.verified)))
  ) {
    return {
      verified: false,
      conflict: false,
      replayed: false,
    };
  }

  const request = {
    action: m.action,
    target: m.target.id,
    expected: expected(m.target),
    date: m.date,
    time: m.time,
  };

  try {
    const { data, error } =
      await createSupabaseServiceClient().rpc(
        "voice_manage_appointment_business",
        {
          p_business_id: businessId,
          p_caller_phone: phone,
          p_appointment_id: m.target.id,
          p_action_type: m.action,
          p_idempotency_key: m.idempotencyKey,
          p_request_fingerprint: createHash("sha256")
            .update(JSON.stringify(request))
            .digest("hex"),
          p_expected: request.expected,
          p_date: m.date,
          p_time: m.time,
          p_check_only: checkOnly,
        }
      );

    return {
      verified:
        !error &&
        managementReceipt(data, state, businessId, checkOnly),
      conflict:
        !error &&
        object(data) &&
        data.code === "SLOT_CONFLICT",
      replayed:
        !error &&
        object(data) &&
        data.replayed === true,
    };
  } catch {
    console.info(
      "AnaAI voice management stage=execution result=unverified"
    );

    return {
      verified: false,
      conflict: false,
      replayed: false,
    };
  }
}

export type ManagementDependencies = {
  lookup: typeof lookupVoiceAppointments;
  execute: typeof manageVoiceAppointment;
};

const dependencies: ManagementDependencies = {
  lookup: lookupVoiceAppointments,
  execute: manageVoiceAppointment,
};

function summary(target: VoiceAppointmentTarget) {
  const date = new Date(
    `${target.date}T00:00:00Z`
  ).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "long",
    day: "numeric",
  });

  const [hour, minute] = target.time.split(":").map(Number);

  return `${target.serviceName} on ${date} at ${
    hour % 12 || 12
  }${
    minute
      ? `:${String(minute).padStart(2, "0")}`
      : ""
  } ${hour >= 12 ? "PM" : "AM"}`;
}

export function managementRecoveryPrompt(
  state: VoiceManagementState
): string {
  const m = state.management;

  if (m.stage === "confirm" && m.target) {
    return m.action === "cancel"
      ? `I found your ${summary(
          m.target
        )} appointment. Do you want me to cancel it? Say yes or press 1 to confirm, or press 2 to stop.`
      : `Move your ${summary(
          m.target
        )} appointment to ${summary({
          ...m.target,
          date: m.date!,
          time: m.time!,
        })}? Say yes or press 1 to confirm, or press 2 to stop.`;
  }

  if (m.pendingTimeOptions) {
    return "Did you mean AM or PM?";
  }

  if (m.stage === "replacement") {
    return !m.date
      ? "What day would you like to move your appointment to?"
      : "What time would you like? Please include AM or PM.";
  }

  return "Please tell me which appointment you mean, or say person for help.";
}

type ManagementTurn = {
  state: VoiceManagementState;
  businessId: string;
  callerPhone: string;
  timezone: string | null;
  speech: string;
  digits: string;
  confidence: string;
  opening?: boolean;
  onMutation?: () => void;
};

function managementProgress(
  state: VoiceManagementState
): string {
  const {
    action,
    target,
    selector,
    date,
    time,
    verified,
    pendingTimeOptions,
  } = state.management;

  return JSON.stringify({
    action,
    target,
    selector,
    date,
    time,
    verified,
    pendingTimeOptions,
  });
}

export async function voiceManagementTurn(
  args: ManagementTurn,
  deps: ManagementDependencies = dependencies
) {
  const { state } = args;

  const input = classifyVoiceInput(
    args.speech,
    args.digits,
    args.confidence
  );

  const recovery = (
    empty: boolean,
    message = managementRecoveryPrompt(state)
  ) => {
    const done = recoverVoiceInput(state, empty);

    return {
      done,
      message: done
        ? "I couldn't hear you clearly. Your appointment has not been changed. Please contact the business for help. Goodbye."
        : `I didn't hear that clearly. ${message}`,
    };
  };

  if (
    (input.kind !== "speech" &&
      input.kind !== "dtmf") ||
    (input.kind === "dtmf" &&
      !voiceDigitAllowed(state, args.digits))
  ) {
    return recovery(input.kind === "empty");
  }

  const draft: VoiceManagementState =
    JSON.parse(JSON.stringify(state));

  const result = await managementTurn(
    {
      ...args,
      state: draft,
      speech: args.speech.trim(),
      digits: args.digits.trim(),
    },
    deps
  );

  const progress =
    managementProgress(draft) !==
    managementProgress(state);

  // Failed recognition never reaches this point. Accepted explicit
  // corrections retain their stale-confirmation invalidation, even
  // if not yet resolvable.
  const invalidated =
    state.management.verified &&
    !draft.management.verified;

  if (progress || invalidated || result.done) {
    state.management = draft.management;
  }

  if (result.done) {
    return result;
  }

  // Only resolved state advancement resets the unsuccessful-turn
  // budget. Unresolved ambiguity/conflict remains bounded even if
  // parsing temporarily changed internal management fields.
  if (progress && !result.unresolved) {
    acceptVoiceProgress(state);
    return result;
  }

  return recovery(false, result.message);
}

// This flow never asks a model to authorize a mutation. A whole-turn
// affirmative is accepted only after the exact target/replacement has
// been summarized.
async function managementTurn(
  {
    state,
    businessId,
    callerPhone,
    timezone,
    speech,
    digits,
    opening = false,
    onMutation,
  }: ManagementTurn,
  deps: ManagementDependencies = dependencies
): Promise<{
  message: string;
  done: boolean;
  unresolved?: boolean;
}> {
  const m = state.management;

  const reply = (
    message: string,
    done = false,
    unresolved = false
  ) => ({
    message,
    done,
    unresolved,
  });

  const fail = () =>
    reply(
      "I couldn't verify that appointment action. Please check with the business before trying again.",
      true
    );

  if (speech.length > 500) {
    return reply(
      "Please tell me one short appointment request at a time."
    );
  }

  if (
    digits === "2" ||
    /^(?:no(?: thanks| thank you)?|never mind|nevermind|stop|cancel (?:this|the) (?:request|change))[.!?, ]*$/i.test(
      speech
    )
  ) {
    return reply(
      "Okay. I haven't changed your appointment.",
      true
    );
  }

  const nextIntent = managementIntent(speech);

  if (
    !opening &&
    nextIntent &&
    nextIntent !== m.action
  ) {
    m.action = nextIntent;

    m.stage = m.target
      ? nextIntent === "cancel"
        ? "confirm"
        : "replacement"
      : "select";

    m.date = null;
    m.time = null;
    m.verified = false;
    m.pendingTimeOptions = null;
    m.idempotencyKey = randomUUID();

    // Switching operations is never authorization, even if the
    // utterance says yes.
    opening = true;
  }

  // Strict full-turn confirmation also prevents
  // "yes, ...changed details" from authorizing on the same turn,
  // even if extraction cannot parse the details.
  const yes =
    /^(?:yes(?: please)?|correct|go ahead|that is correct|that's correct|confirm)[.!?, ]*$/i.test(
      speech
    );

  if (
    !opening &&
    m.stage === "confirm" &&
    ((digits === "1" && !speech) ||
      (!digits && yes))
  ) {
    onMutation?.();

    const result = await deps.execute(
      state,
      businessId,
      callerPhone,
      false
    );

    if (result.verified) {
      return reply(
        result.replayed
          ? "Your earlier appointment change succeeded. This retry made no new change."
          : m.action === "cancel"
            ? "Your appointment has been cancelled."
            : "Your appointment has been rescheduled.",
        true
      );
    }

    if (
      result.conflict &&
      m.action === "reschedule"
    ) {
      m.stage = "replacement";
      m.verified = false;
      m.time = null;
      m.idempotencyKey = randomUUID();

      return reply(
        "That time is no longer available. What time would you like instead?",
        false,
        true
      );
    }

    return fail();
  }

  let replacement = speech;

  if (!m.target) {
    const rows = await deps.lookup(
      businessId,
      callerPhone
    );

    if (!rows) {
      return fail();
    }

    // Split old selector from new schedule before extracting either
    // date.
    const split =
      m.action === "reschedule"
        ? /\bto\s+(.+)$/i.exec(speech)
        : null;

    const selectorSpeech = split
      ? speech.slice(0, split.index)
      : speech;

    replacement = split?.[1] || "";

    const services = Array.from(
      new Map(
        rows.map((row) => [
          row.serviceName,
          {
            id: row.serviceId || row.id,
            name: row.serviceName,
          },
        ])
      ).values()
    );

    const detail = extractBookingDetails({
      speech: selectorSpeech,
      services,
      timezone,
      wantName: false,
    });

    if (
      detail.dateUnresolved ||
      detail.serviceCandidates.length > 1 ||
      detail.time?.kind === "invalid"
    ) {
      return reply(
        "Which appointment date, service, or time do you mean?",
        false,
        true
      );
    }

    if (
      !detail.any &&
      !/\bappointment|\bbooking\b/i.test(
        selectorSpeech
      ) &&
      selectorSpeech
        .replace(
          /\b(?:please|can|could|you|i|want|would|like|to|cancel|reschedule|move|change|my|it)\b/gi,
          ""
        )
        .replace(/[.!?, ]/g, "")
    ) {
      return reply(
        "Which appointment date or service do you mean?"
      );
    }

    if (detail.date) {
      m.selector.date = detail.date;
    }

    if (detail.service) {
      m.selector.serviceName =
        detail.service.name;
    }

    if (detail.time?.kind === "valid") {
      m.selector.time = detail.time.value;
    }

    // Ambiguous selector times match both periods; uniqueness must
    // resolve them.
    const options =
      detail.time?.kind === "ambiguous"
        ? detail.time.options
        : null;

    const matches = rows.filter(
      (row) =>
        (!m.selector.date ||
          row.date === m.selector.date) &&
        (!m.selector.serviceName ||
          row.serviceName ===
            m.selector.serviceName) &&
        (options
          ? options.includes(row.time)
          : !m.selector.time ||
            row.time === m.selector.time)
    );

    if (!matches.length) {
      return reply(
        "I couldn't find a matching upcoming appointment for your calling number. Please ask a team member for help.",
        true
      );
    }

    if (matches.length > 1) {
      // Retain a replacement supplied with an ambiguous target,
      // without trusting any candidate until a later unique lookup
      // resolves it.
      if (replacement) {
        collectReplacement(
          m,
          replacement,
          timezone
        );
      }

      return reply(
        `Which appointment do you mean: ${matches
          .slice(0, 3)
          .map(summary)
          .join("; or ")}${
          matches.length > 3
            ? "; or another appointment"
            : ""
        }?`,
        false,
        true
      );
    }

    m.target = matches[0];

    m.stage =
      m.action === "cancel"
        ? "confirm"
        : "replacement";
  }

  if (m.action === "cancel") {
    // A detail-bearing response to the cancellation summary selects
    // afresh.
    if (
      !opening &&
      replacement &&
      !yes &&
      m.stage === "confirm"
    ) {
      const detail = extractBookingDetails({
        speech,
        services: [
          {
            id:
              m.target.serviceId ||
              m.target.id,
            name: m.target.serviceName,
          },
        ],
        timezone,
        wantName: false,
      });

      if (detail.any) {
        m.target = null;
        m.stage = "select";

        m.selector = {
          date: null,
          time: null,
          serviceName: null,
        };

        return managementTurn(
          {
            state,
            businessId,
            callerPhone,
            timezone,
            speech,
            digits: "",
            confidence: "high",
            opening: true,
            onMutation,
          },
          deps
        );
      }
    }

    return reply(
      `I found your ${summary(
        m.target
      )} appointment. Do you want me to cancel it? Say yes or press 1 to confirm, or press 2 to stop.`
    );
  }

  const candidate = extractBookingDetails({
    speech: replacement,
    services: [],
    timezone,
    wantName: false,
  });

  const period =
    m.pendingTimeOptions &&
    /^(?:in the )?(?:a\.?m\.?|p\.?m\.?|morning|afternoon|evening)[.!?, ]*$/i.test(
      replacement
    );

  const explicitCorrection =
    /\b(?:actually|instead|change|another|different|meant|rather)\b/i.test(
      replacement
    );

  if (
    !candidate.any &&
    !period &&
    !explicitCorrection
  ) {
    return reply(
      managementRecoveryPrompt(state)
    );
  }

  const collected = collectReplacement(
    m,
    replacement,
    timezone
  );

  if (collected) {
    return reply(
      collected,
      false,
      true
    );
  }

  if (!m.date) {
    return reply(
      "What day would you like to move your appointment to?"
    );
  }

  if (!m.time) {
    return reply(
      "What time would you like? Please include AM or PM."
    );
  }

  m.verified = false;
  m.stage = "replacement";

  const result = await deps.execute(
    state,
    businessId,
    callerPhone,
    true
  );

  if (!result.verified) {
    m.time = null;

    return result.conflict
      ? reply(
          "That time isn't available. What time would you like instead?",
          false,
          true
        )
      : fail();
  }

  m.verified = true;
  m.stage = "confirm";

  return reply(
    `Move your ${summary(
      m.target
    )} appointment to ${summary({
      ...m.target,
      date: m.date,
      time: m.time,
    })}? Say yes or press 1 to confirm, or press 2 to stop.`
  );
}

function collectReplacement(
  m: VoiceManagementState["management"],
  speech: string,
  timezone: string | null
): string | null {
  if (!speech) {
    return null;
  }

  const details = extractBookingDetails({
    speech,
    services: [],
    timezone,
    wantName: false,
  });

  if (
    m.pendingTimeOptions &&
    /^(?:in the )?(?:a\.?m\.?|p\.?m\.?|morning|afternoon|evening)[.!?, ]*$/i.test(
      speech
    )
  ) {
    m.time =
      m.pendingTimeOptions[
        /^(?:in the )?(?:a|morning)/i.test(
          speech
        )
          ? 0
          : 1
      ];

    m.pendingTimeOptions = null;
    m.verified = false;
    m.stage = m.target
      ? "replacement"
      : "select";
    m.idempotencyKey = randomUUID();

    return null;
  }

  // Any attempted correction invalidates confirmation, including an
  // unparsed correction. Never let a subsequent yes authorize the
  // previous schedule.
  m.verified = false;
  m.stage = m.target
    ? "replacement"
    : "select";
  m.idempotencyKey = randomUUID();

  if (
    details.dateUnresolved ||
    (details.date &&
      details.date <
        (businessLocalDate(timezone) ||
          "9999"))
  ) {
    m.date = null;

    return "What future day would you like instead?";
  }

  if (details.date) {
    m.date = details.date;
  }

  if (details.time?.kind === "valid") {
    m.time = details.time.value;
    m.pendingTimeOptions = null;
  } else if (
    details.time?.kind === "ambiguous"
  ) {
    m.time = null;
    m.pendingTimeOptions =
      details.time.options;

    return "Did you mean AM or PM?";
  } else if (
    details.time?.kind === "invalid"
  ) {
    m.time = null;

    return "Please say the replacement time with AM or PM.";
  } else if (
    !details.date &&
    !m.pendingTimeOptions
  ) {
    // The unrecognized turn may contain a requested change, so re-ask.
    m.time = null;
  }

  return null;
}