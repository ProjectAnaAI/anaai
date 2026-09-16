import twilio from "twilio";

type SendSmsResult =
  | {
      success: true;
      messageSid: string;
    }
  | {
      success: false;
      error: string;
      outcome?: "failed" | "uncertain";
    };

type TwilioProviderError = Error & {
  code?: number;
  status?: number;
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

function providerErrorDetails(error: unknown) {
  if (!(error instanceof Error)) {
    return {
      code: null,
      status: null,
    };
  }

  const providerError = error as TwilioProviderError;

  return {
    code:
      typeof providerError.code === "number" &&
      Number.isSafeInteger(providerError.code) && providerError.code > 0
        ? providerError.code
        : null,
    status:
      typeof providerError.status === "number" &&
      Number.isInteger(providerError.status) &&
      providerError.status >= 100 && providerError.status <= 599
        ? providerError.status
        : null,
  };
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
      outcome: "failed",
      error: "Twilio configuration is missing.",
    };
  }

  if (!to.trim()) {
    return {
      success: false,
      outcome: "failed",
      error: "SMS recipient phone number is missing.",
    };
  }

  if (!body.trim()) {
    return {
      success: false,
      outcome: "failed",
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

    // A resolved SDK promise alone is not an authoritative acceptance receipt.
    if (typeof message?.sid !== "string" || !/^SM[0-9a-fA-F]{32}$/.test(message.sid)) {
      console.error("AnaAI SMS provider acceptance could not be verified.");
      return { success: false, outcome: "uncertain", error: "SMS acceptance could not be verified." };
    }

    console.log("AnaAI SMS submitted.");

    return {
      success: true,
      messageSid: message.sid,
    };
  } catch (error: unknown) {
    const details = providerErrorDetails(error);

    console.error("AnaAI SMS provider request failed.", {
      code: details.code,
      status: details.status,
    });

    return {
      success: false,
      error: "SMS provider request failed.",
      // RestException represents an actual HTTP response in the installed SDK.
      // A 4xx rejection did not accept the message (including rate limiting).
      // Keep request timeouts, transport errors and 5xx conservative: no resend.
      outcome: error instanceof twilio.RestException &&
        details.status !== null && details.status >= 400 && details.status < 500 &&
        details.status !== 408 ? "failed" : "uncertain",
    };
  }
}