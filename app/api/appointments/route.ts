import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

import { resolveBusinessContext } from "@/lib/business-context";
import { sendSms } from "@/lib/twilio";

export const runtime = "nodejs";

type AppointmentUpdateBody = {
  appointmentId?: string;
  customerId?: string;
  customer_id?: string;
  serviceId?: string;
  service_id?: string;
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

const schedulingErrors: Record<string, [number, string]> = {
  UNAUTHORIZED: [401, "Please log in again."],
  FORBIDDEN: [403, "Business access is not available."],
  INVALID_CUSTOMER: [400, "Customer reference is not available for this business."],
  INVALID_SERVICE: [400, "Select an active service available for this business."],
  INVALID_DURATION: [400, "The service does not have a valid duration."],
  INVALID_SCHEDULE: [400, "Select a valid appointment date and time."],
  INVALID_HOURS: [400, "Business hours are not configured correctly."],
  CLOSED: [409, "The business is closed on the selected day."],
  OUTSIDE_HOURS: [409, "The appointment must fit within business hours."],
  SOURCE_DATE_CHANGED: [409, "This appointment was moved by another request. Refresh and try again."],
  SLOT_CONFLICT: [409, "That time is no longer available. Please choose another time."],
  INVALID_EXISTING_SCHEDULE: [409, "The calendar contains an appointment that cannot be safely checked."],
  APPOINTMENT_NOT_FOUND: [404, "Appointment not found."],
  TERMINAL_APPOINTMENT: [409, "Only Booked or Confirmed appointments can be rescheduled."],
};

async function runAtomicScheduling(
  supabase: SupabaseClient,
  businessId: string,
  body: AppointmentUpdateBody,
  appointmentId?: string
): Promise<{ response: NextResponse } | { appointment: ExistingAppointment }> {
  const ids: Record<string, string> = {};
  for (const [camel, snake] of [["customerId", "customer_id"], ["serviceId", "service_id"]] as const) {
    const values = [body[camel], body[snake]].filter((value) => value !== undefined);
    if (!values.length || values.some((value) => typeof value !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim())) ||
      values.some((value) => value!.trim().toLowerCase() !== values[0]!.trim().toLowerCase())) {
      return { response: NextResponse.json({ error: "Select valid customer and service references." }, { status: 400 }) };
    }
    ids[snake] = values[0]!.trim();
  }
  if (typeof body.appointmentDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.appointmentDate) ||
      typeof body.appointmentTime !== "string" || !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(body.appointmentTime) ||
      (body.notes !== undefined && body.notes !== null && typeof body.notes !== "string") ||
      body.status !== undefined) {
    return { response: NextResponse.json({ error: "Provide a valid schedule and notes without a status change." }, { status: 400 }) };
  }
  const { data, error } = await supabase.rpc(
    appointmentId ? "reschedule_appointment_atomic_business" : "create_appointment_atomic_business",
    {
      p_business_id: businessId,
      ...(appointmentId ? { p_appointment_id: appointmentId } : {}),
      p_customer_id: ids.customer_id,
      p_service_id: ids.service_id,
      p_appointment_date: body.appointmentDate,
      p_appointment_time: body.appointmentTime,
      p_notes: body.notes?.trim() || null,
    }
  );
  if (error || data?.success !== true || !data?.appointment?.id) {
    const safeFailure = !error && data?.success === false && schedulingErrors[data.code];
    const schedulingRpcCode = typeof data?.code === "string" && (
      Object.prototype.hasOwnProperty.call(schedulingErrors, data.code) ||
      ["INTERNAL_ERROR", "UNSUPPORTED_ISOLATION"].includes(data.code)
    ) ? data.code : "INTERNAL_ERROR";
    if (!safeFailure) console.error({ schedulingRpcCode });
    const [status, message]: [number, string] = safeFailure || [500, "Unable to save the appointment. Check your appointments before retrying."];
    return { response: NextResponse.json({ success: false, error: message }, { status }) };
  }
  return { appointment: data.appointment as ExistingAppointment };
}

export async function POST(request: Request) {
  return handleAppointmentRequest(request, true);
}

export async function PATCH(request: Request) {
  return handleAppointmentRequest(request, false);
}

async function handleAppointmentRequest(request: Request, creating: boolean) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseAnonKey) {
      console.error("Appointment API Supabase configuration is missing.");
      return NextResponse.json(
        {
          error: "Appointment updates are temporarily unavailable.",
        },
        {
          status: 500,
        }
      );
    }

    const authorization = request.headers.get("authorization");

    if (!authorization?.startsWith("Bearer ")) {
      return NextResponse.json(
        {
          error: "Invalid authorization header.",
        },
        {
          status: 401,
        }
      );
    }

    const accessToken = authorization.slice("Bearer ".length).trim();

    if (!accessToken) {
      return NextResponse.json(
        {
          error: "Authorization token is missing.",
        },
        {
          status: 401,
        }
      );
    }

    const businessContextResult = await resolveBusinessContext({
      accessToken,
      requestedBusinessId: request.headers.get("x-anaai-business-id")?.trim() || null,
    });

    if (!businessContextResult.success) {
      if (businessContextResult.status >= 500) {
        console.error("Appointment business context failed:", businessContextResult);
      }
      return NextResponse.json(
        {
          error: businessContextResult.status >= 500
            ? "Unable to load appointment context. Please try again."
            : businessContextResult.error,
          code: businessContextResult.code,
        },
        {
          status: businessContextResult.status,
        }
      );
    }

    const { businessId } = businessContextResult.context;

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

    let body: AppointmentUpdateBody;
    try {
      body = await request.json();
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid body");
    } catch {
      return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
    }

    if (creating) {
      const result = await runAtomicScheduling(supabase, businessId, body);
      if ("response" in result) return result.response;
      // Manual creation retains its current no-SMS behavior.
      return NextResponse.json({ success: true, appointment: result.appointment, sms_sent: false });
    }

    const appointmentId = typeof body.appointmentId === "string" ? body.appointmentId.trim() : "";

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
      .eq("business_id", businessId)
      .maybeSingle();

    if (existingError) {
      console.error("Appointment lookup failed:", existingError);
      return NextResponse.json(
        {
          error: "Unable to load the appointment. Please try again.",
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

    const schedulingChange = ["customerId", "customer_id", "serviceId", "service_id", "appointmentDate", "appointmentTime"]
      .some((key) => Object.prototype.hasOwnProperty.call(body, key));
    let updatedData: ExistingAppointment;
    if (schedulingChange) {
      const result = await runAtomicScheduling(supabase, businessId, body, appointmentId);
      if ("response" in result) return result.response;
      updatedData = result.appointment;
    } else {
      // Existing confirmation/cancellation and metadata-only behavior.
      const updates: Record<string, string | null> = {};
      for (const [key, column] of [
        ["customerName", "customer_name"], ["customerPhone", "customer_phone"],
        ["customerEmail", "customer_email"], ["service", "service"],
        ["notes", "notes"], ["status", "status"],
      ] as const) {
        const value = body[key];
        if (typeof value === "string") updates[column] = ["customerPhone", "customerEmail", "notes"].includes(key) ? value.trim() || null : value.trim();
        else if (value === null && ["customerPhone", "customerEmail", "notes"].includes(key)) updates[column] = null;
      }
      if (!Object.keys(updates).length) {
        return NextResponse.json({ error: "No appointment changes were provided." }, { status: 400 });
      }
      const { data, error } = await supabase.from("appointments").update(updates)
        .eq("id", appointmentId).eq("business_id", businessId)
        .select("id, customer_name, customer_phone, customer_email, service, appointment_date, appointment_time, status")
        .single();
      if (error) {
        console.error("Appointment update failed:", error);
        return NextResponse.json({ error: "Unable to update the appointment. Please try again." }, { status: 500 });
      }
      updatedData = data as ExistingAppointment;
    }

    const notificationType = body.notificationType || "none";

    let smsSent = false;
    let smsError: string | null = null;

    try {
      if (
        notificationType === "confirm" ||
        notificationType === "reschedule" ||
        notificationType === "cancel"
      ) {
        const customerPhone = updatedData.customer_phone?.trim();

        if (!customerPhone) {
          smsError = "Customer phone number is missing.";
        } else {
          const { data: businessData, error: businessError } =
            await supabase
              .from("business_profiles")
              .select("business_name, address")
              .eq("business_id", businessId)
              .order("created_at", {
                ascending: false,
              })
              .limit(1)
              .maybeSingle();

          if (businessError) {
            console.error(
              "AnaAI business profile lookup failed during SMS:",
              businessError
            );
          }

          const businessName =
            businessData?.business_name?.trim() ||
            businessContextResult.context.businessName ||
            "the business";

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
            smsError = "The appointment was saved, but the SMS could not be sent.";

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

    } catch (error) {
      console.error("Appointment saved but notification failed:", error);
      smsError = "The appointment was saved, but the SMS could not be sent.";
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

    return NextResponse.json(
      {
        error: "Unable to complete the appointment request. Please try again.",
      },
      {
        status: 500,
      }
    );
  }
}