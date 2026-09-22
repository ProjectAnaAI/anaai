import { NextResponse } from "next/server";
import twilio from "twilio";

import { buildVoiceResponse } from "@/lib/voice-handler";

import { voiceOptions } from "@/lib/voice-config";

export const runtime = "nodejs";

function twimlResponse(xml: string) {
  return new NextResponse(xml, {
    status: 200,
    headers: {
      "Content-Type": "text/xml",
      "Cache-Control": "no-store",
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

function verifyTwilioWebhook({
  request,
  params,
}: {
  request: Request;
  params: Record<string, string>;
}) {
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  const signature = request.headers.get("x-twilio-signature")?.trim();

  if (!signature) {
    console.warn("AnaAI rejected unsigned Twilio voice request.");
    return false;
  }

  if (!authToken) {
    console.error("TWILIO_AUTH_TOKEN is missing.");
    return false;
  }

  const validationUrl = getValidationUrl(request);

  if (!validationUrl) {
    console.error("TWILIO_VOICE_WEBHOOK_URL is missing or invalid.");
    return false;
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
    }

    return isValid;
  } catch {
    console.error("AnaAI Twilio signature validation failed.");
    return false;
  }
}

export async function POST(request: Request) {
  const started = Date.now();
  let outcome = "error";
  try {
    const url = new URL(request.url);
    const mode = url.searchParams.get("mode") || "";

    const formData = await request.formData();
    const twilioParams = formDataToTwilioParams(formData);

    if (
      !verifyTwilioWebhook({
        request,
        params: twilioParams,
      })
    ) {
      outcome = "rejected";
      return forbiddenResponse();
    }

    const xml = await buildVoiceResponse({
      formData,
      mode,
      stateToken: url.searchParams.get("state") || "",
      ingress: "production",
    });

    outcome = "responded";
    return twimlResponse(xml);
  } catch {
    console.error("AnaAI voice request failed.");

    const response = new twilio.twiml.VoiceResponse();

    response.say(
      voiceOptions(),
      "I'm sorry, AnaAI is having trouble responding right now. Please try again later."
    );

    return twimlResponse(response.toString());
  } finally {
    console.info("AnaAI voice ingress", { ingress: "production", outcome, duration_ms: Date.now() - started });
  }
}

export async function GET() {
  const response = new twilio.twiml.VoiceResponse();

  response.say(
    voiceOptions(),
    "AnaAI voice service is online."
  );

  return twimlResponse(response.toString());
}