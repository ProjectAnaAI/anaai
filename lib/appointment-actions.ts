import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  canonicalTime,
  validDate,
} from "./ai-actions";
import { sendSms } from "./twilio";

export const isUuid = (
  value: unknown
): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value
  );

function canonical(
  value: unknown
): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }

  if (
    value &&
    typeof value === "object"
  ) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) =>
          a.localeCompare(b)
        )
        .map(([key, current]) => [
          key,
          canonical(current),
        ])
    );
  }

  return value;
}

export function fingerprint(
  value: unknown
) {
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonical(value)
      )
    )
    .digest("hex");
}

function phone(value: unknown) {
  if (typeof value !== "string") {
    return value;
  }

  const digits =
    value.replace(/\D/g, "");

  if (digits.length === 10) {
    return `+1${digits}`;
  }

  if (
    digits.length === 11 &&
    digits.startsWith("1")
  ) {
    return `+${digits}`;
  }

  return value.trim().startsWith("+")
    ? `+${digits}`
    : digits;
}

export function schedulingIntent(
  input: Record<string, unknown>
) {
  if (
    !isUuid(input.service_id) ||
    !validDate(input.date) ||
    !canonicalTime(input.time)
  ) {
    throw new Error(
      "Invalid schedule."
    );
  }

  return {
    ...input,

    ...(input.customer_phone !==
    undefined
      ? {
          customer_phone: phone(
            input.customer_phone
          ),

          customer_name:
            typeof input.customer_name ===
            "string"
              ? input.customer_name.trim()
              : input.customer_name,

          customer_email:
            typeof input.customer_email ===
            "string"
              ? input.customer_email.trim() ||
                null
              : null,
        }
      : {}),

    service_id:
      input.service_id.toLowerCase(),

    customer_id:
      typeof input.customer_id ===
      "string"
        ? input.customer_id.toLowerCase()
        : null,

    appointment_id:
      typeof input.appointment_id ===
      "string"
        ? input.appointment_id.toLowerCase()
        : null,

    time: canonicalTime(
      input.time
    ),

    notes:
      typeof input.notes ===
      "string"
        ? input.notes.trim() || null
        : null,
  };
}

export type ActionReceipt = {
  success: true;
  changed: boolean;
  replayed: boolean;
  action_id: string;
  action_type: string;
  business_id: string;
  appointment_id: string;
  receipt_scope: "action_outcome";
  code: string;
  status: string;
  appointment: Record<
    string,
    unknown
  >;
};

export function actionReceipt(
  value: unknown,
  businessId: string,
  action: string,
  target?: string
): ActionReceipt | null {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return null;
  }

  const receipt =
    value as ActionReceipt;

  if (
    receipt.success !== true ||
    typeof receipt.changed !==
      "boolean" ||
    typeof receipt.replayed !==
      "boolean" ||
    !isUuid(receipt.action_id) ||
    !isUuid(receipt.business_id) ||
    !isUuid(
      receipt.appointment_id
    ) ||
    receipt.business_id !==
      businessId ||
    receipt.action_type !==
      action ||
    receipt.receipt_scope !==
      "action_outcome" ||
    (target &&
      receipt.appointment_id !==
        target) ||
    !receipt.appointment ||
    receipt.appointment.id !==
      receipt.appointment_id ||
    receipt.appointment
      .business_id !==
      businessId ||
    receipt.appointment.status !==
      receipt.status
  ) {
    return null;
  }

  if (
    receipt.code !==
    (receipt.changed
      ? "APPLIED"
      : "ALREADY_IN_TARGET_STATE")
  ) {
    return null;
  }

  if (
    (action === "confirm" &&
      receipt.status !==
        "Confirmed") ||
    (action === "cancel" &&
      receipt.status !==
        "Cancelled") ||
    (action === "complete" &&
      receipt.status !==
        "Completed") ||
    (action === "book" &&
      receipt.status !==
        "Booked") ||
    (action === "reschedule" &&
      ![
        "Booked",
        "Confirmed",
      ].includes(receipt.status))
  ) {
    return null;
  }

  return receipt;
}

export function actionMessage(
  receipt: ActionReceipt
) {
  if (receipt.replayed) {
    return "The original appointment action succeeded. No new change was made by this retry. Refresh to see its current state.";
  }

  if (!receipt.changed) {
    return "The appointment is already in the requested state. No new change was made.";
  }

  const messages: Record<
    string,
    string
  > = {
    book:
      "Appointment booked successfully.",
    reschedule:
      "Appointment updated successfully.",
    confirm:
      "Appointment confirmed successfully.",
    cancel:
      "Appointment cancelled successfully.",
    complete:
      "Appointment marked completed.",
  };

  return (
    messages[
      receipt.action_type
    ] ||
    "Appointment action succeeded."
  );
}

// A failed or uncertain delivery must never change
// a committed appointment action outcome.
export async function deliverActionNotification(
  db: SupabaseClient,
  businessId: string,
  actionId: string
): Promise<boolean> {
  try {
    const {
      data: claim,
      error,
    } = await db.rpc(
      "claim_appointment_notification",
      {
        p_business_id:
          businessId,
        p_action_id: actionId,
      }
    );

    if (
      error ||
      claim?.claimed !== true ||
      !isUuid(claim.id) ||
      !isUuid(claim.token)
    ) {
      return false;
    }

    const payload =
      claim.payload;

    const words: Record<
      string,
      string
    > = {
      confirmation: "confirmed",
      cancellation: "cancelled",
      reschedule: "updated",
    };

    if (
      !payload ||
      typeof payload.phone !==
        "string" ||
      !payload.phone.trim() ||
      !words[claim.kind]
    ) {
      await db.rpc(
        "finish_appointment_notification",
        {
          p_business_id:
            businessId,

          p_notification_id:
            claim.id,

          p_claim_token:
            claim.token,

          p_status: "failed",

          p_provider_id: null,
        }
      );

      return false;
    }

    const wording =
      payload.action === "book"
        ? "booked"
        : words[claim.kind];

    const sent = await sendSms({
      to: payload.phone,

      body:
        `Your appointment has been ${wording}. ` +
        `Date: ${String(
          payload.date || ""
        )}. ` +
        `Time: ${String(
          payload.time || ""
        )}.`,
    });

    const status =
      sent.success
        ? "accepted"
        : sent.outcome === "failed"
          ? "failed"
          : "uncertain";

    const {
      data: recorded,
      error: recordError,
    } = await db.rpc(
      "finish_appointment_notification",
      {
        p_business_id:
          businessId,

        p_notification_id:
          claim.id,

        p_claim_token:
          claim.token,

        p_status: status,

        p_provider_id:
          sent.success
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
    return false;
  }
}