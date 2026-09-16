import "server-only";
import twilio from "twilio";

import { createSupabaseServiceClient } from "@/lib/supabase-server";
import { answerVoiceQuestion, safeVoiceText, VOICE_BOOKING_DISABLED } from "@/lib/voice-receptionist";
import {
  initialVoiceState, openVoiceState, sealVoiceState, voiceStateConfigured,
  type VoiceBinding, type VoiceState,
} from "@/lib/voice-state";

export type VoiceIngress = "production" | "trial";

type BusinessContext = {
  businessId: string;
  businessName: string;
  timezone: string | null;
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

function getVoiceUrl(ingress: VoiceIngress, mode: string, state?: string) {
  if (ingress === "production") {
    const configuredUrl = getConfiguredProductionVoiceUrl();

    if (!configuredUrl) {
      throw new Error("TWILIO_VOICE_WEBHOOK_URL is missing or invalid.");
    }

    const url = new URL(configuredUrl);

    if (mode) {
      url.searchParams.set("mode", mode);
    }

    if (state) url.searchParams.set("state", state);
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

  if (state) trialUrl.searchParams.set("state", state);
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
          name, timezone
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
    timezone: relatedBusiness && typeof relatedBusiness === "object" &&
      "timezone" in relatedBusiness && typeof relatedBusiness.timezone === "string"
      ? relatedBusiness.timezone : null,
  };
}

const INFO_PROMPT = "What would you like to know about our services, hours, or location?";
const TRANSFER_UNAVAILABLE = "I'm sorry, transferring to a team member isn't available right now. I can still help with business information.";

function mainMenu(name: string): string {
  return `Hi, this is AnaAI from ${safeVoiceText(name, 100) || "the business"}. How can I help? Speak naturally, or press 1 for appointments, 2 for business information, 3 for a team member, or 0 to repeat these options.`;
}

function listen(response: twilio.twiml.VoiceResponse, ingress: VoiceIngress,
  message: string, state: VoiceState | null, binding: VoiceBinding, fallbackMode = "listen") {
  if (state && (state.turns >= 30 || state.expires <= Date.now())) {
    response.say({ voice: "alice" }, "Thanks for calling. Please call again if you need more help. Goodbye.");
    response.hangup();
    return;
  }
  const token = state ? sealVoiceState(state, binding) : undefined;
  const gather = response.gather({
    input: ["speech", "dtmf"], numDigits: 1,
    action: getVoiceUrl(ingress, fallbackMode, token), method: "POST",
    timeout: 6, speechTimeout: "auto", language: "en-US", actionOnEmptyResult: true,
  });
  gather.say({ voice: "alice" }, message);
}

export async function buildVoiceResponse({ formData, mode, ingress, stateToken = "" }: {
  formData: FormData; mode: string; ingress: VoiceIngress; stateToken?: string;
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
  const read = (key: string) => {
    const value = formData.get(key);
    return typeof value === "string" ? value.trim() : "";
  };
  const binding: VoiceBinding = { businessId: business.businessId, callSid: read("CallSid"), ingress };
  let state: VoiceState | null = null;
  // Optional until configured: existing read-only ingress remains functional.
  // Invalid supplied state NEVER falls back to a fresh conversation.
  if (stateToken) {
    try { state = openVoiceState(stateToken, binding); }
    catch {
      response.say({ voice: "alice" }, "This conversation has expired. Please call again. Goodbye.");
      response.hangup();
      return response.toString();
    }
  } else if (voiceStateConfigured() && /^CA[0-9a-f]{32}$/i.test(binding.callSid)) {
    state = initialVoiceState();
  }
  if (state) state.turns++;
  const speech = read("SpeechResult"), digits = read("Digits");
  const say = (text: string, fallbackMode = "listen") => listen(response, ingress, text, state, binding, fallbackMode);
  const goodbye = /^(goodbye|bye|bye bye|end (the )?call|hang up|that['’]?s all|no thanks|no thank you|thank you goodbye)[.!?, ]*$/i.test(speech);
  if (goodbye) {
    response.say({ voice: "alice" }, "Thanks for calling. Goodbye!");
    response.hangup(); // No new state is issued; no server-side state to delete.
  } else if (!mode && !stateToken && !speech && !digits) {
    say(mainMenu(business.businessName));
  } else if (!speech && !digits) {
    if ((state?.silence ?? (mode === "retry" ? 1 : 0)) >= 1) {
      response.say({ voice: "alice" }, "I couldn't hear you. Please call again when you're ready. Goodbye.");
      response.hangup();
    } else {
      if (state) state.silence = 1;
      say(`I didn't hear anything. ${state?.mode === "info" ? INFO_PROMPT : "Speak naturally, or press 0 to hear the options."}`, "retry");
    }
  } else {
    if (state) state.silence = 0;
    if (digits === "0" || /^(?:please )?(?:repeat(?: the)? (?:menu|options)|main menu|start over)[.!?, ]*$/i.test(speech)) {
      if (state) state.mode = "menu";
      say(mainMenu(business.businessName));
    } else if (digits === "1") {
      if (state) state.mode = "info";
      say(`${VOICE_BOOKING_DISABLED} ${INFO_PROMPT}`);
    } else if (digits === "2") {
      if (state) state.mode = "info";
      say(INFO_PROMPT);
    } else if (digits === "3" || /\b(transfer|representative|human|speak (?:with|to) (?:someone|somebody|a person)|talk to (?:someone|somebody|a person))\b/i.test(speech)) {
      say(TRANSFER_UNAVAILABLE);
    } else if (digits) {
      say(`That option isn't available. ${mainMenu(business.businessName)}`);
    } else {
      if (state) state.mode = "info";
      const answer = await answerVoiceQuestion(business.businessId, business.businessName, speech, business.timezone);
      say(`${answer} What else would you like to know?`);
    }
  }
  return response.toString();
}
