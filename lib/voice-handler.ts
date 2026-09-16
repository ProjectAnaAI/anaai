import "server-only";

import twilio from "twilio";

import {
  executeVoiceBooking,
  loadVoiceServices,
  resolveVoiceService,
} from "@/lib/voice-booking";
import {
  answerVoiceQuestion,
  safeVoiceText,
} from "@/lib/voice-receptionist";
import { createSupabaseServiceClient } from "@/lib/supabase-server";
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

export type VoiceIngress = "production" | "trial";

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

const YES =
  /^(?:yes|yeah|yep|correct|confirm|confirmed|that's right|that is right|looks good|sounds good|book it|please do)[.!?, ]*$/i;

const NO =
  /^(?:no|nope|cancel|stop|never mind|nevermind|go back|start over)[.!?, ]*$/i;

const BOOKING_INTENT =
  /\b(?:book|booking|schedule|reserve)\b/i;

const PHONE = /^\+[1-9]\d{7,14}$/;

function productionVoiceUrl() {
  const value =
    process.env.TWILIO_VOICE_WEBHOOK_URL?.trim();

  if (!value) {
    return "";
  }

  try {
    const url = new URL(value);

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
  const configured = productionVoiceUrl();

  if (!configured) {
    throw new Error(
      "TWILIO_VOICE_WEBHOOK_URL is missing or invalid."
    );
  }

  if (ingress === "production") {
    const url = new URL(configured);

    if (mode) {
      url.searchParams.set("mode", mode);
    }

    if (state) {
      url.searchParams.set("state", state);
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

  const production = new URL(configured);
  const url = new URL(
    "/api/voice/trial",
    production.origin
  );

  url.searchParams.set("token", token);

  if (mode) {
    url.searchParams.set("mode", mode);
  }

  if (state) {
    url.searchParams.set("state", state);
  }

  return url.toString();
}

function normalizePhone(value: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    return "";
  }

  if (trimmed.startsWith("+")) {
    const digits = trimmed
      .slice(1)
      .replace(/\D/g, "");

    return digits ? `+${digits}` : "";
  }

  const digits = trimmed.replace(/\D/g, "");

  if (digits.length === 10) {
    return `+1${digits}`;
  }

  if (
    digits.length === 11 &&
    digits.startsWith("1")
  ) {
    return `+${digits}`;
  }

  return digits ? `+${digits}` : "";
}

async function resolveBusinessByCalledNumber(
  calledNumber: string
): Promise<BusinessContext | null> {
  const phone = normalizePhone(calledNumber);

  if (!phone) {
    return null;
  }

  const db = createSupabaseServiceClient();

  const { data, error } = await db
    .from("business_phone_numbers")
    .select(
      `
        business_id,
        businesses!inner (
          name,
          timezone
        )
      `
    )
    .eq("phone_number", phone)
    .eq("provider", "twilio")
    .eq("is_active", true)
    .abortSignal(AbortSignal.timeout(3000))
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

  const related = Array.isArray(data.businesses)
    ? data.businesses[0]
    : data.businesses;

  const businessName =
    related &&
    typeof related === "object" &&
    "name" in related &&
    typeof related.name === "string"
      ? related.name.trim()
      : "";

  if (!data.business_id || !businessName) {
    console.error(
      "AnaAI voice business lookup returned incomplete routing data."
    );
    throw new Error(
      "Voice business routing data is incomplete."
    );
  }

  return {
    businessId: data.business_id,
    businessName,
    timezone:
      related &&
      typeof related === "object" &&
      "timezone" in related &&
      typeof related.timezone === "string"
        ? related.timezone
        : null,
  };
}

function mainMenu(name: string) {
  return `Hi, this is AnaAI from ${
    safeVoiceText(name, 100) || "the business"
  }. How can I help? Speak naturally, or press 1 to book an appointment, 2 for business information, 3 for a team member, or 0 to repeat these options.`;
}

function gather(
  response: twilio.twiml.VoiceResponse,
  ingress: VoiceIngress,
  binding: VoiceBinding,
  message: string,
  state: VoiceState | null,
  mode = "listen"
) {
  if (
    state &&
    (state.turns >= 30 ||
      state.expires <= Date.now())
  ) {
    response.say(
      { voice: "alice" },
      "Thanks for calling. Please call again if you need more help. Goodbye."
    );
    response.hangup();
    return;
  }

  const token = state
    ? sealVoiceState(state, binding)
    : undefined;

  const input = response.gather({
    input: ["speech", "dtmf"],
    numDigits: 1,
    action: callbackUrl(
      ingress,
      mode,
      token
    ),
    method: "POST",
    timeout: 6,
    speechTimeout: "auto",
    language: "en-US",
    actionOnEmptyResult: true,
  });

  input.say(
    { voice: "alice" },
    message
  );
}

function businessLocalDate(
  timezone: string | null,
  offsetDays = 0
) {
  if (!timezone) {
    return null;
  }

  try {
    const base = new Date(
      Date.now() +
        offsetDays * 24 * 60 * 60_000
    );

    const parts =
      new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(base);

    const values = Object.fromEntries(
      parts.map((part) => [
        part.type,
        part.value,
      ])
    );

    if (
      !values.year ||
      !values.month ||
      !values.day
    ) {
      return null;
    }

    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    return null;
  }
}

function bookingDate(
  speech: string,
  timezone: string | null
) {
  const text = speech
    .replace(/[,.]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  if (text === "today") {
    return businessLocalDate(timezone);
  }

  if (text === "tomorrow") {
    return businessLocalDate(
      timezone,
      1
    );
  }

  const match =
    /\b(\d{4}-\d{2}-\d{2})\b/.exec(
      text
    );

  if (!match) {
    return null;
  }

  const date = new Date(
    `${match[1]}T00:00:00Z`
  );

  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !==
      match[1]
  ) {
    return null;
  }

  return match[1];
}

function bookingTime(speech: string) {
  const text = speech
    .trim()
    .toLowerCase()
    .replace(/\./g, "");

  const twelve =
    /\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(am|pm)\b/.exec(
      text
    );

  if (twelve) {
    let hour = Number(twelve[1]);
    const minute = Number(
      twelve[2] || "00"
    );

    if (twelve[3] === "am") {
      if (hour === 12) {
        hour = 0;
      }
    } else if (hour !== 12) {
      hour += 12;
    }

    return `${String(hour).padStart(
      2,
      "0"
    )}:${String(minute).padStart(2, "0")}`;
  }

  const twentyFour =
    /\b([01]\d|2[0-3]):([0-5]\d)\b/.exec(
      text
    );

  return twentyFour
    ? `${twentyFour[1]}:${twentyFour[2]}`
    : null;
}

function spokenTime(value: string) {
  const [hours, minutes] =
    value.split(":");

  const hour = Number(hours);
  const minute = Number(minutes);

  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute)
  ) {
    return value;
  }

  const suffix = hour >= 12 ? "PM" : "AM";
  const displayHour =
    hour % 12 === 0 ? 12 : hour % 12;

  return minute === 0
    ? `${displayHour} ${suffix}`
    : `${displayHour}:${String(
        minute
      ).padStart(2, "0")} ${suffix}`;
}

function bookingSummary(
  state: VoiceBookingState
) {
  return `${state.booking.serviceName} on ${state.booking.date} at ${spokenTime(
    state.booking.time || ""
  )}`;
}

function beginBooking(
  response: twilio.twiml.VoiceResponse,
  ingress: VoiceIngress,
  binding: VoiceBinding
) {
  if (!voiceStateConfigured()) {
    gather(
      response,
      ingress,
      binding,
      BOOKING_STATE_UNAVAILABLE,
      null
    );
    return;
  }

  const state = initialBookingState();
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
  response: twilio.twiml.VoiceResponse;
  ingress: VoiceIngress;
  binding: VoiceBinding;
  business: BusinessContext;
  state: VoiceBookingState;
  speech: string;
  callerPhone: string;
}) {
  if (!speech) {
    if (state.silence >= 1) {
      response.say(
        { voice: "alice" },
        "I couldn't hear you. No appointment was booked. Please call again when you're ready. Goodbye."
      );
      response.hangup();
      return;
    }

    state.silence = 1;

    const prompt =
      state.booking.stage === "name"
        ? "I didn't hear the name. What name should I put on the appointment?"
        : state.booking.stage === "service"
          ? "I didn't hear the service. Which service would you like?"
          : state.booking.stage === "date"
            ? "I didn't hear the date. Please say today, tomorrow, or a date like 2026-09-20."
            : state.booking.stage === "time"
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

  if (NO.test(speech)) {
    response.say(
      { voice: "alice" },
      "Okay. No appointment was booked. Thanks for calling. Goodbye."
    );
    response.hangup();
    return;
  }

  if (state.booking.stage === "name") {
    const name = speech
      .replace(/\s+/g, " ")
      .trim();

    if (
      name.length < 2 ||
      name.length > 120 ||
      /[<>\x00-\x1f]/.test(name)
    ) {
      gather(
        response,
        ingress,
        binding,
        "I couldn't use that name. Please say the name for the appointment.",
        state
      );
      return;
    }

    state.booking.customerName = name;
    state.booking.stage = "service";

    const services =
      await loadVoiceServices(
        business.businessId
      );

    if (!services.length) {
      response.say(
        { voice: "alice" },
        "I'm sorry, I can't find any services available for phone booking right now. No appointment was booked."
      );
      response.hangup();
      return;
    }

    const names = services
      .slice(0, 6)
      .map((service) => service.name)
      .join(", ");

    gather(
      response,
      ingress,
      binding,
      `Which service would you like? Available services include ${names}.`,
      state
    );
    return;
  }

  if (state.booking.stage === "service") {
    const service =
      await resolveVoiceService(
        business.businessId,
        speech
      );

    if (!service) {
      gather(
        response,
        ingress,
        binding,
        "I couldn't match that to one available service. Please say the service name again.",
        state
      );
      return;
    }

    state.booking.serviceId = service.id;
    state.booking.serviceName =
      service.name;
    state.booking.stage = "date";

    gather(
      response,
      ingress,
      binding,
      `What date would you like for ${service.name}? You can say today, tomorrow, or a date like 2026-09-20.`,
      state
    );
    return;
  }

  if (state.booking.stage === "date") {
    const date = bookingDate(
      speech,
      business.timezone
    );

    if (!date) {
      gather(
        response,
        ingress,
        binding,
        "I couldn't verify that date. Please say today, tomorrow, or a date like 2026-09-20.",
        state
      );
      return;
    }

    const today =
      businessLocalDate(
        business.timezone
      );

    if (today && date < today) {
      gather(
        response,
        ingress,
        binding,
        "That date has already passed. Please choose another date.",
        state
      );
      return;
    }

    state.booking.date = date;
    state.booking.stage = "time";

    gather(
      response,
      ingress,
      binding,
      "What time would you like? For example, say 10 AM or 2:30 PM.",
      state
    );
    return;
  }

  if (state.booking.stage === "time") {
    const time = bookingTime(speech);

    if (!time) {
      gather(
        response,
        ingress,
        binding,
        "I couldn't verify that time. Please say a time such as 10 AM or 2:30 PM.",
        state
      );
      return;
    }

    state.booking.time = time;
    state.booking.stage = "confirm";

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

  if (!YES.test(speech)) {
    gather(
      response,
      ingress,
      binding,
      `Please say yes to book ${bookingSummary(
        state
      )}, or no to cancel.`,
      state
    );
    return;
  }

  const booking = state.booking;

  if (
    !booking.customerName ||
    !booking.serviceId ||
    !booking.serviceName ||
    !booking.date ||
    !booking.time
  ) {
    response.say(
      { voice: "alice" },
      "I couldn't verify all of the booking details. No appointment was booked. Please call again."
    );
    response.hangup();
    return;
  }

  const phone =
    normalizePhone(callerPhone);

  if (!PHONE.test(phone)) {
    response.say(
      { voice: "alice" },
      "I couldn't verify a callback phone number for this appointment. No appointment was booked."
    );
    response.hangup();
    return;
  }

  const result =
    await executeVoiceBooking({
      businessId: business.businessId,
      idempotencyKey:
        booking.idempotencyKey,
      customerName:
        booking.customerName,
      customerPhone: phone,
      serviceId: booking.serviceId,
      serviceName:
        booking.serviceName,
      date: booking.date,
      time: booking.time,
    });

  if (!result.success) {
    response.say(
      { voice: "alice" },
      result.message
    );
    response.hangup();
    return;
  }

  const confirmation =
    result.replayed
      ? "Your original booking was already completed. No duplicate appointment was created."
      : "Your appointment has been booked successfully.";

  const sms = result.smsSent
    ? " A confirmation text was submitted for sending."
    : " I couldn't verify the text confirmation status.";

  response.say(
    { voice: "alice" },
    `${confirmation}${sms} Thanks for calling. Goodbye.`
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
  const called = formData.get("To");

  const business =
    await resolveBusinessByCalledNumber(
      typeof called === "string"
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
      { voice: "alice" },
      "I'm sorry, AnaAI could not identify the business for this phone number."
    );
    response.hangup();

    return response.toString();
  }

  const read = (key: string) => {
    const value = formData.get(key);
    return typeof value === "string"
      ? value.trim()
      : "";
  };

  const binding: VoiceBinding = {
    businessId: business.businessId,
    callSid: read("CallSid"),
    ingress,
  };

  let state: VoiceState | null = null;

  if (stateToken) {
    try {
      state = openVoiceState(
        stateToken,
        binding
      );
    } catch {
      response.say(
        { voice: "alice" },
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
    state = initialVoiceState();
  }

  if (state) {
    state.turns++;
  }

  const speech = read("SpeechResult");
  const digits = read("Digits");
  const callerPhone = read("From");

  if (state?.mode === "booking") {
    await bookingTurn({
      response,
      ingress,
      binding,
      business,
      state,
      speech,
      callerPhone,
    });

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
      { voice: "alice" },
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
      mainMenu(business.businessName)
    );
  } else if (!speech && !digits) {
    if (
      (state?.silence ??
        (mode === "retry" ? 1 : 0)) >= 1
    ) {
      response.say(
        { voice: "alice" },
        "I couldn't hear you. Please call again when you're ready. Goodbye."
      );
      response.hangup();
    } else {
      if (state) {
        state.silence = 1;
      }

      listen(
        `I didn't hear anything. ${
          state?.mode === "info"
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
        state.mode = "menu";
      }

      listen(
        mainMenu(business.businessName)
      );
    } else if (
      digits === "1" ||
      BOOKING_INTENT.test(speech)
    ) {
      beginBooking(
        response,
        ingress,
        binding
      );
    } else if (digits === "2") {
      if (state) {
        state.mode = "info";
      }

      listen(INFO_PROMPT);
    } else if (
      digits === "3" ||
      /\b(transfer|representative|human|speak (?:with|to) (?:someone|somebody|a person)|talk to (?:someone|somebody|a person))\b/i.test(
        speech
      )
    ) {
      listen(TRANSFER_UNAVAILABLE);
    } else if (digits) {
      listen(
        `That option isn't available. ${mainMenu(
          business.businessName
        )}`
      );
    } else {
      if (state) {
        state.mode = "info";
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

  return response.toString();
}
