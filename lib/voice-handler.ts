import "server-only";

import twilio from "twilio";

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
  type VoiceBinding,
  type VoiceBookingState,
  type VoiceState,
} from "@/lib/voice-state";

import {
  bookingDate,
  businessLocalDate,
  parseSpokenTime,
  confirmation as interpretConfirmation,
  matchVoiceService,
} from "@/lib/voice-parsing";

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

type AvailabilityResult = Awaited<
  ReturnType<typeof checkVoiceAvailability>
>;

const INFO_PROMPT =
  "What would you like to know about our services, hours, or location?";

const TRANSFER_UNAVAILABLE =
  "I'm sorry, transferring to a team member isn't available right now. I can still help with business information.";

const HUMAN_REQUEST =
  /\b(?:transfer(?: me)?(?: to| with)?(?: someone| somebody| a person| a human| a representative| an agent| a team member| someone at the (?:salon|store))?|representative|agent|human|real person|team member|store employee|someone at the (?:salon|store)|connect me (?:to|with) (?:someone|somebody|a person|a human|a representative|an agent|a team member|someone at the (?:salon|store))|(?:speak|talk) (?:with|to) (?:someone|somebody|a person|a human|a representative|an agent|a team member|someone at the (?:salon|store)))\b/i;

function wantsHuman(
  speech: string
) {
  return HUMAN_REQUEST.test(
    speech
  );
}

const BOOKING_STATE_UNAVAILABLE =
  "I'm sorry, phone booking is temporarily unavailable. I can still help with business information.";

const BOOKING_INTENT =
  /\b(?:book|booking|schedule|reserve)\b/i;

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
          : undefined,
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

function bookingSummary(
  state: VoiceBookingState
) {
  return `${state.booking.serviceName} on ${state.booking.date} at ${spokenTime(
    state.booking.time || ""
  )}`;
}

function beginBooking(
  response:
    twilio.twiml.VoiceResponse,
  ingress: VoiceIngress,
  binding: VoiceBinding
) {
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

  const state =
    initialBookingState();

  state.turns = 1;

  gather(
    response,
    ingress,
    binding,
    "I can help book an appointment. What name should I put on the appointment?",
    state
  );
}

function recognitionConfidence(
  formData: FormData
) {
  const raw =
    formData.get(
      "Confidence"
    );

  if (
    typeof raw !==
    "string" ||
    !raw.trim()
  ) {
    return "missing";
  }

  const value =
    Number(raw);

  if (
    !Number.isFinite(
      value
    ) ||
    value < 0 ||
    value > 1
  ) {
    return "invalid";
  }

  if (value < 0.35) {
    return "low";
  }

  if (value < 0.7) {
    return "medium";
  }

  return "high";
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

function validateTimeExpression(
  expression: string
) {
  return parseSpokenTime(
    expression
  );
}

async function availabilityForState(
  business: BusinessContext,
  state: VoiceBookingState,
  time: string
): Promise<AvailabilityResult | null> {
  if (
    !state.booking
      .serviceId ||
    !state.booking.date
  ) {
    return null;
  }

  const started =
    Date.now();

  const result =
    await checkVoiceAvailability({
      businessId:
        business.businessId,

      serviceId:
        state.booking
          .serviceId,

      date:
        state.booking.date,

      time,
    });

  console.info(
    `AnaAI voice availability completed duration_ms=${
      Date.now() -
      started
    } result=${
      result.available
        ? "available"
        : result.reason
    }`
  );

  return result;
}

function resetAfterServiceChange(
  state: VoiceBookingState
) {
  state.booking.date =
    null;

  state.booking.time =
    null;

  state.booking.pendingTimeOptions =
    undefined;
}

function resetAfterDateChange(
  state: VoiceBookingState
) {
  state.booking.time =
    null;

  state.booking.pendingTimeOptions =
    undefined;
}

async function bookingTurn({
  response,
  ingress,
  binding,
  business,
  state,
  speech,
  callerPhone,
}: {
  response:
    twilio.twiml.VoiceResponse;
  ingress: VoiceIngress;
  binding: VoiceBinding;
  business: BusinessContext;
  state: VoiceBookingState;
  speech: string;
  callerPhone: string;
}) {
  if (!speech) {
    if (
      state.silence >= 1
    ) {
      response.say(
        voiceOptions(),
        "I couldn't hear you clearly. No appointment was booked. Please call again when you're ready. Goodbye."
      );

      response.hangup();
      return;
    }

    state.silence = 1;

    const prompt =
      state.booking.stage ===
      "name"
        ? "I didn't hear the name. What name should I put on the appointment?"
        : state.booking.stage ===
            "service"
          ? "I didn't hear the service clearly. Which service would you like?"
          : state.booking.stage ===
              "date"
            ? "I didn't hear the date clearly. You can say something like October second, tomorrow, or next Friday."
            : state.booking.stage ===
                "time"
              ? "I didn't hear the time clearly. Please say a time such as 10 AM or 2:30 PM."
              : `I didn't hear your answer clearly. ${bookingSummary(
                  state
                )}. Say yes to book it, no to cancel, or tell me what you want to change.`;

    gather(
      response,
      ingress,
      binding,
      prompt,
      state
    );

    return;
  }

  state.silence = 0;

  if (
    interpretConfirmation(
      speech
    ) === "no"
  ) {
    response.say(
      voiceOptions(),
      "Okay. No appointment was booked. Thanks for calling. Goodbye."
    );

    response.hangup();
    return;
  }

  const retry = (
    message: string,
    names: string[] = []
  ) => {
    state.booking.failures =
      (state.booking.failures ||
        0) + 1;

    if (
      state.booking.failures >=
      3
    ) {
      response.say(
        voiceOptions(),
        "I'm having trouble understanding. No appointment was booked. A team-member transfer isn't configured yet. Please contact someone at the salon for help. Goodbye."
      );

      response.hangup();
    } else {
      gather(
        response,
        ingress,
        binding,
        message,
        state,
        "listen",
        names
      );
    }
  };

  const askForDate = (
    serviceName: string
  ) => {
    state.booking.stage =
      "date";

    gather(
      response,
      ingress,
      binding,
      `What date would you like for ${serviceName}? You can say tomorrow, a month and day, or a weekday such as next Friday.`,
      state
    );
  };

  const askForTime = () => {
    state.booking.stage =
      "time";

    gather(
      response,
      ingress,
      binding,
      "What time would you like? For example, say 10 AM or 2:30 PM.",
      state
    );
  };

  const handleAvailability = async (
    time: string
  ) => {
    const availability =
      await availabilityForState(
        business,
        state,
        time
      );

    if (!availability) {
      response.say(
        voiceOptions(),
        "I couldn't verify all of the booking details. No appointment was booked. Please call again."
      );

      response.hangup();

      return false;
    }

    if (
      !availability.available
    ) {
      state.booking.time =
        null;

      if (
        availability.reason ===
        "slot_unavailable"
      ) {
        retry(
          "That time is not available. Please choose another time."
        );

        return false;
      }

      if (
        availability.reason ===
        "outside_hours"
      ) {
        retry(
          "That time is outside the business hours for that day. Please choose another time."
        );

        return false;
      }

      if (
        availability.reason ===
        "closed"
      ) {
        state.booking.failures =
          0;

        state.booking.date =
          null;

        state.booking.stage =
          "date";

        gather(
          response,
          ingress,
          binding,
          "The business is closed on that date. Please choose another date.",
          state
        );

        return false;
      }

      response.say(
        voiceOptions(),
        "I'm sorry, I couldn't verify appointment availability right now. No appointment was booked. Please contact the business for help. Goodbye."
      );

      response.hangup();

      return false;
    }

    state.booking.failures =
      0;

    state.booking.time =
      time;

    state.booking.stage =
      "confirm";

    gather(
      response,
      ingress,
      binding,
      `I have ${bookingSummary(
        state
      )}. Say yes to book this appointment, no to cancel, or tell me what you'd like to change.`,
      state
    );

    return true;
  };

  if (
    state.booking.stage ===
      "confirm" &&
    state.booking
      .pendingTimeOptions
  ) {
    const period =
      speech
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[.\s]/g, "");

    if (
      period === "am" ||
      period === "pm"
    ) {
      const options =
        state.booking
          .pendingTimeOptions;

      const selectedTime =
        period === "am"
          ? options[0]
          : options[1];

      state.booking.pendingTimeOptions =
        undefined;

      state.booking.time =
        null;

      await handleAvailability(
        selectedTime
      );

      return;
    }

    retry(
      "I still need to know whether you mean AM or PM. Please say AM or PM."
    );

    return;
  }

  if (
    state.booking.stage ===
    "name"
  ) {
    const name =
      speech
        .replace(
          /\s+/g,
          " "
        )
        .trim();

    if (
      name.length < 2 ||
      name.length > 120 ||
      /[<>\x00-\x1f]/.test(
        name
      )
    ) {
      retry(
        "I couldn't use that name. Please say the name for the appointment."
      );

      return;
    }

    state.booking.failures =
      0;

    state.booking.customerName =
      name;

    state.booking.stage =
      "service";

    const services =
      await loadVoiceServices(
        business.businessId
      );

    if (
      !services.length
    ) {
      response.say(
        voiceOptions(),
        "I'm sorry, I can't find any services available for phone booking right now. No appointment was booked."
      );

      response.hangup();
      return;
    }

    const names =
      services
        .slice(0, 6)
        .map(
          (service) =>
            service.name
        )
        .join(", ");

    gather(
      response,
      ingress,
      binding,
      `Which service would you like? Available services include ${names}. You can also tell me the date and time in the same sentence.`,
      state,
      "listen",
      services.map(
        (service) =>
          service.name
      )
    );

    return;
  }

  if (
    state.booking.stage ===
    "service"
  ) {
    const services =
      await loadVoiceServices(
        business.businessId
      );

    if (
      !services.length
    ) {
      response.say(
        voiceOptions(),
        "I'm sorry, I can't find any services available for phone booking right now. No appointment was booked."
      );

      response.hangup();

      return;
    }

    const deterministic =
      matchVoiceService(
        services,
        speech
      );

    const understanding =
      await understand({
        stage: "service",
        speech,
        services,
      });

    const semanticService =
      resolveService(
        services,
        understanding
          .serviceName
      );

    const service =
      deterministic.match ||
      semanticService;

    if (!service) {
      const choices =
        (
          deterministic.candidates
            .length
            ? deterministic.candidates
            : services
        )
          .slice(0, 3)
          .map(
            (item) =>
              item.name
          )
          .join(", ");

      retry(
        deterministic
          .candidates
          .length > 1
          ? `Which service did you mean: ${choices}?`
          : `I couldn't match that service. ${
              choices
                ? `Available options include ${choices}.`
                : "Please contact the business for services."
            }`,
        services.map(
          (item) =>
            item.name
        )
      );

      return;
    }

    state.booking.failures =
      0;

    state.booking.serviceId =
      service.id;

    state.booking.serviceName =
      service.name;

    resetAfterServiceChange(
      state
    );

    if (
      understanding
        ?.dateExpression
    ) {
      const parsedDate =
        validateDateExpression(
          understanding
            .dateExpression,
          business
        );

      if (
        !parsedDate.valid
      ) {
        state.booking.stage =
          "date";

        retry(
          parsedDate.reason ===
            "past"
            ? `I understood ${service.name}, but that date has already passed. Please choose another date.`
            : `I understood ${service.name}, but I couldn't verify the date. Please say the date again.`
        );

        return;
      }

      state.booking.date =
        parsedDate.date;
    }

    if (
      understanding
        ?.timeExpression &&
      state.booking.date
    ) {
      const parsedTime =
        validateTimeExpression(
          understanding
            .timeExpression
        );

      if (
        parsedTime.kind ===
        "valid"
      ) {
        await handleAvailability(
          parsedTime.value
        );

        return;
      }

      state.booking.stage =
        "time";

      retry(
        parsedTime.kind ===
          "ambiguous"
          ? `I understood ${service.name} and the date, but I need AM or PM for the time. Did you mean ${spokenTime(
              parsedTime.options[0]
            )} or ${spokenTime(
              parsedTime.options[1]
            )}?`
          : `I understood ${service.name} and the date, but I couldn't verify the time. Please say the time again.`
      );

      return;
    }

    if (
      state.booking.date
    ) {
      askForTime();
      return;
    }

    askForDate(
      service.name
    );

    return;
  }

  if (
    state.booking.stage ===
    "date"
  ) {
    let date =
      bookingDate(
        speech,
        business.timezone
      );

    let understanding:
      | VoiceTurnUnderstanding
      | null = null;

    if (!date) {
      understanding =
        await understand({
          stage: "date",
          speech,
        });

      if (
        understanding
          .dateExpression
      ) {
        const parsedDate =
          validateDateExpression(
            understanding
              .dateExpression,
            business
          );

        if (
          parsedDate.valid
        ) {
          date =
            parsedDate.date;
        } else if (
          parsedDate.reason ===
          "past"
        ) {
          retry(
            "That date has already passed. Please choose another date."
          );

          return;
        }
      }
    }

    if (!date) {
      retry(
        "I couldn't verify that date. Please say the month and day, or a date such as next Friday."
      );

      return;
    }

    const today =
      businessLocalDate(
        business.timezone
      );

    if (
      today &&
      date < today
    ) {
      retry(
        "That date has already passed. Please choose another date."
      );

      return;
    }

    state.booking.failures =
      0;

    state.booking.date =
      date;

    resetAfterDateChange(
      state
    );

    if (
      understanding
        ?.timeExpression
    ) {
      const parsedTime =
        validateTimeExpression(
          understanding
            .timeExpression
        );

      if (
        parsedTime.kind ===
        "valid"
      ) {
        await handleAvailability(
          parsedTime.value
        );

        return;
      }

      state.booking.stage =
        "time";

      retry(
        parsedTime.kind ===
          "ambiguous"
          ? `I have the date. For the time, did you mean ${spokenTime(
              parsedTime.options[0]
            )} or ${spokenTime(
              parsedTime.options[1]
            )}? Please say AM or PM.`
          : "I have the date, but I couldn't verify the time. Please say the time again."
      );

      return;
    }

    askForTime();

    return;
  }

  if (
    state.booking.stage ===
    "time"
  ) {
    let parsed =
      parseSpokenTime(
        speech
      );

    let understanding:
      | VoiceTurnUnderstanding
      | null = null;

    if (
      parsed.kind ===
      "invalid"
    ) {
      understanding =
        await understand({
          stage: "time",
          speech,
        });

      if (
        understanding
          .timeExpression
      ) {
        parsed =
          parseSpokenTime(
            understanding
              .timeExpression
          );
      }
    }

    if (
      parsed.kind !==
      "valid"
    ) {
      retry(
        parsed.kind ===
          "ambiguous"
          ? `Did you mean ${spokenTime(
              parsed.options[0]
            )} or ${spokenTime(
              parsed.options[1]
            )}? Please say the full time with AM or PM.`
          : "I couldn't interpret that time. Please say a valid time such as one PM or two thirty PM."
      );

      return;
    }

    await handleAvailability(
      parsed.value
    );

    return;
  }

  let confirmation =
    interpretConfirmation(
      speech
    );

  if (
    confirmation === "yes"
  ) {
    /*
     * Continue to the authoritative mutation boundary.
     */
  } else {
    const services =
      await loadVoiceServices(
        business.businessId
      );

    const understanding =
      await understand({
        stage: "confirm",
        speech,
        services,
      });

    if (
      understanding.correction
    ) {
      if (
        understanding
          .serviceName
      ) {
        const service =
          resolveService(
            services,
            understanding
              .serviceName
          );

        if (!service) {
          retry(
            "I understood that you want to change the service, but I couldn't verify which service you meant."
          );

          return;
        }

        state.booking.serviceId =
          service.id;

        state.booking.serviceName =
          service.name;

        resetAfterServiceChange(
          state
        );

        state.booking.failures =
          0;

        if (
          understanding
            .dateExpression
        ) {
          const parsedDate =
            validateDateExpression(
              understanding
                .dateExpression,
              business
            );

          if (
            parsedDate.valid
          ) {
            state.booking.date =
              parsedDate.date;
          }
        }

        if (
          state.booking.date &&
          understanding
            .timeExpression
        ) {
          const parsedTime =
            validateTimeExpression(
              understanding
                .timeExpression
            );

          if (
            parsedTime.kind ===
            "valid"
          ) {
            await handleAvailability(
              parsedTime.value
            );

            return;
          }
        }

        if (
          state.booking.date
        ) {
          askForTime();
        } else {
          askForDate(
            service.name
          );
        }

        return;
      }

      if (
        understanding
          .dateExpression
      ) {
        const parsedDate =
          validateDateExpression(
            understanding
              .dateExpression,
            business
          );

        if (
          !parsedDate.valid
        ) {
          state.booking.stage =
            "date";

          retry(
            parsedDate.reason ===
              "past"
              ? "That new date has already passed. Please choose another date."
              : "I understood that you want to change the date, but I couldn't verify the new date."
          );

          return;
        }

        state.booking.date =
          parsedDate.date;

        resetAfterDateChange(
          state
        );

        state.booking.failures =
          0;

        if (
          understanding
            .timeExpression
        ) {
          const parsedTime =
            validateTimeExpression(
              understanding
                .timeExpression
            );

          if (
            parsedTime.kind ===
            "valid"
          ) {
            await handleAvailability(
              parsedTime.value
            );

            return;
          }
        }

        askForTime();

        return;
      }

      if (
        understanding
          .timeExpression
      ) {
        const parsedTime =
          validateTimeExpression(
            understanding
              .timeExpression
          );

        if (
          parsedTime.kind !==
          "valid"
        ) {
          if (
            parsedTime.kind ===
            "ambiguous"
          ) {
            state.booking.pendingTimeOptions =
              parsedTime.options;

            state.booking.failures =
              0;

            retry(
              `I understand you want to change the time. Did you mean ${spokenTime(
                parsedTime.options[0]
              )} or ${spokenTime(
                parsedTime.options[1]
              )}? Please say AM or PM.`
            );

            return;
          }

          retry(
            "I understand you want to change the time, but I couldn't verify the new time."
          );

          return;
        }

        state.booking.pendingTimeOptions =
          undefined;

        state.booking.time =
          null;

        await handleAvailability(
          parsedTime.value
        );

        return;
      }

      retry(
        `I understand you want to change something. You can tell me the service, date, or time you'd like instead. I currently have ${bookingSummary(
          state
        )}.`
      );

      return;
    }

    if (
      understanding
        .confirmation ===
        "no"
    ) {
      response.say(
        voiceOptions(),
        "Okay. No appointment was booked. Thanks for calling. Goodbye."
      );

      response.hangup();

      return;
    }

    if (
      understanding
        .confirmation ===
        "yes" &&
      !understanding
        .correction &&
      !understanding
        .serviceName &&
      !understanding
        .dateExpression &&
      !understanding
        .timeExpression
    ) {
      confirmation =
        "yes";
    } else {
      retry(
        understanding
          .meaningful
          ? `I haven't booked it yet. I have ${bookingSummary(
              state
            )}. Say yes to book it, no to cancel, or tell me what you'd like to change.`
          : `I couldn't understand that clearly enough to book anything. I have ${bookingSummary(
              state
            )}. Say yes to book it, no to cancel, or tell me what you'd like to change.`
      );

      return;
    }
  }

  if (
    confirmation !== "yes"
  ) {
    retry(
      `Please say yes to book ${bookingSummary(
        state
      )}, or no to cancel.`
    );

    return;
  }

  const booking =
    state.booking;

  if (
    !booking.customerName ||
    !booking.serviceId ||
    !booking.serviceName ||
    !booking.date ||
    !booking.time
  ) {
    response.say(
      voiceOptions(),
      "I couldn't verify all of the booking details. No appointment was booked. Please call again."
    );

    response.hangup();
    return;
  }

  const phone =
    normalizePhone(
      callerPhone
    );

  if (
    !PHONE.test(phone)
  ) {
    response.say(
      voiceOptions(),
      "I couldn't verify a callback phone number for this appointment. No appointment was booked."
    );

    response.hangup();
    return;
  }

  /*
   * AUTHORITATIVE MUTATION BOUNDARY
   *
   * The semantic model cannot reach the booking RPC
   * without explicit confirmation above.
   *
   * The database remains authoritative and revalidates
   * the booking.
   */
  const bookingStarted =
    Date.now();

  const result =
    await executeVoiceBooking({
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
    });

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
    response.say(
      voiceOptions(),
      result.message
    );

    response.hangup();
    return;
  }

  const bookingConfirmation =
    result.replayed
      ? "Your original booking was already completed. No duplicate appointment was created."
      : "Your appointment has been booked successfully.";

  const sms =
    result.smsSent
      ? " A confirmation text was submitted for sending."
      : " I couldn't verify the text confirmation status.";

  response.say(
    voiceOptions(),
    `${bookingConfirmation}${sms} Thanks for calling. Goodbye.`
  );

  response.hangup();
}

export async function buildVoiceResponse({
  formData,
  mode,
  ingress,
  stateToken = "",
}: {
  formData: FormData;
  mode: string;
  ingress: VoiceIngress;
  stateToken?: string;
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

  if (stateToken) {
    try {
      state =
        openVoiceState(
          stateToken,
          binding
        );
    } catch {
      response.say(
        voiceOptions(),
        "This conversation has expired. No appointment was changed. Please call again. Goodbye."
      );

      response.hangup();

      return response.toString();
    }
  } else if (
    voiceStateConfigured() &&
    /^CA[0-9a-f]{32}$/i.test(
      binding.callSid
    )
  ) {
    state =
      initialVoiceState();
  }

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

  /*
   * Privacy-safe ASR observability.
   *
   * We deliberately do NOT log:
   * - transcript contents
   * - exact transcript length
   * - caller phone
   * - CallSid
   * - business/customer/appointment IDs
   * - state token
   * - Twilio signatures
   */

  /*
   * Human handoff requests are authoritative conversation control,
   * not booking details. Intercept them before booking dispatch so
   * an explicit request can never submit an in-progress appointment.
   *
   * Actual transfer remains disabled until a validated, server-side
   * private handoff destination is configured.
   */
  if (
    speech &&
    wantsHuman(
      speech
    )
  ) {
    gather(
      response,
      ingress,
      binding,
      TRANSFER_UNAVAILABLE,
      state,
      "listen"
    );

    console.info(
      `AnaAI voice request completed flow=human-request duration_ms=${
        Date.now() -
        requestStarted
      }`
    );

    return response.toString();
  }

  if (
    state?.mode ===
    "booking"
  ) {
    logRecognition({
      stage:
        state.booking.stage,
      speech,
      confidence:
        recognitionConfidence(
          formData
        ),
    });

    await bookingTurn({
      response,
      ingress,
      binding,
      business,
      state,
      speech,
      callerPhone,
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
      nextMode
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
  } else if (
    !speech &&
    !digits
  ) {
    if (
      (
        state?.silence ??
        (mode === "retry"
          ? 1
          : 0)
      ) >= 1
    ) {
      response.say(
        voiceOptions(),
        "I couldn't hear you. Please call again when you're ready. Goodbye."
      );

      response.hangup();
    } else {
      if (state) {
        state.silence = 1;
      }

      listen(
        `I didn't hear anything. ${
          state?.mode ===
          "info"
            ? INFO_PROMPT
            : "Speak naturally, or press 0 to hear the options."
        }`,
        "retry"
      );
    }
  } else {
    if (state) {
      state.silence = 0;
    }

    if (
      digits === "0" ||
      /^(?:please )?(?:repeat(?: the)? (?:menu|options)|main menu|start over)[.!?, ]*$/i.test(
        speech
      )
    ) {
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
      beginBooking(
        response,
        ingress,
        binding
      );
    } else if (
      digits === "2"
    ) {
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
      listen(
        TRANSFER_UNAVAILABLE
      );
    } else if (
      digits
    ) {
      listen(
        `That option isn't available. ${mainMenu(
          business.businessName
        )}`
      );
    } else {
      if (state) {
        state.mode =
          "info";
      }

      const answer =
        await answerVoiceQuestion(
          business.businessId,
          business.businessName,
          speech,
          business.timezone
        );

      listen(
        `${answer} What else would you like to know?`
      );
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