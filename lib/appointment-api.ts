import { activeBusinessHeaders } from "@/lib/active-business";

/**
 * Transport for authoritative appointment mutations.
 *
 * The browser only expresses intent here. Business hours, timezone, service
 * duration, appointment capacity, conflicts, customer/service validity,
 * lifecycle rules and concurrency protection are all enforced by the
 * /api/appointments handler and its database RPCs. Nothing in this module
 * decides whether a booking is allowed.
 */

export type AppointmentNotificationType =
  | "confirm"
  | "reschedule"
  | "cancel"
  | "complete"
  | "none";

export type AppointmentMutationResponse = {
  message?: string;
  success?: boolean;
  error?: string;
  sms_sent?: boolean;
  sms_error?: string | null;
};

export type AppointmentMutationInput = {
  accessToken: string;
  businessId: string;
  idempotencyKey: string;
  updates: Record<string, string | null>;
  notificationType: AppointmentNotificationType;
  appointmentId?: string;
  creating?: boolean;
};

export async function sendAppointmentMutation({
  accessToken,
  businessId,
  idempotencyKey,
  updates,
  notificationType,
  appointmentId,
  creating = false,
}: AppointmentMutationInput): Promise<AppointmentMutationResponse> {
  const response = await fetch("/api/appointments", {
    method: creating ? "POST" : "PATCH",

    headers: {
      "Idempotency-Key": idempotencyKey,

      ...activeBusinessHeaders(),

      "x-anaai-business-id": businessId,

      "Content-Type": "application/json",

      Authorization: `Bearer ${accessToken}`,
    },

    body: JSON.stringify({
      appointmentId,
      ...updates,
      notificationType,
    }),
  });

  const result = (await response.json()) as AppointmentMutationResponse;

  if (!response.ok || result?.success !== true) {
    throw new Error(result?.error || "Appointment update failed.");
  }

  return result;
}
