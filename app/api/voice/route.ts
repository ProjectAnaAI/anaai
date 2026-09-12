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

export async function POST() {
  const response = new twilio.twiml.VoiceResponse();

  response.say(
    {
      voice: "alice",
    },
    "Thanks for calling. You've reached AnaAI. How can I help you today?"
  );

  return twimlResponse(response.toString());
}

export async function GET() {
  const response = new twilio.twiml.VoiceResponse();

  response.say(
    {
      voice: "alice",
    },
    "Thanks for calling. You've reached AnaAI. How can I help you today?"
  );

  return twimlResponse(response.toString());
}