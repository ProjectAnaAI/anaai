import "server-only";
import twilio from "twilio";

import { createSupabaseServiceClient } from "@/lib/supabase-server";
import { answerVoiceQuestion, safeVoiceText } from "@/lib/voice-receptionist";

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
    .abortSignal(AbortSignal.timeout(3000))
    .maybeSingle();

  if (error) {
    console.error("AnaAI voice business lookup failed.");

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

// No call history is retained. Every speech turn resolves the called number again.
function listen(response: twilio.twiml.VoiceResponse, ingress: VoiceIngress,
  message: string, mode = "listen") {
  const gather = response.gather({
    input: ["speech"], action: getVoiceUrl(ingress, mode), method: "POST",
    timeout: 6, speechTimeout: "auto", language: "en-US", actionOnEmptyResult: true,
  });
  gather.say({ voice: "alice" }, message);
}

export async function buildVoiceResponse({ formData, mode, ingress }: {
  formData: FormData; mode: string; ingress: VoiceIngress;
}) {
  const calledNumber = formData.get("To");
  const business = await resolveBusinessByCalledNumber(
    typeof calledNumber === "string" ? calledNumber : ""
  );
  const response = new twilio.twiml.VoiceResponse();
  if (!business) {
    console.warn("AnaAI voice request did not resolve to an active business.");
    response.say({ voice: "alice" },
      "I'm sorry, AnaAI could not identify the business for this phone number.");
    response.hangup();
    return response.toString();
  }
  const value = formData.get("SpeechResult");
  const speech = typeof value === "string" ? value.trim() : "";
  if (!mode) {
    listen(response, ingress,
      `Hi, this is AnaAI from ${safeVoiceText(business.businessName, 100) || "the business"}. I can help with business hours, services, and general information. What would you like to know?`);
  } else if (!speech) {
    if (mode === "retry") {
      response.say({ voice: "alice" }, "I couldn't hear you. Please call again when you're ready. Goodbye.");
      response.hangup();
    } else {
      listen(response, ingress, "I didn't hear anything. What would you like to know about the business?", "retry");
    }
  } else if (/^(goodbye|bye|bye bye|end (the )?call|hang up|that['’]?s all|thank you goodbye)[.!?, ]*$/i.test(speech)) {
    response.say({ voice: "alice" }, "Thanks for calling. Goodbye!");
    response.hangup();
  } else {
    const answer = await answerVoiceQuestion(business.businessId, business.businessName, speech);
    listen(response, ingress, `${answer} What else would you like to know?`);
  }
  return response.toString();
}
