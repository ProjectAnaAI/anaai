import { NextResponse } from "next/server";
import OpenAI from "openai";
import twilio from "twilio";

export const runtime = "nodejs";

const VOICE_URL = "https://anaai-hazel.vercel.app/api/voice";

function twimlResponse(xml: string) {
  return new NextResponse(xml, {
    status: 200,
    headers: {
      "Content-Type": "text/xml",
    },
  });
}

function addSpeechGather(
  response: twilio.twiml.VoiceResponse,
  message: string
) {
  const gather = response.gather({
    input: ["speech"],
    action: VOICE_URL,
    method: "POST",
    language: "en-US",
    speechTimeout: "auto",
    timeout: 5,
  });

  gather.say(
    {
      voice: "alice",
    },
    message
  );
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();

    const speechResult = String(
      formData.get("SpeechResult") || ""
    ).trim();

    const response = new twilio.twiml.VoiceResponse();

    if (!speechResult) {
      addSpeechGather(
        response,
        "This is AnaAI. How can I help you today?"
      );

      response.say(
        {
          voice: "alice",
        },
        "I didn't hear anything. Goodbye."
      );

      return twimlResponse(response.toString());
    }

    console.log("AnaAI heard caller:", speechResult);

    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      console.error("OPENAI_API_KEY is missing.");

      response.say(
        {
          voice: "alice",
        },
        "I'm sorry, I'm having a technical problem right now."
      );

      return twimlResponse(response.toString());
    }

    const openai = new OpenAI({
      apiKey,
    });

    const aiResponse = await openai.responses.create({
      model: "gpt-5.6-terra",
      instructions: `
You are AnaAI, a friendly and professional AI receptionist speaking with a customer over the phone.

Keep every response brief and natural for spoken conversation.

Usually answer in one or two short sentences.

Do not use markdown, bullet points, headings, or emojis.

This is currently a voice conversation test.

Do not claim that you booked, cancelled, confirmed, rescheduled, or changed an appointment.

If the caller asks you to perform an appointment action, explain briefly that appointment actions are not enabled in this voice test yet.
      `.trim(),
      input: speechResult,
    });

    const answer =
      aiResponse.output_text?.trim() ||
      "I'm sorry, I didn't understand that. Could you say that again?";

    console.log("AnaAI voice response:", answer);

    addSpeechGather(response, answer);

    response.say(
      {
        voice: "alice",
      },
      "Thanks for calling. Goodbye."
    );

    return twimlResponse(response.toString());
  } catch (error: unknown) {
    console.error("AnaAI voice webhook error:", error);

    const response = new twilio.twiml.VoiceResponse();

    response.say(
      {
        voice: "alice",
      },
      "I'm sorry, I'm having trouble responding right now."
    );

    return twimlResponse(response.toString());
  }
}

export async function GET() {
  const response = new twilio.twiml.VoiceResponse();

  addSpeechGather(
    response,
    "This is AnaAI. How can I help you today?"
  );

  response.say(
    {
      voice: "alice",
    },
    "I didn't hear anything. Goodbye."
  );

  return twimlResponse(response.toString());
}