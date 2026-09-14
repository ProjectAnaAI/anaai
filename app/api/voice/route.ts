import { NextResponse } from "next/server";
import twilio from "twilio";

export const runtime = "nodejs";

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

function getPublicRequestUrl(request: Request) {
  const requestUrl = new URL(request.url);

  const forwardedProto =
    request.headers.get("x-forwarded-proto") ||
    requestUrl.protocol.replace(":", "");

  const forwardedHost =
    request.headers.get("x-forwarded-host") ||
    request.headers.get("host") ||
    requestUrl.host;

  return `${forwardedProto}://${forwardedHost}${requestUrl.pathname}${requestUrl.search}`;
}

function getVoiceUrl(request: Request, mode?: string) {
  const publicRequestUrl = new URL(getPublicRequestUrl(request));
  const url = new URL("/api/voice", publicRequestUrl.origin);

  if (mode) {
    url.searchParams.set("mode", mode);
  }

  return url.toString();
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

type TwilioVerificationResult =
  | {
      allowed: true;
      verified: true;
      reason: "verified";
    }
  | {
      allowed: true;
      verified: false;
      reason: "trial-missing-signature";
    }
  | {
      allowed: false;
      verified: false;
      reason:
        | "invalid-signature"
        | "missing-auth-token"
        | "validation-error";
    };

function verifyTwilioWebhook({
  request,
  params,
}: {
  request: Request;
  params: Record<string, string>;
}): TwilioVerificationResult {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const signature = request.headers.get("x-twilio-signature");

  if (!signature) {
    console.warn(
      "AnaAI voice request has no Twilio signature. Allowing temporary trial-mode access."
    );

    return {
      allowed: true,
      verified: false,
      reason: "trial-missing-signature",
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

  try {
    const publicUrl = getPublicRequestUrl(request);

    const isValid = twilio.validateRequest(
      authToken,
      signature,
      publicUrl,
      params
    );

    if (!isValid) {
      console.warn("AnaAI rejected invalid Twilio signature.", {
        validationUrl: publicUrl,
      });

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
  } catch (error: unknown) {
    console.error("Twilio signature validation error:", error);

    return {
      allowed: false,
      verified: false,
      reason: "validation-error",
    };
  }
}

function addMainMenu(
  response: twilio.twiml.VoiceResponse,
  request: Request
) {
  const gather = response.gather({
    input: ["dtmf", "speech"],
    numDigits: 1,
    action: getVoiceUrl(request, "menu"),
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
      "Hi, this is AnaAI from our business.",
      "For appointments or rescheduling, press or say 1.",
      "For office hours and basic business information, press or say 2.",
      "To speak with a representative, press or say 3.",
      "To repeat this menu, press or say 4.",
    ].join(" ")
  );

  response.redirect(
    {
      method: "POST",
    },
    getVoiceUrl(request)
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
  request: Request
) {
  const gather = response.gather({
    input: ["speech"],
    action: getVoiceUrl(request, "appointment-test"),
    method: "POST",
    timeout: 6,
    speechTimeout: "auto",
    language: "en-US",
  });

  gather.say(
    {
      voice: "alice",
    },
    "You selected appointments or rescheduling. What day and time would you like your appointment?"
  );

  response.say(
    {
      voice: "alice",
    },
    "I didn't hear a date and time."
  );

  response.redirect(
    {
      method: "POST",
    },
    getVoiceUrl(request)
  );
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

    const digits = String(formData.get("Digits") || "").trim();

    const speechResult = String(
      formData.get("SpeechResult") || ""
    ).trim();

    console.log("AnaAI voice request accepted:", {
      mode,
      verifiedTwilioRequest: verification.verified,
      verificationReason: verification.reason,
      hasDigits: Boolean(digits),
      hasSpeech: Boolean(speechResult),
    });

    const response = new twilio.twiml.VoiceResponse();

    if (!mode) {
      addMainMenu(response, request);
      return twimlResponse(response.toString());
    }

    if (mode === "menu") {
      const choice = normalizeChoice({
        digits,
        speech: speechResult,
      });

      if (choice === "1") {
        addAppointmentTest(response, request);
        return twimlResponse(response.toString());
      }

      if (choice === "2") {
        response.say(
          {
            voice: "alice",
          },
          "You selected office hours and business information. This option is working. We will connect your real business information next."
        );

        response.redirect(
          {
            method: "POST",
          },
          getVoiceUrl(request)
        );

        return twimlResponse(response.toString());
      }

      if (choice === "3") {
        response.say(
          {
            voice: "alice",
          },
          "You selected transfer to a representative. Call transfer is not enabled yet. We will connect the representative number after testing the menu."
        );

        response.redirect(
          {
            method: "POST",
          },
          getVoiceUrl(request)
        );

        return twimlResponse(response.toString());
      }

      if (choice === "4") {
        addMainMenu(response, request);
        return twimlResponse(response.toString());
      }

      response.say(
        {
          voice: "alice",
        },
        "I'm sorry, I didn't understand your selection."
      );

      addMainMenu(response, request);

      return twimlResponse(response.toString());
    }

    if (mode === "appointment-test") {
      if (!speechResult) {
        response.say(
          {
            voice: "alice",
          },
          "I'm sorry, I didn't hear the date and time."
        );

        addAppointmentTest(response, request);

        return twimlResponse(response.toString());
      }

      response.say(
        {
          voice: "alice",
        },
        `I heard ${speechResult}. The appointment menu is working. We have not booked anything yet.`
      );

      response.say(
        {
          voice: "alice",
        },
        "Returning to the main menu."
      );

      addMainMenu(response, request);

      return twimlResponse(response.toString());
    }

    addMainMenu(response, request);

    return twimlResponse(response.toString());
  } catch (error: unknown) {
    console.error("AnaAI voice menu error:", error);

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

export async function GET(request: Request) {
  const response = new twilio.twiml.VoiceResponse();

  addMainMenu(response, request);

  return twimlResponse(response.toString());
}