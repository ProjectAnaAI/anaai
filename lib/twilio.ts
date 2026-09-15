import twilio from "twilio";

type SendSmsResult =
  | {
      success: true;
      messageSid: string;
    }
  | {
      success: false;
      error: string;
    };

function normalizePhoneNumber(phone: string) {
  const trimmed = phone.trim();

  if (trimmed.startsWith("+")) {
    return trimmed;
  }

  const digits = trimmed.replace(/\D/g, "");

  if (digits.length === 10) {
    return `+1${digits}`;
  }

  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }

  return trimmed;
}

export async function sendSms({
  to,
  body,
}: {
  to: string;
  body: string;
}): Promise<SendSmsResult> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;

  if (!accountSid || !authToken || !fromNumber) {
    console.error("AnaAI SMS configuration missing.");

    return {
      success: false,
      error: "Twilio configuration is missing.",
    };
  }

  if (!to.trim()) {
    return {
      success: false,
      error: "SMS recipient phone number is missing.",
    };
  }

  if (!body.trim()) {
    return {
      success: false,
      error: "SMS message body is empty.",
    };
  }

  try {
    const client = twilio(accountSid, authToken);

    const normalizedPhone = normalizePhoneNumber(to);

    const message = await client.messages.create({
      from: fromNumber,
      to: normalizedPhone,
      body: body.trim(),
    });

    console.log("AnaAI SMS submitted.");

    return {
      success: true,
      messageSid: message.sid,
    };
  } catch (error: unknown) {
    console.error("AnaAI SMS provider request failed.");

    if (error instanceof Error) {
      return {
        success: false,
        error: "SMS provider request failed.",
      };
    }

    return {
      success: false,
      error: "Unknown Twilio SMS error.",
    };
  }
}