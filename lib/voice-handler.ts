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
} from "@/lib/voice-understanding";

export type VoiceIngress =
  | "production"
  | "trial";

type BusinessContext = {
  businessId: string;
  businessName: string;
  timezone: string | null;
};

const INFO_PROMPT =
  "What would you like to know about our services, hours, or location?";

const TRANSFER_UNAVAILABLE =
  "I'm sorry, transferring to a team member isn't available right now. I can still help with business information.";

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
        "I couldn't hear you. No appointment was booked. Please call again when you're ready. Goodbye."
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
          ? "I didn't hear the service. Which service would you like?"
          : state.booking.stage ===
              "date"
            ? "I didn't hear the date. Please say the month and day, such as September 24th."
            : state.booking.stage ===
                "time"
              ? "I didn't hear the time. Please say a time such as 10 AM or 2:30 PM."
              : `I didn't hear your answer. ${bookingSummary(
                  state
                )}. Say yes to book it, or no to cancel.`;

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

  /*
   * Preserve the existing global explicit cancellation
   * behavior. A clear deterministic "no" never requires
   * an AI call.
   */
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
        "I'm sorry, I couldn't verify those details. No appointment was booked. Please contact the business for help. Goodbye."
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
      `Which service would you like? Available services include ${names}.`,
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

    /*
     * FAST PATH:
     *
     * Existing deterministic service matching remains
     * first. Normal obvious requests therefore do not
     * incur an OpenAI round trip.
     */
    const deterministic =
      matchVoiceService(
        services,
        speech
      );

    let service =
      deterministic.match;

    /*
     * SEMANTIC FALLBACK:
     *
     * Only when the deterministic matcher cannot safely
     * select a service do we ask the narrow understanding
     * layer to interpret the natural utterance.
     *
     * The model receives service display names only.
     * It never receives service IDs or business IDs.
     */
    if (!service) {
      const understanding =
        await understandVoiceTurn({
          stage: "service",
          speech,
          services:
            services.map(
              (item) =>
                item.name
            ),
        });

      if (
        understanding.kind ===
        "service"
      ) {
        /*
         * Never trust the model as the service authority.
         * Map its display-name selection back onto the
         * actual server-loaded service record.
         */
        service =
          services.find(
            (item) =>
              item.name ===
              understanding.serviceName
          ) || null;
      }
    }

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
        deterministic.candidates
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

    state.booking.stage =
      "date";

    gather(
      response,
      ingress,
      binding,
      `What date would you like for ${service.name}? You can say tomorrow, or a month and day.`,
      state
    );

    return;
  }

  if (
    state.booking.stage ===
    "date"
  ) {
    const date =
      bookingDate(
        speech,
        business.timezone
      );

    if (!date) {
      retry(
        "I couldn't verify that date. Please say the month, day, and year."
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

    state.booking.time =
      null;

    state.booking.stage =
      "time";

    gather(
      response,
      ingress,
      binding,
      "What time would you like? For example, say 10 AM or 2:30 PM.",
      state
    );

    return;
  }

  if (
    state.booking.stage ===
    "time"
  ) {
    const parsed =
      parseSpokenTime(
        speech
      );

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

    if (
      !state.booking
        .serviceId ||
      !state.booking.date
    ) {
      response.say(
        voiceOptions(),
        "I couldn't verify all of the booking details. No appointment was booked. Please call again."
      );

      response.hangup();
      return;
    }

    /*
     * Advisory read-only availability check.
     *
     * This does not reserve anything and does not
     * authorize the final booking mutation.
     */
    const availabilityStarted =
      Date.now();

    const availability =
      await checkVoiceAvailability({
        businessId:
          business.businessId,

        serviceId:
          state.booking
            .serviceId,

        date:
          state.booking.date,

        time:
          parsed.value,
      });

    console.info(
      `AnaAI voice availability completed duration_ms=${
        Date.now() -
        availabilityStarted
      } result=${
        availability.available
          ? "available"
          : availability.reason
      }`
    );

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

        return;
      }

      if (
        availability.reason ===
        "outside_hours"
      ) {
        retry(
          "That time is outside the business hours for that day. Please choose another time."
        );

        return;
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

        return;
      }

      /*
       * Unknown/malformed availability results fail
       * closed. We never claim that an unverified slot
       * is available.
       */
      response.say(
        voiceOptions(),
        "I'm sorry, I couldn't verify appointment availability right now. No appointment was booked. Please contact the business for help. Goodbye."
      );

      response.hangup();
      return;
    }

    state.booking.failures =
      0;

    state.booking.time =
      parsed.value;

    state.booking.stage =
      "confirm";

    gather(
      response,
      ingress,
      binding,
      `I have ${bookingSummary(
        state
      )}. Say yes to book this appointment, or no to cancel.`,
      state
    );

    return;
  }

  /*
   * FINAL CONFIRMATION
   *
   * The deterministic confirmation parser remains the
   * fast path.
   */
  let confirmation =
    interpretConfirmation(
      speech
    );

  /*
   * If deterministic parsing does not clearly authorize
   * or reject the appointment, use the narrow semantic
   * interpreter.
   *
   * The interpreter still cannot mutate anything.
   */
  if (
    confirmation !== "yes" &&
    confirmation !== "no"
  ) {
    const understanding =
      await understandVoiceTurn({
        stage: "confirm",
        speech,
      });

    if (
      understanding.kind ===
      "confirmation"
    ) {
      confirmation =
        understanding.value;
    }
  }

  if (
    confirmation === "no"
  ) {
    response.say(
      voiceOptions(),
      "Okay. No appointment was booked. Thanks for calling. Goodbye."
    );

    response.hangup();
    return;
  }

  /*
   * Anything except a clear YES remains non-authorizing.
   *
   * Questions, corrections, uncertainty and background
   * speech therefore cannot trigger executeVoiceBooking.
   */
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
   * Nothing above this point creates an appointment.
   *
   * The existing secure voice booking RPC remains the
   * final authority and re-checks the slot after explicit
   * confirmation.
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

  /*
   * Booking truth and SMS truth remain independent.
   *
   * A Twilio/carrier problem cannot convert a verified
   * database appointment into a failed appointment.
   */
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

  if (
    state?.mode ===
    "booking"
  ) {
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
      /\b(transfer|representative|human|speak (?:with|to) (?:someone|somebody|a person)|talk to (?:someone|somebody|a person))\b/i.test(
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