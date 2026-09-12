import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

import { sendSms } from "@/lib/twilio";

export const runtime = "nodejs";

type AppointmentUpdateBody = {
  appointmentId?: string;
  customerId?: string;
  serviceId?: string;
  customerName?: string;
  customerPhone?: string | null;
  customerEmail?: string | null;
  service?: string;
  appointmentDate?: string;
  appointmentTime?: string;
  notes?: string | null;
  status?: string;
  notificationType?: "confirm" | "reschedule" | "cancel" | "none";
};

type ExistingAppointment = {
  id: string;
  customer_name: string;
  customer_phone: string | null;
  customer_email: string | null;
  service: string | null;
  appointment_date: string | null;
  appointment_time: string | null;
  status: string | null;
};

function normalizeTime(value: string | null) {
  if (!value) {
    return "";
  }

  const match = value.match(/^(\d{1,2}):(\d{2})/);

  if (!match) {
    return value;
  }

  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

function formatSmsDate(date: string | null) {
  if (!date) {
    return "Not specified";
  }

  const parsed = new Date(`${date}T12:00:00Z`);

  if (Number.isNaN(parsed.getTime())) {
    return date;
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(parsed);
}

function formatSmsTime(time: string | null) {
  if (!time) {
    return "Not specified";
  }

  const normalized = normalizeTime(time);
  const [hourText, minuteText] = normalized.split(":");

  const hour = Number(hourText);
  const minute = Number(minuteText);

  if (Number.isNaN(hour) || Number.isNaN(minute)) {
    return time;
  }

  const period = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;

  return `${displayHour}:${String(minute).padStart(2, "0")} ${period}`;
}

function buildSms({
  notificationType,
  businessName,
  businessAddress,
  customerName,
  service,
  appointmentDate,
  appointmentTime,
}: {
  notificationType: "confirm" | "reschedule" | "cancel";
  businessName: string;
  businessAddress: string | null;
  customerName: string;
  service: string | null;
  appointmentDate: string | null;
  appointmentTime: string | null;
}) {
  const date = formatSmsDate(appointmentDate);
  const time = formatSmsTime(appointmentTime);
  const serviceName = service || "Appointment";

  if (notificationType === "confirm") {
    const lines = [
      `Hi ${customerName}, your appointment with ${businessName} is confirmed.`,
      `Service: ${serviceName}`,
      `Date: ${date}`,
      `Time: ${time}`,
    ];

    if (businessAddress?.trim()) {
      lines.push(`Location: ${businessAddress.trim()}`);
    }

    return lines.join("\n");
  }

  if (notificationType === "reschedule") {
    const lines = [
      `Hi ${customerName}, your appointment with ${businessName} has been updated.`,
      `Service: ${serviceName}`,
      `New date: ${date}`,
      `New time: ${time}`,
    ];

    if (businessAddress?.trim()) {
      lines.push(`Location: ${businessAddress.trim()}`);
    }

    return lines.join("\n");
  }

  return [
    `Hi ${customerName}, your appointment with ${businessName} has been cancelled.`,
    `Service: ${serviceName}`,
    `Date: ${date}`,
    `Time: ${time}`,
  ].join("\n");
}

export async function PATCH(request: Request) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseAnonKey) {
      return NextResponse.json(
        {
          error: "Supabase environment variables are missing.",
        },
        {
          status: 500,
        }
      );
    }

    const authorization = request.headers.get("authorization");

    if (!authorization) {
      return NextResponse.json(
        {
          error: "Authorization header is missing.",
        },
        {
          status: 401,
        }
      );
    }

    const [scheme, accessToken] = authorization.split(" ");

    if (scheme?.toLowerCase() !== "bearer" || !accessToken) {
      return NextResponse.json(
        {
          error: "Invalid authorization header.",
        },
        {
          status: 401,
        }
      );
    }

    const authClient = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const {
      data: { user },
      error: userError,
    } = await authClient.auth.getUser(accessToken);

    if (userError || !user) {
      return NextResponse.json(
        {
          error: "Your session could not be verified.",
        },
        {
          status: 401,
        }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const body = (await request.json()) as AppointmentUpdateBody;

    const appointmentId = body.appointmentId?.trim();

    if (!appointmentId) {
      return NextResponse.json(
        {
          error: "Appointment ID is required.",
        },
        {
          status: 400,
        }
      );
    }

    const { data: existingData, error: existingError } = await supabase
      .from("appointments")
      .select(
        "id, customer_name, customer_phone, customer_email, service, appointment_date, appointment_time, status"
      )
      .eq("id", appointmentId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (existingError) {
      return NextResponse.json(
        {
          error: existingError.message,
        },
        {
          status: 500,
        }
      );
    }

    if (!existingData) {
      return NextResponse.json(
        {
          error: "Appointment not found.",
        },
        {
          status: 404,
        }
      );
    }

    const existing = existingData as ExistingAppointment;

    const updates: Record<string, string | null> = {};

    if (typeof body.customerId === "string") {
      updates.customer_id = body.customerId;
    }

    if (typeof body.serviceId === "string") {
      updates.service_id = body.serviceId;
    }

    if (typeof body.customerName === "string") {
      updates.customer_name = body.customerName.trim();
    }

    if (
      typeof body.customerPhone === "string" ||
      body.customerPhone === null
    ) {
      updates.customer_phone = body.customerPhone?.trim() || null;
    }

    if (
      typeof body.customerEmail === "string" ||
      body.customerEmail === null
    ) {
      updates.customer_email = body.customerEmail?.trim() || null;
    }

    if (typeof body.service === "string") {
      updates.service = body.service.trim();
    }

    if (typeof body.appointmentDate === "string") {
      updates.appointment_date = body.appointmentDate.trim();
    }

    if (typeof body.appointmentTime === "string") {
      updates.appointment_time = normalizeTime(
        body.appointmentTime.trim()
      );
    }

    if (
      typeof body.notes === "string" ||
      body.notes === null
    ) {
      updates.notes = body.notes?.trim() || null;
    }

    if (typeof body.status === "string") {
      updates.status = body.status.trim();
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json(
        {
          error: "No appointment changes were provided.",
        },
        {
          status: 400,
        }
      );
    }

    const { data: updatedData, error: updateError } = await supabase
      .from("appointments")
      .update(updates)
      .eq("id", appointmentId)
      .eq("user_id", user.id)
      .select(
        "id, customer_name, customer_phone, customer_email, service, appointment_date, appointment_time, status"
      )
      .single();

    if (updateError) {
      return NextResponse.json(
        {
          error: updateError.message,
        },
        {
          status: 500,
        }
      );
    }

    const notificationType = body.notificationType || "none";

    let smsSent = false;
    let smsError: string | null = null;

    if (
      notificationType === "confirm" ||
      notificationType === "reschedule" ||
      notificationType === "cancel"
    ) {
      const customerPhone = updatedData.customer_phone?.trim();

      if (!customerPhone) {
        smsError = "Customer phone number is missing.";
      } else {
        const { data: businessData } = await supabase
          .from("business_profiles")
          .select("business_name, address")
          .eq("user_id", user.id)
          .order("created_at", {
            ascending: false,
          })
          .limit(1)
          .maybeSingle();

        const businessName =
          businessData?.business_name?.trim() || "the business";

        const smsBody = buildSms({
          notificationType,
          businessName,
          businessAddress: businessData?.address?.trim() || null,
          customerName:
            updatedData.customer_name || existing.customer_name,
          service: updatedData.service || existing.service,
          appointmentDate:
            updatedData.appointment_date ||
            existing.appointment_date,
          appointmentTime:
            updatedData.appointment_time ||
            existing.appointment_time,
        });

        const smsResult = await sendSms({
          to: customerPhone,
          body: smsBody,
        });

        if (smsResult.success) {
          smsSent = true;

          console.log("AnaAI appointment update SMS sent:", {
            appointmentId,
            notificationType,
            messageSid: smsResult.messageSid,
          });
        } else {
          smsError = smsResult.error;

          console.error(
            "AnaAI appointment updated but SMS failed:",
            {
              appointmentId,
              notificationType,
              error: smsResult.error,
            }
          );
        }
      }
    }

    return NextResponse.json({
      success: true,
      appointment: updatedData,
      notification_type: notificationType,
      sms_sent: smsSent,
      sms_error: smsError,
    });
  } catch (error: unknown) {
    console.error("Appointment update API error:", error);

    if (error instanceof Error) {
      return NextResponse.json(
        {
          error: error.message,
        },
        {
          status: 500,
        }
      );
    }

    return NextResponse.json(
      {
        error: "An unexpected appointment update error occurred.",
      },
      {
        status: 500,
      }
    );
  }
}