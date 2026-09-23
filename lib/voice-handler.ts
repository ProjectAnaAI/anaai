import twilio from "twilio";
import { acceptVoiceProgress, classifyVoiceInput, recoverVoiceInput, statelessVoiceRecovery,
  voiceConfidence, voiceDigitAllowed, voiceRecoveryMode, type VoiceRecovery } from "@/lib/voice-input";
import { managementIntent, managementRecoveryPrompt, voiceManagementTurn } from "@/lib/voice-appointment-management";
import { initialManagementState } from "@/lib/voice-state";

import {
  checkVoiceAvailability,
  executeVoiceBooking,
  loadVoiceServices,
} from "@/lib/voice-booking";

import {
  answerVoiceQuestion,
  safeVoiceText,
} from "@/lib/voice-receptionist";

import {
  createSupabaseServiceClient,
} from "@/lib/supabase-server";

import {
  initialBookingState,
  initialVoiceState,
  openVoiceState,
  sealVoiceState,
  voiceStateConfigured,
  voiceDiagnosticId,
  type VoiceBinding,
  type VoiceBookingStage,
  type VoiceBookingState,
  type VoiceState,
} from "@/lib/voice-state";

import {
  bookingDate,
  businessLocalDate,
  parseSpokenTime,
  confirmation as interpretConfirmation,
  type TimeInterpretation,
} from "@/lib/voice-parsing";

import {
  applyBookingDetails,
  extractBookingDetails,
  missingBookingField,
} from "@/lib/voice-slots";

import {
  voiceOptions,
  gatherOptions,
} from "@/lib/voice-config";

import {
  understandVoiceTurn,
  type VoiceTurnUnderstanding,
} from "@/lib/voice-understanding";

export type VoiceIngress =
  | "production"
  | "trial";

type BusinessContext = {
  businessId: string;
  businessName: string;
  timezone: string | null;
};

type VoiceService = Awaited<
  ReturnType<typeof loadVoiceServices>
>[number];

const INFO_PROMPT =
  "What would you like to know about our services, hours, or location?";

const TRANSFER_UNAVAILABLE =
  "I'm sorry, transferring to a team member isn't available right now. I can still help with business information.";

const TRANSFER_CONNECTING =
  "Okay. I'll connect you with someone at the salon.";

const HUMAN_REQUEST =
  /\b(?:transfer(?: me)?(?: to| with)?(?: someone| somebody| a person| a human| a representative| an agent| a team member| someone at the (?:salon|store))?|representative|agent|human|real person|team member|store employee|someone at the (?:salon|store)|connect me (?:to|with) (?:someone|somebody|a person|a human|a representative|an agent|a team member|someone at the (?:salon|store))|(?:speak|talk) (?:with|to) (?:someone|somebody|a person|a human|a representative|an agent|a team member|someone at the (?:salon|store)))\b/i;

function wantsHuman(
  speech: string
) {
  return HUMAN_REQUEST.test(
    speech
  ) || /^person[.!?, ]*$/i.test(speech);
}

const BOOKING_STATE_UNAVAILABLE =
  "I'm sorry, phone booking is temporarily unavailable. I can still help with business information.";

/*
 * Bare "appointment" is deliberately NOT an intent: callers ask about
 * appointments without wanting to make one. Only an explicit booking verb, or
 * an unmistakable multi-word request, starts the booking flow.
 */
const BOOKING_INTENT =
  /\b(?:book|booking|schedule|reserve)\b|\b(?:make|set up|get|need|want)\s+(?:me\s+)?(?:an?\s+)?appointment\b|\bcome\s+in\b/i;

const PHONE =
  /^\+[1-9]\d{7,14}$/;

function productionVoiceUrl() {
  const value =
    process.env.TWILIO_VOICE_WEBHOOK_URL?.trim();

  if (!value) {
    return "";
  }

  try {
    const url =
      new URL(value);

    if (
      url.protocol !== "https:" &&
      url.protocol !== "http:"
    ) {
      return "";
    }

    return url.toString();
  } catch {
    return "";
  }
}

function callbackUrl(
  ingress: VoiceIngress,
  mode: string,
  state?: string
) {
  const configured =
    productionVoiceUrl();

  if (!configured) {
    throw new Error(
      "TWILIO_VOICE_WEBHOOK_URL is missing or invalid."
    );
  }

  if (
    ingress === "production"
  ) {
    const url =
      new URL(configured);

    if (mode) {
      url.searchParams.set(
        "mode",
        mode
      );
    }

    if (state) {
      url.searchParams.set(
        "state",
        state
      );
    }

    return url.toString();
  }

  const token =
    process.env.TWILIO_TRIAL_VOICE_TOKEN?.trim();

  if (!token) {
    throw new Error(
      "TWILIO_TRIAL_VOICE_TOKEN is missing."
    );
  }

  const production =
    new URL(configured);

  const url =
    new URL(
      "/api/voice/trial",
      production.origin
    );

  url.searchParams.set(
    "token",
    token
  );

  if (mode) {
    url.searchParams.set(
      "mode",
      mode
    );
  }

  if (state) {
    url.searchParams.set(
      "state",
      state
    );
  }

  return url.toString();
}

function normalizePhone(
  value: string
) {
  const trimmed =
    value.trim();

  if (!trimmed) {
    return "";
  }

  if (
    trimmed.startsWith("+")
  ) {
    const digits =
      trimmed
        .slice(1)
        .replace(/\D/g, "");

    return digits
      ? `+${digits}`
      : "";
  }

  const digits =
    trimmed.replace(
      /\D/g,
      ""
    );

  if (
    digits.length === 10
  ) {
    return `+1${digits}`;
  }

  if (
    digits.length === 11 &&
    digits.startsWith("1")
  ) {
    return `+${digits}`;
  }

  return digits
    ? `+${digits}`
    : "";
}

async function transferToHuman({
  response,
  businessId,
  inboundPhone,
}: {
  response: InstanceType<
    typeof twilio.twiml.VoiceResponse
  >;
  businessId: string;
  inboundPhone: string;
}) {
  const db =
    createSupabaseServiceClient();

  const {
    data,
    error,
  } = await db
    .from(
      "voice_handoff_settings"
    )
    .select(
      "human_transfer_phone,is_enabled"
    )
    .eq(
      "business_id",
      businessId
    )
    .abortSignal(
      AbortSignal.timeout(
        3000
      )
    )
    .maybeSingle();

  if (
    error ||
    !data ||
    data.is_enabled !== true ||
    typeof data.human_transfer_phone !==
      "string"
  ) {
    if (error) {
      console.error(
        "AnaAI voice handoff lookup failed."
      );
    }

    return false;
  }

  const destination =
    data.human_transfer_phone.trim();

  const inbound =
    normalizePhone(
      inboundPhone
    );

  if (
    !PHONE.test(
      destination
    ) ||
    !inbound ||
    destination === inbound
  ) {
    console.warn(
      "AnaAI voice handoff destination is unavailable or unsafe."
    );

    return false;
  }

  response.say(
    voiceOptions(),
    TRANSFER_CONNECTING
  );

  response
    .dial()
    .number(
      destination
    );

  return true;
}

async function resolveBusinessByCalledNumber(
  calledNumber: string
): Promise<BusinessContext | null> {
  const phone =
    normalizePhone(
      calledNumber
    );

  if (!phone) {
    return null;
  }

  const db =
    createSupabaseServiceClient();

  const {
    data,
    error,
  } = await db
    .from(
      "business_phone_numbers"
    )
    .select(
      `
        business_id,
        businesses!inner (
          name,
          timezone
        )
      `
    )
    .eq(
      "phone_number",
      phone
    )
    .eq(
      "provider",
      "twilio"
    )
    .eq(
      "is_active",
      true
    )
    .abortSignal(
      AbortSignal.timeout(
        3000
      )
    )
    .maybeSingle();

  if (error) {
    console.error(
      "AnaAI voice business lookup failed."
    );

    throw new Error(
      "Voice business lookup failed."
    );
  }

  if (!data) {
    return null;
  }

  const related =
    Array.isArray(
      data.businesses
    )
      ? data.businesses[0]
      : data.businesses;

  const businessName =
    related &&
    typeof related ===
      "object" &&
    "name" in related &&
    typeof related.name ===
      "string"
      ? related.name.trim()
      : "";

  if (
    !data.business_id ||
    !businessName
  ) {
    console.error(
      "AnaAI voice business lookup returned incomplete routing data."
    );

    throw new Error(
      "Voice business routing data is incomplete."
    );
  }

  return {
    businessId:
      data.business_id,

    businessName,

    timezone:
      related &&
      typeof related ===
        "object" &&
      "timezone" in related &&
      typeof related.timezone ===
        "string"
        ? related.timezone
        : null,
  };
}

function mainMenu(
  name: string
) {
  return `Hi, this is AnaAI from ${
    safeVoiceText(
      name,
      100
    ) || "the business"
  }. How can I help? Speak naturally, or press 1 to book an appointment, 2 for business information, 3 for a team member, or 0 to repeat these options.`;
}

function recoveryPrompt(state: VoiceState | null, empty: boolean, timezone: string | null): string {
  const prefix = empty ? "I didn't catch that. " : "I didn't hear that clearly enough. ";
  if (state?.mode === "management") return prefix + managementRecoveryPrompt(state);
  if (state?.mode !== "booking") return (empty ? "I didn't hear anything. " : prefix) +
    (state?.mode === "info" ? INFO_PROMPT : "Speak naturally, or press 0 to hear the options.");
  const b = state.booking;
  if (b.pendingTimeOptions) return prefix + `Did you mean ${spokenTime(b.pendingTimeOptions[0])} or ${spokenTime(b.pendingTimeOptions[1])}? Say AM or PM, or press 1 for the first and 2 for the second.`;
  if (b.stage === "confirm" && b.time) {
    const day = spokenDate(b.date || "", timezone);
    return prefix + `I have ${b.serviceName} for ${b.customerName} ${day === "today" || day === "tomorrow" ? day : `on ${day}`} at ${spokenTime(b.time)}. Say yes or press 1 to book it, no to cancel, or tell me what to change.`;
  }
  if (!b.customerName) return prefix + "What name should I put on the appointment?";
  if (!b.serviceId) return prefix + "Which service would you like?";
  if (!b.date) return prefix + "What day would you like?";
  return prefix + "What time would you like? Please include AM or PM.";
}

function gather(
  response:
    twilio.twiml.VoiceResponse,
  ingress: VoiceIngress,
  binding: VoiceBinding,
  message: string,
  state: VoiceState | null,
  mode = "listen",
  services: string[] = []
) {
  if (
    state &&
    (state.turns >= 30 ||
      state.expires <=
        Date.now())
  ) {
    response.say(
      voiceOptions(),
      "Thanks for calling. Please call again if you need more help. Goodbye."
    );

    response.hangup();
    return;
  }

  const token =
    state
      ? sealVoiceState(
          state,
          binding
        )
      : undefined;

  const input =
    response.gather({
      ...gatherOptions(
        state?.mode ===
          "booking"
          ? state.booking.stage
          : state?.mode === "management" ? (state.management.stage === "confirm" ? "confirm" : "time") : undefined,
        services
      ),

      action:
        callbackUrl(
          ingress,
          mode,
          token
        ),
    });

  input.say(
    voiceOptions(),
    message
  );
}

function spokenTime(
  value: string
) {
  const [
    hours,
    minutes,
  ] = value.split(":");

  const hour =
    Number(hours);

  const minute =
    Number(minutes);

  if (
    !Number.isInteger(
      hour
    ) ||
    !Number.isInteger(
      minute
    )
  ) {
    return value;
  }

  const suffix =
    hour >= 12
      ? "PM"
      : "AM";

  const displayHour =
    hour % 12 === 0
      ? 12
      : hour % 12;

  return minute === 0
    ? `${displayHour} ${suffix}`
    : `${displayHour}:${String(
        minute
      ).padStart(
        2,
        "0"
      )} ${suffix}`;
}

/*
 * Speak a business-local calendar day the way a receptionist would. The value
 * is already a business-local day string, so it is formatted in UTC to avoid
 * re-applying any timezone shift.
 */
function spokenDate(
  value: string,
  timezone: string | null
) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(
      value
    )
  ) {
    return value;
  }

  if (
    value ===
    businessLocalDate(
      timezone
    )
  ) {
    return "today";
  }

  if (
    value ===
    businessLocalDate(
      timezone,
      1
    )
  ) {
    return "tomorrow";
  }

  try {
    return new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone: "UTC",
        weekday: "long",
        month: "long",
        day: "numeric",
      }
    ).format(
      new Date(
        `${value}T00:00:00Z`
      )
    );
  } catch {
    return value;
  }
}

async function beginBooking({
  response,
  ingress,
  binding,
  business,
  speech,
  confidence,
  callerPhone,
  previousState,
}: {
  response:
    twilio.twiml.VoiceResponse;
  ingress: VoiceIngress;
  binding: VoiceBinding;
  business: BusinessContext;
  speech: string;
  confidence: string;
  callerPhone: string;
  previousState: VoiceState | null;
}) {
  if (
    !voiceStateConfigured()
  ) {
    gather(
      response,
      ingress,
      binding,
      BOOKING_STATE_UNAVAILABLE,
      null
    );

    return;
  }

  const budget = previousState ? {
    turns: previousState.turns, expires: previousState.expires,
    silence: previousState.silence, recovery: previousState.recovery,
  } : { turns: 1 };
  const state = Object.assign(previousState || {}, initialBookingState(), budget) as VoiceBookingState;

  /*
   * The utterance that STARTED the booking usually carries details:
   * "I want to book an appointment for tomorrow at 1 PM" already supplies the
   * day and the time. Replaying it through the ordinary booking turn keeps
   * those values instead of discarding them and asking from scratch.
   */
  if (speech) {
    await bookingTurn({
      response,
      ingress,
      binding,
      business,
      state,
      speech,
      digits: "",
      confidence,
      callerPhone,
      opening: true,
    });

    return;
  }

  gather(
    response,
    ingress,
    binding,
    "I can help with that. What name should I put on the appointment?",
    state
  );
}

function recognitionConfidence(formData: FormData) {
  return voiceConfidence(formData.get("Confidence"));
}

function logRecognition({
  stage,
  speech,
  confidence,
}: {
  stage: string;
  speech: string;
  confidence: string;
}) {
  const length =
    speech.length;

  const speechLength =
    length === 0
      ? "empty"
      : length <= 20
        ? "short"
        : length <= 80
          ? "medium"
          : "long";

  console.info(
    `AnaAI voice recognition stage=${stage} speech_present=${
      Boolean(speech)
    } speech_length=${speechLength} confidence=${confidence}`
  );
}

function semanticFields(
  understanding:
    VoiceTurnUnderstanding
) {
  return [
    understanding
      .serviceName
      ? "service"
      : "",
    understanding
      .dateExpression
      ? "date"
      : "",
    understanding
      .timeExpression
      ? "time"
      : "",
    understanding
      .confirmation
      ? "confirmation"
      : "",
    understanding
      .correction
      ? "correction"
      : "",
  ]
    .filter(Boolean)
    .join("+") || "none";
}

async function understand({
  stage,
  speech,
  services = [],
}: {
  stage:
    | "name"
    | "service"
    | "date"
    | "time"
    | "confirm";
  speech: string;
  services?: VoiceService[];
}) {
  const result =
    await understandVoiceTurn({
      stage,
      speech,
      services:
        services.map(
          (service) =>
            service.name
        ),
    });

  console.info(
    `AnaAI voice semantic result stage=${stage} meaningful=${result.meaningful} fields=${semanticFields(
      result
    )}`
  );

  return result;
}

function resolveService(
  services: VoiceService[],
  name: string | null
) {
  if (!name) {
    return null;
  }

  return (
    services.find(
      (service) =>
        service.name === name
    ) || null
  );
}

function validateDateExpression(
  expression: string,
  business: BusinessContext
) {
  const date =
    bookingDate(
      expression,
      business.timezone
    );

  if (!date) {
    return {
      valid: false as const,
      reason:
        "invalid" as const,
    };
  }

  const today =
    businessLocalDate(
      business.timezone
    );

  if (
    today &&
    date < today
  ) {
    return {
      valid: false as const,
      reason:
        "past" as const,
    };
  }

  return {
    valid: true as const,
    date,
  };
}

/*
 * Period answers to an AM/PM clarification. Deliberately narrow: anything
 * richer than a bare period falls through to full extraction so the caller can
 * replace the detail outright instead of being trapped in the clarification.
 */
function periodChoice(
  speech: string
): "am" | "pm" | null {
  const text = speech
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[.!?,]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (
    /^(?:the )?(?:a ?m|in the morning|morning)$/.test(
      text
    )
  ) {
    return "am";
  }

  if (
    /^(?:the )?(?:p ?m|in the afternoon|afternoon|in the evening|evening|at night|night)$/.test(
      text
    )
  ) {
    return "pm";
  }

  return null;
}

async function bookingTurn({
  response,
  ingress,
  binding,
  business,
  state,
  speech,
  digits,
  confidence,
  callerPhone,
  opening = false,
  onMutation,
}: {
  response:
    twilio.twiml.VoiceResponse;
  ingress: VoiceIngress;
  binding: VoiceBinding;
  business: BusinessContext;
  state: VoiceBookingState;
  speech: string;
  digits: string;
  confidence: string;
  callerPhone: string;
  opening?: boolean;
  onMutation?: () => void;
}) {
  const booking = state.booking;
  const recoveryBefore = state.recovery || 0;
  const failuresBefore = booking.failures || 0;

  // Defense in depth: entry-point classification rejects low/invalid speech
  // before this function can collect fields or invoke dependencies.
  const lowConfidence =
    confidence === "low" || confidence === "invalid";

  const say = (
    message: string
  ) => {
    response.say(
      voiceOptions(),
      message
    );

    response.hangup();
  };

  const services =
    await loadVoiceServices(
      business.businessId
    );

  if (!services.length) {
    say(
      "I'm sorry, I can't find any services available for phone booking right now. No appointment was booked."
    );

    return;
  }

  const serviceNames =
    services.map(
      (service) =>
        service.name
    );

  /*
   * Every booking turn biases recognition toward the routed service names, not
   * just the turn that asks for a service: any question may be answered with a
   * service, a day and a time in one sentence.
   */
  const listen = (
    message: string,
    hints: string[] = serviceNames
  ) =>
    gather(
      response,
      ingress,
      binding,
      message,
      state,
      "listen",
      hints
    );

  const retry = (
    message: string,
    hints: string[] = []
  ) => {
    booking.failures = failuresBefore + 1;
    state.recovery = recoveryBefore;

    if (
      recoverVoiceInput(state) || booking.failures >= 3
    ) {
      say(
        "I'm having trouble understanding. No appointment was booked. Please call the salon directly and someone can help. Goodbye."
      );

      return;
    }

    listen(
      message,
      hints
    );
  };

  /*
   * The single question for whatever is still missing. Every prompt names only
   * the outstanding field, so a caller is never re-asked for something already
   * supplied and never re-hears the whole service menu.
   */
  const ask = (
    prefix = ""
  ) => {
    const missing =
      missingBookingField(
        booking
      );

    if (missing === "name") {
      listen(
        `${prefix}What name should I put on the appointment?`
      );

      return;
    }

    if (
      missing === "service"
    ) {
      listen(
        `${prefix}Which service would you like? We offer ${serviceNames
          .slice(0, 6)
          .join(", ")}.`,
        serviceNames
      );

      return;
    }

    if (missing === "date") {
      listen(
        `${prefix}What day would you like for ${booking.serviceName}? You can say tomorrow, a weekday, or a month and day.`
      );

      return;
    }

    listen(
      `${prefix}What time would you like? For example, 10 AM or 2:30 PM.`
    );
  };

  const summary = () => {
    const day = spokenDate(
      booking.date || "",
      business.timezone
    );

    /* "on tomorrow" is not how a receptionist speaks. */
    return `${booking.serviceName} for ${booking.customerName} ${
      day === "today" || day === "tomorrow"
        ? day
        : `on ${day}`
    } at ${spokenTime(
      booking.time ||
        booking.requestedTime ||
        ""
    )}`;
  };

  const askAmPm = (
    options: [
      string,
      string,
    ],
    prefix = ""
  ) => {
    booking.pendingTimeOptions =
      options;

    listen(
      `${prefix}Did you mean ${spokenTime(
        options[0]
      )} or ${spokenTime(
        options[1]
      )}? Say AM or PM, or press 1 for ${spokenTime(
        options[0]
      )} and 2 for ${spokenTime(
        options[1]
      )}.`
    );
  };

  /*
   * Availability is advisory and always recomputed here. `booking.time` is set
   * ONLY by a successful check, so an availability answer can never outlive the
   * service, date or time it was computed for.
   */
  const checkAvailability =
    async () => {
      const requested =
        booking.requestedTime;

      if (
        !booking.serviceId ||
        !booking.date ||
        !requested
      ) {
        ask();
        return;
      }

      const started =
        Date.now();

      const availability =
        await checkVoiceAvailability(
          {
            businessId:
              business.businessId,

            serviceId:
              booking.serviceId,

            date:
              booking.date,

            time:
              requested,
          }
        );

      console.info(
        `AnaAI voice availability completed duration_ms=${
          Date.now() -
          started
        } result=${
          availability.available
            ? "available"
            : availability.reason
        }`
      );

      if (
        availability.available
      ) {
        booking.failures = 0;
        acceptVoiceProgress(state);
        booking.time =
          requested;

        booking.stage =
          "confirm";

        listen(
          `I have ${summary()}. Say yes or press 1 to book it, no to cancel, or tell me what to change.`
        );

        return;
      }

      booking.time = null;

      if (
        availability.reason ===
        "slot_unavailable"
      ) {
        booking.requestedTime =
          null;

        booking.stage =
          "time";

        retry(
          `That time isn't available for ${booking.serviceName} on ${spokenDate(
            booking.date,
            business.timezone
          )}. What other time works?`
        );

        return;
      }

      if (
        availability.reason ===
        "outside_hours"
      ) {
        booking.requestedTime =
          null;

        booking.stage =
          "time";

        retry(
          "That's outside our hours that day. What other time works?"
        );

        return;
      }

      if (
        availability.reason ===
        "closed"
      ) {
        booking.date = null;

        booking.requestedTime =
          null;

        booking.stage =
          "date";

        retry("We're closed that day. What other day would you like?");

        return;
      }

      say(
        "I'm sorry, I couldn't check availability right now. No appointment was booked. Please call the salon directly. Goodbye."
      );
    };

  const commit = async () => {
    if (
      !booking.customerName ||
      !booking.serviceId ||
      !booking.serviceName ||
      !booking.date ||
      !booking.time
    ) {
      say(
        "I couldn't verify all of the booking details. No appointment was booked. Please call again."
      );

      return;
    }

    const phone =
      normalizePhone(
        callerPhone
      );

    if (
      !PHONE.test(phone)
    ) {
      say(
        "I couldn't verify a callback phone number for this appointment. No appointment was booked."
      );

      return;
    }

    /*
     * AUTHORITATIVE MUTATION BOUNDARY
     *
     * Reached only after an explicit affirmative. The semantic model cannot
     * reach it, and the database revalidates everything including capacity.
     */
    const bookingStarted =
      Date.now();

    onMutation?.();
    const result =
      await executeVoiceBooking(
        {
          businessId:
            business.businessId,

          idempotencyKey:
            booking.idempotencyKey,

          customerName:
            booking.customerName,

          customerPhone:
            phone,

          serviceId:
            booking.serviceId,

          serviceName:
            booking.serviceName,

          date:
            booking.date,

          time:
            booking.time,
        }
      );

    console.info(
      `AnaAI voice booking completed duration_ms=${
        Date.now() -
        bookingStarted
      } result=${
        result.success
          ? result.replayed
            ? "replayed"
            : "success"
          : "rejected"
      }`
    );

    if (!result.success) {
      say(
        result.message
      );

      return;
    }

    const confirmed =
      result.replayed
        ? "Your original booking was already completed. No duplicate appointment was created."
        : "Your appointment has been booked.";

    const sms =
      result.smsSent
        ? " A confirmation text was submitted for sending."
        : " I couldn't verify the text confirmation status.";

    say(
      `${confirmed}${sms} Thanks for calling. Goodbye.`
    );
  };

  /*
   * 1. DTMF is unambiguous and is resolved before any speech interpretation.
   */
  if (digits) {
    if (
      booking.pendingTimeOptions &&
      (digits === "1" ||
        digits === "2")
    ) {
      const chosen =
        booking.pendingTimeOptions[
          digits === "1"
            ? 0
            : 1
        ];

      booking.pendingTimeOptions =
        undefined;

      booking.failures = 0;
      acceptVoiceProgress(state);

      applyBookingDetails(
        booking,
        {
          time: chosen,
        }
      );

      await checkAvailability();

      return;
    }

    if (
      booking.stage ===
        "confirm" &&
      booking.time
    ) {
      if (digits === "1") {
        await commit();
        return;
      }

      if (digits === "2") {
        say(
          "Okay. No appointment was booked. Thanks for calling. Goodbye."
        );

        return;
      }
    }
  }

  /*
   * 3. An explicit refusal ends the booking at any stage.
   */
  if (
    interpretConfirmation(
      speech
    ) === "no"
  ) {
    say(
      "Okay. No appointment was booked. Thanks for calling. Goodbye."
    );

    return;
  }

  /*
   * 4. A pending AM/PM clarification, answerable at ANY stage. A richer reply
   *    falls through so the caller can replace the time instead.
   */
  if (
    booking.pendingTimeOptions
  ) {
    const period =
      periodChoice(speech);

    if (period) {
      const chosen =
        booking.pendingTimeOptions[
          period === "am"
            ? 0
            : 1
        ];

      booking.pendingTimeOptions =
        undefined;

      booking.failures = 0;
      acceptVoiceProgress(state);

      applyBookingDetails(
        booking,
        {
          time: chosen,
        }
      );

      await checkAvailability();

      return;
    }
  }

  /*
   * 5. Deterministic extraction. Every utterance may contribute ANY field,
   *    regardless of which question was asked.
   */
  const detected =
    extractBookingDetails({
      speech,
      services,

      timezone:
        business.timezone,

      wantName:
        !booking.customerName,
    });

  const readyToBook =
    booking.stage ===
      "confirm" &&
    Boolean(booking.time);

  /*
   * 6. A plain affirmative at confirmation, with nothing else in the sentence,
   *    is booking authorization.
   */
  if (
    readyToBook &&
    !detected.any &&
    interpretConfirmation(
      speech
    ) === "yes"
  ) {
    if (lowConfidence) {
      retry(
        `I didn't hear that clearly enough to book it. I have ${summary()}. Say yes or press 1 to book it, or no to cancel.`
      );

      return;
    }

    await commit();
    return;
  }

  /*
   * 7. Ask the semantic layer only when determinism left something open. It
   *    supplements; it is never authority over any value.
   */
  const stage:
    | "name"
    | "service"
    | "date"
    | "time"
    | "confirm" =
    readyToBook
      ? "confirm"
      : missingBookingField(
            booking
          ) || "confirm";

  const deterministicTime =
    detected.time?.kind ===
    "valid"
      ? detected.time.value
      : null;

  const settled =
    Boolean(
      (booking.customerName ||
        detected.name) &&
        (booking.serviceId ||
          detected.service) &&
        (booking.date ||
          detected.date) &&
        (booking.requestedTime ||
          deterministicTime)
    ) &&
    detected.time?.kind !==
      "ambiguous";

  const understanding =
    readyToBook || !settled
      ? await understand({
          stage,
          speech,
          services,
        })
      : null;

  /*
   * 8. Merge. Deterministic values win; the model only fills gaps, and every
   *    model value still passes through the deterministic validators.
   */
  let mergedDate:
    | string
    | null = null;

  let dateRejected:
    | "past"
    | "invalid"
    | null = null;

  /*
   * Every date reaches the SAME validation regardless of whether it was read
   * deterministically or supplied by the model. A past day is never accepted.
   */
  const dateExpression =
    detected.date ||
    (!detected.date &&
    !detected.dateUnresolved
      ? understanding?.dateExpression ||
        null
      : null);

  if (dateExpression) {
    const parsed =
      validateDateExpression(
        dateExpression,
        business
      );

    if (parsed.valid) {
      mergedDate =
        parsed.date;
    } else {
      dateRejected =
        parsed.reason;
    }
  }

  let semanticTime:
    | TimeInterpretation
    | null = null;

  if (
    !detected.time &&
    understanding?.timeExpression
  ) {
    semanticTime =
      parseSpokenTime(
        understanding.timeExpression
      );
  }

  const semanticService =
    detected.service
      ? null
      : resolveService(
          services,
          understanding?.serviceName ||
            null
        );

  const chosenTime =
    detected.time ||
    semanticTime;

  const change =
    applyBookingDetails(
      booking,
      {
        name:
          detected.name ||
          (understanding?.customerName ??
            null),

        service:
          detected.service ||
          semanticService,

        date: mergedDate,

        time:
          chosenTime?.kind ===
          "valid"
            ? chosenTime.value
            : null,
      }
    );

  const understood =
    change.name ||
    change.service ||
    change.date ||
    change.time;

  if (understood) {
    booking.failures = 0;
    acceptVoiceProgress(state);

    if (
      !chosenTime ||
      chosenTime.kind !==
        "ambiguous"
    ) {
      booking.pendingTimeOptions =
        undefined;
    }
  }

  /*
   * 9. Genuine ambiguity gets a focused question rather than a guess.
   */
  if (
    detected.serviceCandidates
      .length > 1
  ) {
    /*
     * The caller is changing the service. Even though we cannot tell which one
     * yet, any previously confirmed availability is already stale.
     */
    booking.time = null;

    booking.stage =
      "service";

    retry(
      `I heard more than one service. Did you want ${detected.serviceCandidates
        .slice(0, 3)
        .map(
          (item) =>
            item.name
        )
        .join(" or ")}?`,
      serviceNames
    );

    return;
  }

  if (
    chosenTime?.kind ===
    "ambiguous"
  ) {
    /*
     * A replacement time we cannot resolve yet still invalidates the old one.
     * Leaving `time` set would let a later affirmative book a slot the caller
     * has already moved away from.
     */
    booking.time = null;
    booking.requestedTime = null;

    booking.stage = "time";

    state.recovery = recoveryBefore;
    if (recoverVoiceInput(state)) {
      say("I'm having trouble understanding. No appointment was booked. Please call the salon directly and someone can help. Goodbye.");
      return;
    }
    askAmPm(chosenTime.options);

    return;
  }

  if (dateRejected) {
    booking.stage = "date";

    retry(
      dateRejected === "past"
        ? "That day has already passed. What day would you like instead?"
        : "I couldn't work out that day. You can say tomorrow, a weekday, or a month and day."
    );

    return;
  }

  if (
    detected.dateUnresolved &&
    !change.date &&
    !booking.date
  ) {
    booking.stage = "date";

    retry(
      "I couldn't work out that day. You can say tomorrow, a weekday, or a month and day."
    );

    return;
  }

  /*
   * 10. Nothing usable. Report the specific reason where one is known.
   */
  if (!understood) {
    if (
      readyToBook &&
      understanding?.confirmation ===
        "no"
    ) {
      say(
        "Okay. No appointment was booked. Thanks for calling. Goodbye."
      );

      return;
    }

    /*
     * A turn that names ANY appointment detail is a correction, never booking
     * authorization -- including when the detail happens to repeat the current
     * value, and including when the semantic layer labels it confirmation.
     * The model must not be able to book by attaching "yes" to a restatement.
     */
    const mentionsDetail =
      detected.any ||
      Boolean(
        understanding?.customerName ||
          understanding?.serviceName ||
          understanding?.serviceUnresolved ||
          understanding?.dateExpression ||
          understanding?.timeExpression ||
          understanding?.correction
      );

    if (
      readyToBook &&
      !mentionsDetail &&
      understanding?.confirmation ===
        "yes"
    ) {
      if (lowConfidence) {
        retry(
          `I didn't hear that clearly enough to book it. I have ${summary()}. Say yes or press 1 to book it, or no to cancel.`
        );

        return;
      }

      await commit();
      return;
    }

    if (readyToBook) {
      retry(
        `I haven't booked anything yet. I have ${summary()}. Say yes or press 1 to book it, no to cancel, or tell me what to change.`
      );

      return;
    }

    /*
     * A focused, field-specific re-ask. Every one of these counts toward the
     * escalation limit, so a caller cannot be looped indefinitely.
     */
    const missing =
      missingBookingField(
        booking
      );

    /*
     * The utterance that opened the booking ("I'd like to book something")
     * carries no details by design. That is the start of the conversation, not
     * a failure to understand, so it must not count toward escalation.
     */
    if (opening) {
      booking.stage =
        missing as VoiceBookingStage;

      ask();

      return;
    }

    /*
     * An unresolved AM/PM question stays the active question. An affirmative
     * here answers nothing, and must never fall through to booking.
     */
    if (
      booking.pendingTimeOptions
    ) {
      booking.stage = "time";

      retry(
        `I still need to know which one. Did you mean ${spokenTime(
          booking.pendingTimeOptions[0]
        )} or ${spokenTime(
          booking.pendingTimeOptions[1]
        )}? Say AM or PM.`
      );

      return;
    }

    if (
      understanding?.serviceUnresolved ||
      missing === "service"
    ) {
      booking.stage =
        "service";

      retry(
        `I couldn't match that to a service. We offer ${serviceNames
          .slice(0, 6)
          .join(", ")}.`,
        serviceNames
      );

      return;
    }

    if (missing === "name") {
      booking.stage = "name";

      retry(
        "Sorry, I didn't catch the name. What name should I put on the appointment?"
      );

      return;
    }

    if (missing === "date") {
      booking.stage = "date";

      retry(
        "I couldn't work out that day. You can say tomorrow, a weekday, or a month and day."
      );

      return;
    }

    booking.stage = "time";

    retry(
      "I couldn't interpret that time. Please say a time such as 10 AM or 2:30 PM."
    );

    return;
  }

  /*
   * 11. Something was understood. Ask for what is still missing, otherwise
   *     recheck availability for the current combination.
   */
  if (
    missingBookingField(
      booking
    )
  ) {
    booking.stage =
      missingBookingField(
        booking
      ) as VoiceBookingStage;

    ask();

    return;
  }

  await checkAvailability();
}

async function buildVoiceResponseInternal({
  formData,
  mode,
  ingress,
  stateToken = "",
  diagnostics,
}: {
  formData: FormData;
  mode: string;
  ingress: VoiceIngress;
  stateToken?: string;
  diagnostics: VoiceDiagnostics;
}) {
  const requestStarted =
    Date.now();

  const called =
    formData.get("To");

  const business =
    await resolveBusinessByCalledNumber(
      typeof called ===
        "string"
        ? called
        : ""
    );

  const response =
    new twilio.twiml.VoiceResponse();

  if (!business) {
    diagnostics.reason = "business_unresolved";
    console.warn(
      "AnaAI voice request did not resolve to an active business."
    );

    response.say(
      voiceOptions(),
      "I'm sorry, AnaAI could not identify the business for this phone number."
    );

    response.hangup();

    return response.toString();
  }

  const read = (
    key: string
  ) => {
    const value =
      formData.get(key);

    return typeof value ===
      "string"
      ? value.trim()
      : "";
  };

  const binding: VoiceBinding = {
    businessId:
      business.businessId,

    callSid:
      read("CallSid"),

    ingress,
  };

  let state:
    | VoiceState
    | null = null;

  diagnostics.call = voiceDiagnosticId(binding);
  diagnostics.callback = voiceDiagnosticId(binding, stateToken || `stateless:${mode}`);
  if (stateToken) {
    try {
      state =
        openVoiceState(
          stateToken,
          binding
        );
    } catch {
      diagnostics.reason = "invalid_or_expired_state";
      response.say(
        voiceOptions(),
        "This conversation has expired. No appointment was changed. Please call again. Goodbye."
      );

      response.hangup();

      return response.toString();
    }
  } else if (voiceStateConfigured() && /^(?:listen|retry|recovery-[12]-[01])$/.test(mode)) {
    // A continuation cannot silently acquire a new lifetime/recovery budget.
    diagnostics.reason = "missing_callback_state";
    response.say(voiceOptions(), "I couldn't verify this conversation. No appointment was changed. Please call again. Goodbye.");
    response.hangup();
    return response.toString();
  } else if (
    voiceStateConfigured() &&
    /^CA[0-9a-f]{32}$/i.test(
      binding.callSid
    )
  ) {
    state =
      initialVoiceState();
  }

  diagnostics.state = state;
  diagnostics.before = stateSnapshot(state);
  if (state) {
    state.turns++;
  }

  if (
    state &&
    (state.turns >= 30 ||
      state.expires <=
        Date.now())
  ) {
    response.say(
      voiceOptions(),
      "This conversation has ended. Please call again if you need help. Goodbye."
    );

    response.hangup();

    return response.toString();
  }

  const speech =
    read("SpeechResult");

  const digits =
    read("Digits");

  const callerPhone =
    read("From");

  const input = classifyVoiceInput(speech, digits, recognitionConfidence(formData));
  const recovery = state || statelessVoiceRecovery(mode);
  diagnostics.recovery = recovery;
  if (!state) diagnostics.before = { ...diagnostics.before, recovery: recovery.recovery || 0, empty_count: recovery.silence };
  const initial = !mode && !stateToken && !speech && !digits;
  const recover = (reason: string, empty = false, prompt?: string) => {
    diagnostics.reason = reason;
    if (recoverVoiceInput(recovery, empty)) {
      response.say(voiceOptions(), state?.mode === "booking"
        ? "I couldn't hear you clearly. No appointment was booked. Please call again when you're ready. Goodbye."
        : state?.mode === "management"
          ? "I couldn't hear you clearly. Your appointment has not been changed. Please call again or contact the business. Goodbye."
          : "I couldn't hear you clearly. Please call again when you're ready. Goodbye.");
      response.hangup();
    } else {
      gather(response, ingress, binding, prompt || recoveryPrompt(state, empty, business.timezone), state,
        state ? (empty && (state.mode === "menu" || state.mode === "info") ? "retry" : "listen")
          : voiceRecoveryMode(recovery));
    }
  };
  if (!initial && (input.kind !== "speech" && input.kind !== "dtmf" ||
      input.kind === "dtmf" && !voiceDigitAllowed(state, digits))) {
    recover(input.kind === "dtmf" ? "invalid_digit_for_stage" : input.reason, input.kind === "empty",
      input.kind === "dtmf" && (!state || state.mode === "menu" || state.mode === "info")
        ? "That option isn't available. Speak naturally, or press 0 to hear the options." : undefined);
    return response.toString();
  }

  /*
   * Human handoff requests are authoritative conversation control,
   * not booking details. Intercept them before booking dispatch so
   * an explicit request can never submit an in-progress appointment.
   *
   * Transfer uses only the validated, server-side private handoff
   * destination for the authoritatively resolved business.
   */
  if (
    speech &&
    wantsHuman(
      speech
    )
  ) {
    const transferred =
      await transferToHuman({
        response,
        businessId:
          business.businessId,
        inboundPhone:
          typeof called ===
          "string"
            ? called
            : "",
      });

    if (!transferred) {
      recover("transfer_unavailable", false, TRANSFER_UNAVAILABLE);
    } else {
      acceptVoiceProgress(recovery);
    }

    console.info(
      `AnaAI voice request completed flow=human-request duration_ms=${
        Date.now() -
        requestStarted
      }`
    );

    return response.toString();
  }

    const intent = managementIntent(
      speech,
      state?.mode === "booking"
    );

  if (
    state?.mode === "management" ||
    (intent && state)
  ) {
    const openingManagement =
      state!.mode !== "management";

    const managementState =
      state!.mode === "management"
        ? state!
        : initialManagementState(
            state!,
            intent!
          );

    /*
     * Recognizing a valid appointment-management intent is real
     * conversational progress. Recovery accumulated in the menu or
     * information flow must not be inherited by the newly entered
     * management flow.
     *
     * Once management has started, unresolved target/time/availability
     * turns still consume its normal bounded recovery budget.
     */
    if (openingManagement) {
      acceptVoiceProgress(
        managementState
      );
    }

    diagnostics.state =
      managementState;

    const result =
      await voiceManagementTurn({
        state:
          managementState,

        businessId:
          business.businessId,

        callerPhone,

        timezone:
          business.timezone,

        speech,
        digits,

        confidence:
          recognitionConfidence(
            formData
          ),

        opening:
          openingManagement,

        onMutation: () => {
          diagnostics.operation =
            "appointment_mutation";
        },
      });

    if (result.done) {
      response.say(
        voiceOptions(),
        result.message
      );

      response.hangup();
    } else {
      gather(
        response,
        ingress,
        binding,
        result.message,
        managementState
      );
    }

    return response.toString();
  }

  if (
    state?.mode ===
    "booking"
  ) {
    const confidence =
      recognitionConfidence(
        formData
      );

    logRecognition({
      stage:
        state.booking.stage,
      speech,
      confidence,
    });

    await bookingTurn({
      response,
      ingress,
      binding,
      business,
      state,
      speech,
      digits,
      confidence,
      callerPhone,
      onMutation: () => { diagnostics.operation = "appointment_mutation"; },
    });

    console.info(
      `AnaAI voice request completed flow=booking stage=${state.booking.stage} duration_ms=${
        Date.now() -
        requestStarted
      }`
    );

    return response.toString();
  }

  const listen = (
    message: string,
    nextMode = "listen"
  ) =>
    gather(
      response,
      ingress,
      binding,
      message,
      state,
      !state && recovery.recovery ? voiceRecoveryMode(recovery) : nextMode
    );

  const goodbye =
    /^(goodbye|bye|bye bye|end (the )?call|hang up|that['’]?s all|no thanks|no thank you|thank you goodbye)[.!?, ]*$/i.test(
      speech
    );

  if (goodbye) {
    response.say(
      voiceOptions(),
      "Thanks for calling. Goodbye!"
    );

    response.hangup();
  } else if (
    !mode &&
    !stateToken &&
    !speech &&
    !digits
  ) {
    listen(
      mainMenu(
        business.businessName
      )
    );
  } else {
    if (
      digits === "0" ||
      /^(?:please )?(?:repeat(?: the)? (?:menu|options)|main menu|start over)[.!?, ]*$/i.test(
        speech
      )
    ) {
      acceptVoiceProgress(recovery);
      if (state) {
        state.mode =
          "menu";
      }

      listen(
        mainMenu(
          business.businessName
        )
      );
    } else if (
      digits === "1" ||
      BOOKING_INTENT.test(
        speech
      )
    ) {
      if (!state) {
        recover("booking_unavailable", false, BOOKING_STATE_UNAVAILABLE);
        return response.toString();
      }
      acceptVoiceProgress(recovery);
      await beginBooking({
        response,
        ingress,
        binding,
        business,
        speech,

        confidence:
          recognitionConfidence(
            formData
          ),

        callerPhone,
        previousState: state,
      });
    } else if (
      digits === "2"
    ) {
      acceptVoiceProgress(recovery);
      if (state) {
        state.mode =
          "info";
      }

      listen(
        INFO_PROMPT
      );
    } else if (
      digits === "3" ||
      wantsHuman(
        speech
      )
    ) {
      const transferred =
        await transferToHuman({
          response,
          businessId:
            business.businessId,
          inboundPhone:
            typeof called ===
            "string"
              ? called
              : "",
        });

      if (!transferred) {
        recover("transfer_unavailable", false, TRANSFER_UNAVAILABLE);
      } else {
        acceptVoiceProgress(recovery);
      }
    } else if (
      digits
    ) {
      recover("invalid_digit_for_stage");
    } else {
      let answered = false;
      const answer =
        await answerVoiceQuestion(
          business.businessId,
          business.businessName,
          speech,
          business.timezone,
          () => { answered = true; }
        );
      if (answered) {
        acceptVoiceProgress(recovery);
        if (state) state.mode = "info";
        diagnostics.outcome = "answer";
        listen(`${answer} What else would you like to know?`);
      } else {
        recover("unresolved_question", false, answer);
      }
    }
  }

  console.info(
    `AnaAI voice request completed flow=${
      state?.mode || "menu"
    } duration_ms=${
      Date.now() -
      requestStarted
    }`
  );

  return response.toString();
}
function stateSnapshot(state: VoiceState | null) {
  return { flow: state?.mode || "menu", stage: state?.mode === "booking" ? state.booking.stage :
    state?.mode === "management" ? state.management.stage : "none",
    turns: state?.turns || 0, recovery: state?.recovery || 0, empty_count: state?.silence || 0 };
}

type VoiceDiagnostics = {
  state: VoiceState | null;
  before: ReturnType<typeof stateSnapshot>;
  call: string | null;
  callback: string | null;
  reason: string;
  outcome?: string;
  operation?: string;
  recovery?: VoiceRecovery;
};

/** One completion event, including exceptions and every early return. */
export async function buildVoiceResponse(args: {
  formData: FormData; mode: string; ingress: VoiceIngress; stateToken?: string;
}): Promise<string> {
  const started = Date.now();
  const read = (key: string) => {
    const value = args.formData.get(key);
    return typeof value === "string" ? value.trim() : "";
  };
  const speech = read("SpeechResult");
  const digits = read("Digits");
  const confidence = recognitionConfidence(args.formData);
  const input = classifyVoiceInput(speech, digits, confidence);
  const diagnostics: VoiceDiagnostics = { state: null, before: stateSnapshot(null),
    call: null, callback: null, reason: input.reason };
  let xml = "";
  try {
    xml = await buildVoiceResponseInternal({ ...args, diagnostics });
    return xml;
  } finally {
    const next = stateSnapshot(diagnostics.state);
    if (!diagnostics.state && diagnostics.recovery) {
      next.recovery = diagnostics.recovery.recovery || 0;
      next.empty_count = diagnostics.recovery.silence;
    }
    if (diagnostics.reason === "candidate_speech" && next.recovery > diagnostics.before.recovery) {
      diagnostics.reason = `unresolved_${next.flow}`;
    }
    const outcome = !xml ? "error" : /<Hangup/.test(xml) ? "hangup" : /<Dial/.test(xml) ? "transfer" :
      diagnostics.outcome || (next.flow !== diagnostics.before.flow || next.stage !== diagnostics.before.stage ? "transition" : "reprompt");
    console.info("AnaAI voice turn", {
      call: diagnostics.call, callback: diagnostics.callback, ingress: args.ingress,
      incoming_mode: /^(?:listen|retry|recovery-[12]-[01])$/.test(args.mode) ? args.mode : args.mode ? "unknown" : "initial",
      state_present: Boolean(args.stateToken), before: diagnostics.before, after: next,
      speech_field_present: args.formData.has("SpeechResult"),
      speech_length: !speech ? "empty" : speech.length <= 20 ? "short" : speech.length <= 80 ? "medium" : "long",
      digits_present: Boolean(digits), confidence, classification: input.kind,
      reason: diagnostics.reason, outcome, operation: diagnostics.operation || "none", duration_ms: Date.now() - started,
      ...(/<Gather/.test(xml) ? { gather: {
        input: "speech dtmf", num_digits: 1, timeout: 6, speech_timeout: 2,
        action_on_empty_result: true, method: "POST", language: "en-US",
        speech_model: "experimental_conversations",
      } } : {}),
    });
  }
}
