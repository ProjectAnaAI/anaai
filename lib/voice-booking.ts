import "server-only";

import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  bookingReceipt,
  bookingRejection,
  bookingRejectionReply,
  canonicalTime,
  uniqueService,
  validDate,
  type BookingReceipt,
} from "@/lib/ai-actions";
import { isUuid } from "@/lib/appointment-actions";
import { createSupabaseServiceClient } from "@/lib/supabase-server";
import { sendSms } from "@/lib/twilio";

const PHONE = /^\+[1-9]\d{7,14}$/;

type Service = {
  id: string;
  name: string;
};

type VoiceBookingRequest = {
  businessId: string;
  idempotencyKey: string;
  customerName: string;
  customerPhone: string;
  serviceId: string;
  serviceName: string;
  date: string;
  time: string;
};

export type VoiceBookingResult =
  | {
      success: true;
      replayed: boolean;
      receipt: BookingReceipt;
      smsSent: boolean;
    }
  | {
      success: false;
      message: string;
    };

function normalizePhone(value: string) {
  const trimmed = value.trim();

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

function fingerprint(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function object(
  value: unknown
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

export async function loadVoiceServices(
  businessId: string
): Promise<Service[]> {
  if (!isUuid(businessId)) {
    return [];
  }

  const db = createSupabaseServiceClient();

  const { data, error } = await db
    .from("services")
    .select("id,name")
    .eq("business_id", businessId)
    .eq("is_active", true)
    .order("name")
    .limit(50)
    .abortSignal(AbortSignal.timeout(3000));

  if (error) {
    console.error("AnaAI voice service lookup failed.");
    return [];
  }

  return (data || []).flatMap((row) => {
    if (
      !isUuid(row.id) ||
      typeof row.name !== "string" ||
      !row.name.trim()
    ) {
      return [];
    }

    return [
      {
        id: row.id,
        name: row.name.trim(),
      },
    ];
  });
}

export async function resolveVoiceService(
  businessId: string,
  spokenName: string
): Promise<Service | null> {
  const services = await loadVoiceServices(businessId);

  if (!spokenName.trim()) {
    return null;
  }

  return uniqueService(services, spokenName);
}

function voiceBookingReceipt(
  value: unknown,
  request: VoiceBookingRequest
) {
  if (!object(value)) {
    return null;
  }

  const receipt = bookingReceipt(
    value,
    request.businessId,
    request.serviceId,
    request.date,
    request.time
  );

  if (!receipt) {
    return null;
  }

  if (
    value.action_type !== "book" ||
    value.receipt_scope !== "action_outcome" ||
    value.changed !== true ||
    typeof value.replayed !== "boolean" ||
    !isUuid(value.action_id)
  ) {
    return null;
  }

  return {
    receipt,
    actionId: value.action_id,
    replayed: value.replayed,
  };
}

async function deliverVoiceNotification(
  db: SupabaseClient,
  businessId: string,
  actionId: string
): Promise<boolean> {
  try {
    const { data: claim, error } = await db.rpc(
      "voice_claim_appointment_notification",
      {
        p_business_id: businessId,
        p_action_id: actionId,
      }
    );

    if (
      error ||
      !object(claim) ||
      claim.claimed !== true ||
      !isUuid(claim.id) ||
      !isUuid(claim.token)
    ) {
      return false;
    }

    const payload = claim.payload;

    if (
      !object(payload) ||
      typeof payload.phone !== "string" ||
      !payload.phone.trim() ||
      claim.kind !== "confirmation"
    ) {
      await db.rpc(
        "voice_finish_appointment_notification",
        {
          p_business_id: businessId,
          p_notification_id: claim.id,
          p_claim_token: claim.token,
          p_status: "failed",
          p_provider_id: null,
        }
      );

      return false;
    }

    const sent = await sendSms({
      to: payload.phone,
      body:
        `Your appointment has been booked. ` +
        `Date: ${String(payload.date || "")}. ` +
        `Time: ${String(payload.time || "")}.`,
    });

    const status = sent.success
      ? "accepted"
      : sent.outcome === "failed"
        ? "failed"
        : "uncertain";

    const { data: recorded, error: recordError } =
      await db.rpc(
        "voice_finish_appointment_notification",
        {
          p_business_id: businessId,
          p_notification_id: claim.id,
          p_claim_token: claim.token,
          p_status: status,
          p_provider_id: sent.success
            ? sent.messageSid
            : null,
        }
      );

    return (
      sent.success &&
      !recordError &&
      recorded === true
    );
  } catch {
    console.error(
      "AnaAI voice notification delivery failed."
    );
    return false;
  }
}

export async function executeVoiceBooking(
  request: VoiceBookingRequest
): Promise<VoiceBookingResult> {
  const customerName = request.customerName
    .replace(/\s+/g, " ")
    .trim();

  const customerPhone = normalizePhone(
    request.customerPhone
  );

  const serviceName = request.serviceName
    .replace(/\s+/g, " ")
    .trim();

  if (
    !isUuid(request.businessId) ||
    !isUuid(request.idempotencyKey) ||
    !isUuid(request.serviceId) ||
    !customerName ||
    customerName.length > 120 ||
    !PHONE.test(customerPhone) ||
    !serviceName ||
    serviceName.length > 120 ||
    !validDate(request.date) ||
    !/^\d{2}:\d{2}$/.test(request.time) ||
    !canonicalTime(request.time)
  ) {
    return {
      success: false,
      message:
        "I couldn't verify the booking details. No appointment was booked.",
    };
  }

  const services = await loadVoiceServices(
    request.businessId
  );

  const authoritativeService = services.find(
    (service) =>
      service.id.toLowerCase() ===
      request.serviceId.toLowerCase()
  );

  if (
    !authoritativeService ||
    authoritativeService.name !== serviceName
  ) {
    return {
      success: false,
      message:
        "That service is no longer available. No appointment was booked.",
    };
  }

  const canonicalRequest = {
    operation: "voice_book",
    customer_name: customerName,
    customer_phone: customerPhone,
    customer_email: null,
    service_id: authoritativeService.id.toLowerCase(),
    date: request.date,
    time: request.time,
    notes: "Booked by AnaAI phone receptionist",
  };

  const db = createSupabaseServiceClient();

  const { data, error } = await db.rpc(
    "voice_book_appointment_business",
    {
      p_business_id: request.businessId,
      p_idempotency_key: request.idempotencyKey,
      p_request_fingerprint:
        fingerprint(canonicalRequest),
      p_customer_name: customerName,
      p_customer_phone: customerPhone,
      p_customer_email: null,
      p_service_id: authoritativeService.id,
      p_appointment_date: request.date,
      p_appointment_time: request.time,
      p_notes: null,
    }
  );

  if (error) {
    console.error("AnaAI voice booking RPC failed.");

    return {
      success: false,
      message:
        "I couldn't verify the booking. No confirmation has been given. Please check with the business before trying again.",
    };
  }

  const rejection = bookingRejection(
    data,
    request.businessId
  );

  if (rejection) {
    return {
      success: false,
      message: bookingRejectionReply(rejection),
    };
  }

  const verified = voiceBookingReceipt(
    data,
    request
  );

  if (!verified) {
    console.error(
      "AnaAI voice booking returned an unverified result."
    );

    return {
      success: false,
      message:
        "I couldn't verify the booking. No confirmation has been given. Please check with the business before trying again.",
    };
  }

  const smsSent = await deliverVoiceNotification(
    db,
    request.businessId,
    verified.actionId
  );

  return {
    success: true,
    replayed: verified.replayed,
    receipt: verified.receipt,
    smsSent,
  };
}