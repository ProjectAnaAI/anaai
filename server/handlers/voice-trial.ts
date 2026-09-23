import crypto from "node:crypto";

import twilio from "twilio";

import { buildVoiceResponse } from "@/lib/voice-handler";

import { voiceOptions } from "@/lib/voice-config";

function twimlResponse(xml: string) {
  return new Response(xml, {
    status: 200,
    headers: {
      "Content-Type": "text/xml",
      "Cache-Control": "no-store",
    },
  });
}

function forbiddenResponse() {
  return new Response("Forbidden", {
    status: 403,
    headers: {
      "Content-Type": "text/plain",
      "Cache-Control": "no-store",
    },
  });
}

function tokensMatch(provided: string, expected: string) {
  if (!provided || !expected) {
    return false;
  }

  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);

  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

function verifyTrialIngress(request: Request) {
  const expectedToken =
    process.env.TWILIO_TRIAL_VOICE_TOKEN?.trim() || "";

  if (!expectedToken) {
    console.error("TWILIO_TRIAL_VOICE_TOKEN is missing.");
    return false;
  }

  const url = new URL(request.url);
  const providedToken = url.searchParams.get("token")?.trim() || "";

  if (!tokensMatch(providedToken, expectedToken)) {
    console.warn("AnaAI rejected unauthorized trial voice request.");
    return false;
  }

  return true;
}

export async function POST(request: Request) {
  const started = Date.now();
  let outcome = "error";
  try {
    if (!verifyTrialIngress(request)) {
      outcome = "rejected";
      return forbiddenResponse();
    }

    const url = new URL(request.url);
    const mode = url.searchParams.get("mode") || "";

    const formData = await request.formData();

    const xml = await buildVoiceResponse({
      formData,
      mode,
      stateToken: url.searchParams.get("state") || "",
      ingress: "trial",
    });

    outcome = "responded";
    return twimlResponse(xml);
  } catch {
    console.error("AnaAI trial voice request failed.");

    const response = new twilio.twiml.VoiceResponse();

    response.say(
      voiceOptions(),
      "I'm sorry, AnaAI is having trouble responding right now. Please try again later."
    );

    return twimlResponse(response.toString());
  } finally {
    console.info("AnaAI voice ingress", { ingress: "trial", outcome, duration_ms: Date.now() - started });
  }
}

export async function GET() {
  return forbiddenResponse();
}