import twilio from "twilio";

import { createSupabaseServiceClient } from "@/lib/supabase-server";

export type VoiceIngress = "production" | "trial";

type BusinessContext = {
  businessId: string;
  businessName: string;
};

function getConfiguredProductionVoiceUrl() {
  const value = process.env.TWILIO_VOICE_WEBHOOK_URL?.trim();

  if (!value) {
    return "";
  }

  try {
    const url = new URL(value);

    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return "";
    }

    return url.toString();
  } catch {
    return "";
  }
}

function getTrialVoiceToken() {
  return process.env.TWILIO_TRIAL_VOICE_TOKEN?.trim() || "";
}

function getVoiceUrl(ingress: VoiceIngress, mode?: string) {
  if (ingress === "production") {
    const configuredUrl = getConfiguredProductionVoiceUrl();

    if (!configuredUrl) {
      throw new Error("TWILIO_VOICE_WEBHOOK_URL is missing or invalid.");
    }

    const url = new URL(configuredUrl);

    if (mode) {
      url.searchParams.set("mode", mode);
    }

    return url.toString();
  }

  const token = getTrialVoiceToken();

  if (!token) {
    throw new Error("TWILIO_TRIAL_VOICE_TOKEN is missing.");
  }

  const productionUrl = getConfiguredProductionVoiceUrl();

  if (!productionUrl) {
    throw new Error("TWILIO_VOICE_WEBHOOK_URL is missing or invalid.");
  }

  const production = new URL(productionUrl);
  const trialUrl = new URL("/api/voice/trial", production.origin);

  trialUrl.searchParams.set("token", token);

  if (mode) {
    trialUrl.searchParams.set("mode", mode);
  }

  return trialUrl.toString();
}

function normalizePhoneNumber(phone: string) {
  const trimmed = phone.trim();

  if (!trimmed) {
    return "";
  }

  if (trimmed.startsWith("+")) {
    const digits = trimmed.slice(1).replace(/\D/g, "");
    return digits ? `+${digits}` : "";
  }

  const digits = trimmed.replace(/\D/g, "");

  if (digits.length === 10) {
    return `+1${digits}`;
  }

  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }

  return digits ? `+${digits}` : "";
}

async function resolveBusinessByCalledNumber(
  calledNumber: string
): Promise<BusinessContext | null> {
  const normalizedCalledNumber = normalizePhoneNumber(calledNumber);

  if (!normalizedCalledNumber) {
    return null;
  }

  const supabase = createSupabaseServiceClient();

  const { data, error } = await supabase
    .from("business_phone_numbers")
    .select(
      `
        business_id,
        businesses!inner (
          name
        )
      `
    )
    .eq("phone_number", normalizedCalledNumber)
    .eq("provider", "twilio")
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    console.error("AnaAI voice business lookup failed.", {
      code: error.code || "unknown",
    });

    throw new Error("Voice business lookup failed.");
  }

  if (!data) {
    return null;
  }

  const relatedBusiness = Array.isArray(data.businesses)
    ? data.businesses[0]
    : data.businesses;

  const businessName =
    relatedBusiness &&
    typeof relatedBusiness === "object" &&
    "name" in relatedBusiness &&
    typeof relatedBusiness.name === "string"
      ? relatedBusiness.name.trim()
      : "";

  if (!data.business_id || !businessName) {
    console.error(
      "AnaAI voice business lookup returned incomplete routing data."
    );

    throw new Error("Voice business routing data is incomplete.");
  }

  return {
    businessId: data.business_id,
    businessName,
  };
}

function addMainMenu(
  response: twilio.twiml.VoiceResponse,
  business: BusinessContext,
  ingress: VoiceIngress
) {
  const gather = response.gather({
    input: ["dtmf", "speech"],
    numDigits: 1,
    action: getVoiceUrl(ingress, "menu"),
    method: "POST",
    timeout: 6,
    speechTimeout: "auto",
    language: "en-US",
  });

  gather.say(
    {
      voice: "alice",
    },
    [
      `Hi, this is AnaAI from ${business.businessName}.`,
      "For appointments or rescheduling, press or say 1.",
      "For office hours and basic business information, press or say 2.",
      "To transfer the call to a representative, press or say 3.",
      "To repeat the menu, press or say 4.",
    ].join(" ")
  );

  response.redirect(
    {
      method: "POST",
    },
    getVoiceUrl(ingress)
  );
}

function normalizeChoice({
  digits,
  speech,
}: {
  digits: string;
  speech: string;
}) {
  if (digits === "1") return "1";
  if (digits === "2") return "2";
  if (digits === "3") return "3";
  if (digits === "4") return "4";

  const normalized = speech
    .toLowerCase()
    .replace(/[.,!?]/g, "")
    .trim();

  if (
    normalized === "1" ||
    normalized === "one" ||
    normalized.includes("appointment") ||
    normalized.includes("appointments") ||
    normalized.includes("reschedule") ||
    normalized.includes("rescheduling") ||
    normalized.includes("booking")
  ) {
    return "1";
  }

  if (
    normalized === "2" ||
    normalized === "two" ||
    normalized.includes("office hour") ||
    normalized.includes("office hours") ||
    normalized.includes("business information") ||
    normalized.includes("hours")
  ) {
    return "2";
  }

  if (
    normalized === "3" ||
    normalized === "three" ||
    normalized.includes("representative") ||
    normalized.includes("person") ||
    normalized.includes("human") ||
    normalized.includes("someone")
  ) {
    return "3";
  }

  if (
    normalized === "4" ||
    normalized === "four" ||
    normalized.includes("repeat")
  ) {
    return "4";
  }

  return "";
}

function addAppointmentTest(
  response: twilio.twiml.VoiceResponse,
  ingress: VoiceIngress
) {
  const gather = response.gather({
    input: ["speech"],
    action: getVoiceUrl(ingress, "appointment-test"),
    method: "POST",
    timeout: 6,
    speechTimeout: "auto",
    language: "en-US",
  });

  gather.say(
    {
      voice: "alice",
    },
    "You selected appointments or rescheduling. What service would you like to schedule?"
  );

  response.say(
    {
      voice: "alice",
    },
    "I didn't hear a service."
  );

  response.redirect(
    {
      method: "POST",
    },
    getVoiceUrl(ingress)
  );
}

function addConfigurationError(response: twilio.twiml.VoiceResponse) {
  response.say(
    {
      voice: "alice",
    },
    "I'm sorry, AnaAI could not identify the business for this phone number."
  );

  response.hangup();
}

export async function buildVoiceResponse({
  formData,
  mode,
  ingress,
}: {
  formData: FormData;
  mode: string;
  ingress: VoiceIngress;
}) {
  const calledNumber = String(formData.get("To") || "").trim();

  const business = await resolveBusinessByCalledNumber(calledNumber);

  const response = new twilio.twiml.VoiceResponse();

  if (!business) {
    console.warn(
      "AnaAI voice request did not resolve to an active business."
    );

    addConfigurationError(response);
    return response.toString();
  }

  const digits = String(formData.get("Digits") || "").trim();
  const speechResult = String(formData.get("SpeechResult") || "").trim();

  console.log("AnaAI voice request accepted.", {
    ingress,
    mode,
    businessResolved: true,
    hasDigits: Boolean(digits),
    hasSpeech: Boolean(speechResult),
  });

  if (!mode) {
    addMainMenu(response, business, ingress);
    return response.toString();
  }

  if (mode === "menu") {
    const choice = normalizeChoice({
      digits,
      speech: speechResult,
    });

    if (choice === "1") {
      addAppointmentTest(response, ingress);
      return response.toString();
    }

    if (choice === "2") {
      response.say(
        {
          voice: "alice",
        },
        `You selected office hours and business information for ${business.businessName}. This option is working. We will connect the real business information next.`
      );

      response.redirect(
        {
          method: "POST",
        },
        getVoiceUrl(ingress)
      );

      return response.toString();
    }

    if (choice === "3") {
      response.say(
        {
          voice: "alice",
        },
        "You selected transfer to a representative. Call transfer is not enabled yet."
      );

      response.redirect(
        {
          method: "POST",
        },
        getVoiceUrl(ingress)
      );

      return response.toString();
    }

    if (choice === "4") {
      addMainMenu(response, business, ingress);
      return response.toString();
    }

    response.say(
      {
        voice: "alice",
      },
      "I'm sorry, I didn't understand your selection."
    );

    addMainMenu(response, business, ingress);
    return response.toString();
  }

  if (mode === "appointment-test") {
    if (!speechResult) {
      response.say(
        {
          voice: "alice",
        },
        "I'm sorry, I didn't hear the service."
      );

      addAppointmentTest(response, ingress);
      return response.toString();
    }

    response.say(
      {
        voice: "alice",
      },
      `I heard ${speechResult}. The appointment service-selection test is working. We have not booked anything yet.`
    );

    response.say(
      {
        voice: "alice",
      },
      "Returning to the main menu."
    );

    addMainMenu(response, business, ingress);
    return response.toString();
  }

  addMainMenu(response, business, ingress);
  return response.toString();
}