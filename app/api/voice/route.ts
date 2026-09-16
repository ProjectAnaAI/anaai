import { NextResponse } from "next/server";
import twilio from "twilio";

import { createSupabaseServiceClient } from "@/lib/supabase-server";

export const runtime = "nodejs";

type BusinessContext = {
  businessId: string;
  businessName: string;
};

type TwilioVerificationResult =
  | {
      allowed: true;
      verified: true;
      reason: "verified";
    }
  | {
      allowed: false;
      verified: false;
      reason:
        | "missing-signature"
        | "invalid-signature"
        | "missing-auth-token"
        | "missing-webhook-url"
        | "validation-error";
    };

function twimlResponse(xml: string) {
  return new NextResponse(xml, {
    status: 200,
    headers: {
      "Content-Type": "text/xml",
    },
  });
}

function forbiddenResponse() {
  return new NextResponse("Forbidden", {
    status: 403,
    headers: {
      "Content-Type": "text/plain",
    },
  });
}

function getConfiguredVoiceWebhookUrl() {
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

function getVoiceUrl(mode?: string) {
  const configuredUrl = getConfiguredVoiceWebhookUrl();

  if (!configuredUrl) {
    throw new Error("TWILIO_VOICE_WEBHOOK_URL is missing or invalid.");
  }

  const url = new URL(configuredUrl);

  if (mode) {
    url.searchParams.set("mode", mode);
  }

  return url.toString();
}

function getValidationUrl(request: Request) {
  const configuredUrl = getConfiguredVoiceWebhookUrl();

  if (!configuredUrl) {
    return "";
  }

  const incomingUrl = new URL(request.url);
  const validationUrl = new URL(configuredUrl);

  validationUrl.search = incomingUrl.search;

  return validationUrl.toString();
}

function formDataToTwilioParams(formData: FormData) {
  const params: Record<string, string> = {};

  for (const [key, value] of formData.entries()) {
    if (typeof value === "string") {
      params[key] = value;
    }
  }

  return params;
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

function verifyTwilioWebhook({
  request,
  params,
}: {
  request: Request;
  params: Record<string, string>;
}): TwilioVerificationResult {
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  const signature = request.headers.get("x-twilio-signature")?.trim();

  if (!signature) {
    console.warn("AnaAI rejected unsigned Twilio voice request.");

    return {
      allowed: false,
      verified: false,
      reason: "missing-signature",
    };
  }

  if (!authToken) {
    console.error("TWILIO_AUTH_TOKEN is missing.");

    return {
      allowed: false,
      verified: false,
      reason: "missing-auth-token",
    };
  }

  const validationUrl = getValidationUrl(request);

  if (!validationUrl) {
    console.error("TWILIO_VOICE_WEBHOOK_URL is missing or invalid.");

    return {
      allowed: false,
      verified: false,
      reason: "missing-webhook-url",
    };
  }

  try {
    const isValid = twilio.validateRequest(
      authToken,
      signature,
      validationUrl,
      params
    );

    if (!isValid) {
      console.warn("AnaAI rejected invalid Twilio signature.");

      return {
        allowed: false,
        verified: false,
        reason: "invalid-signature",
      };
    }

    return {
      allowed: true,
      verified: true,
      reason: "verified",
    };
  } catch {
    console.error("AnaAI Twilio signature validation failed.");

    return {
      allowed: false,
      verified: false,
      reason: "validation-error",
    };
  }
}

function addMainMenu(
  response: twilio.twiml.VoiceResponse,
  business: BusinessContext
) {
  const gather = response.gather({
    input: ["dtmf", "speech"],
    numDigits: 1,
    action: getVoiceUrl("menu"),
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
    getVoiceUrl()
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

function addAppointmentTest(response: twilio.twiml.VoiceResponse) {
  const gather = response.gather({
    input: ["speech"],
    action: getVoiceUrl("appointment-test"),
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
    getVoiceUrl()
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

export async function POST(request: Request) {
  try {
    const url = new URL(request.url);
    const mode = url.searchParams.get("mode") || "";

    const formData = await request.formData();
    const twilioParams = formDataToTwilioParams(formData);

    const verification = verifyTwilioWebhook({
      request,
      params: twilioParams,
    });

    if (!verification.allowed) {
      return forbiddenResponse();
    }

    const calledNumber = String(formData.get("To") || "").trim();

    const business = await resolveBusinessByCalledNumber(calledNumber);

    const response = new twilio.twiml.VoiceResponse();

    if (!business) {
      console.warn(
        "AnaAI verified voice request did not resolve to an active business."
      );

      addConfigurationError(response);
      return twimlResponse(response.toString());
    }

    const digits = String(formData.get("Digits") || "").trim();
    const speechResult = String(
      formData.get("SpeechResult") || ""
    ).trim();

    console.log("AnaAI verified voice request accepted.", {
      mode,
      businessResolved: true,
      hasDigits: Boolean(digits),
      hasSpeech: Boolean(speechResult),
    });

    if (!mode) {
      addMainMenu(response, business);
      return twimlResponse(response.toString());
    }

    if (mode === "menu") {
      const choice = normalizeChoice({
        digits,
        speech: speechResult,
      });

      if (choice === "1") {
        addAppointmentTest(response);
        return twimlResponse(response.toString());
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
          getVoiceUrl()
        );

        return twimlResponse(response.toString());
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
          getVoiceUrl()
        );

        return twimlResponse(response.toString());
      }

      if (choice === "4") {
        addMainMenu(response, business);
        return twimlResponse(response.toString());
      }

      response.say(
        {
          voice: "alice",
        },
        "I'm sorry, I didn't understand your selection."
      );

      addMainMenu(response, business);
      return twimlResponse(response.toString());
    }

    if (mode === "appointment-test") {
      if (!speechResult) {
        response.say(
          {
            voice: "alice",
          },
          "I'm sorry, I didn't hear the service."
        );

        addAppointmentTest(response);
        return twimlResponse(response.toString());
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

      addMainMenu(response, business);
      return twimlResponse(response.toString());
    }

    addMainMenu(response, business);
    return twimlResponse(response.toString());
  } catch {
    console.error("AnaAI voice menu request failed.");

    const response = new twilio.twiml.VoiceResponse();

    response.say(
      {
        voice: "alice",
      },
      "I'm sorry, AnaAI is having trouble responding right now. Please try again later."
    );

    return twimlResponse(response.toString());
  }
}

export async function GET() {
  const response = new twilio.twiml.VoiceResponse();

  response.say(
    {
      voice: "alice",
    },
    "AnaAI voice service is online."
  );

  return twimlResponse(response.toString());
}