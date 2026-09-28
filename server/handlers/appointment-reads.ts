import { resolveBusinessContext } from "@/lib/business-context";
import { isUuid } from "@/lib/appointment-actions";
import { createSupabaseServiceClient } from "@/lib/supabase-server";
import { bearerToken, missingAuthentication, readFailure, readJson, validLocalDate } from "../read-api";

const appointmentFields = "id, customer_id, service_id, customer_name, service, appointment_date, appointment_time, status, duration_minutes, notes";
const unavailable = new Set(["SLOT_CONFLICT", "OUTSIDE_HOURS"]);
const failures = new Set(["CLOSED", "INVALID_HOURS", "INVALID_DURATION", "INVALID_SERVICE", "INVALID_CUSTOMER", "INVALID_EXISTING_SCHEDULE", "APPOINTMENT_NOT_FOUND", "TERMINAL_APPOINTMENT", "SOURCE_DATE_CHANGED", "FORBIDDEN", "UNAUTHORIZED"]);
type ReadKind = "day" | "customers" | "services" | "availability";

// All reads use the verified member's client/RLS. Only the existing new-booking
// checker uses a server client, AFTER membership and service scoping succeed.
async function read(request: Request, kind: ReadKind) {
  const token = bearerToken(request);
  if (!token) return missingAuthentication();
  try {
    const resolved = await resolveBusinessContext({ accessToken: token,
      requestedBusinessId: request.headers.get("x-anaai-business-id")?.trim() || null });
    if (!resolved.success) return readFailure(resolved.status, resolved.code, resolved.error);
    const { db, context } = resolved;
    const businessId = context.businessId;
    const params = new URL(request.url).searchParams;
    const allowed = kind === "day" ? ["date"] : kind === "customers" ? ["q", "offset"]
      : kind === "services" ? [] : ["date", "serviceId", "appointmentId"];
    if ([...params.keys()].some((key) => !allowed.includes(key) || params.getAll(key).length !== 1)) {
      return readFailure(400, "INVALID_REQUEST", "Unsupported query parameters.");
    }
    if (kind === "day") {
      const date = params.get("date");
      if (!validLocalDate(date)) return readFailure(400, "INVALID_SCHEDULE", "Select a valid date.");
      const appointments = [];
      for (let offset = 0; ; offset += 500) {
        const { data, error } = await db.from("appointments").select(appointmentFields)
          .eq("business_id", businessId).eq("appointment_date", date)
          .order("appointment_time").order("id").range(offset, offset + 499);
        if (error) throw new Error();
        appointments.push(...(data ?? []));
        if (!data || data.length < 500) break;
      }
      return readJson({ success: true, businessId, date, appointments });
    }
    if (kind === "customers") {
      const q = (params.get("q") || "").trim();
      const rawOffset = params.get("offset") || "0";
      if (q.length > 100 || !/^\d{1,6}$/.test(rawOffset)) return readFailure(400, "INVALID_REQUEST", "Invalid customer search.");
      const offset = Number(rawOffset);
      let query = db.from("customers").select("id, full_name, phone")
        .eq("business_id", businessId).eq("is_active", true);
      // Escape LIKE wildcards; never interpolate a PostgREST .or expression.
      if (q) query = query.ilike("full_name", `%${q.replace(/[\\%_]/g, "\\$&")}%`);
      const { data, error } = await query.order("full_name").order("id").range(offset, offset + 24);
      if (error) throw new Error();
      return readJson({ success: true, businessId, customers: data ?? [], nextOffset: data?.length === 25 ? offset + 25 : null });
    }
    if (kind === "services") {
      const services = [];
      for (let offset = 0; ; offset += 500) {
        const { data, error } = await db.from("services").select("id, name, duration_minutes")
          .eq("business_id", businessId).eq("is_active", true).order("name").order("id").range(offset, offset + 499);
        if (error) throw new Error();
        services.push(...(data ?? []));
        if (!data || data.length < 500) break;
      }
      return readJson({ success: true, businessId, services });
    }
    const date = params.get("date");
    const serviceId = params.get("serviceId");
    const appointmentId = params.get("appointmentId");
    if (!validLocalDate(date) || !isUuid(serviceId) || (appointmentId !== null && !isUuid(appointmentId))) {
      return readFailure(400, "INVALID_REQUEST", "Select a valid service, date and appointment.");
    }
    const service = await db.from("services").select("id, duration_minutes")
      .eq("business_id", businessId).eq("id", serviceId).eq("is_active", true).maybeSingle();
    if (service.error) throw new Error();
    if (!service.data) return readFailure(400, "INVALID_SERVICE", "Select an active service.");
    const durationMinutes = service.data.duration_minutes;
    let customerId: string | null = null;
    let currentTime: string | null = null;
    if (appointmentId) {
      const target = await db.from("appointments").select("id, customer_id, service_id, appointment_time, appointment_date")
        .eq("business_id", businessId).eq("id", appointmentId).maybeSingle();
      if (target.error) throw new Error();
      if (!target.data) return readFailure(404, "APPOINTMENT_NOT_FOUND", "Appointment not found.");
      if (target.data.service_id !== serviceId) return readFailure(400, "INVALID_SERVICE", "Keep the appointment's service when rescheduling.");
      customerId = target.data.customer_id;
      if (target.data.appointment_date === date) currentTime = target.data.appointment_time;
    }
    const checker = appointmentId ? db : createSupabaseServiceClient();
    // Candidate grid is presentation only. EVERY offered start is approved by
    // SQL; no JavaScript hours, duration, overlap, or capacity decisions.
    const candidates = Array.from({ length: 96 }, (_, i) => `${String(Math.floor(i / 4)).padStart(2, "0")}:${String((i % 4) * 15).padStart(2, "0")}:00`);
    if (currentTime && /^\d{2}:\d{2}:\d{2}$/.test(currentTime) && !candidates.includes(currentTime)) candidates.push(currentTime);
    const slots: string[] = [];
    let stopCode: string | null = null;
    // Bounded concurrency; requests are advisory checks, never reservations.
    for (let start = 0; start < candidates.length && !stopCode; start += 4) {
      if (request.signal.aborted) return readFailure(499, "CANCELLED", "Request cancelled.");
      const results = await Promise.all(candidates.slice(start, start + 4).map(async (time) => {
        const { data, error } = await checker.rpc(appointmentId ? "check_reschedule_appointment_business" : "voice_check_appointment_availability", {
          p_business_id: businessId, p_service_id: serviceId, p_appointment_date: date, p_appointment_time: time,
          ...(appointmentId ? { p_appointment_id: appointmentId, p_customer_id: customerId } : {}),
        });
        if (error) throw new Error();
        if (data?.code === "AVAILABLE" && (appointmentId ? data.success === true : data.available === true)) {
          // Fail closed on a malformed/mismatched checker result. The new
          // wrapper returns the core's minimal result; the older checker also
          // echoes its schedule, which must match this request exactly.
          if (!Number.isInteger(data.duration_minutes) || data.duration_minutes <= 0 ||
              data.duration_minutes !== durationMinutes ||
              (!appointmentId && (data.service_id !== serviceId || data.date !== date || data.time !== time))) {
            return { time, code: "INTERNAL_ERROR" };
          }
          return { time, code: "AVAILABLE" };
        }
        const code = typeof data?.code === "string" && (unavailable.has(data.code) || failures.has(data.code)) ? data.code : "INTERNAL_ERROR";
        return { time, code };
      }));
      for (const result of results) {
        if (result.code === "AVAILABLE") slots.push(result.time);
        else if (!unavailable.has(result.code)) stopCode = result.code;
      }
    }
    if (stopCode && stopCode !== "CLOSED") {
      return readFailure(stopCode === "UNAUTHORIZED" ? 401 : stopCode === "FORBIDDEN" ? 403 : stopCode === "INTERNAL_ERROR" ? 503 : 409,
        stopCode, "Availability could not be verified. Refresh and try again.");
    }
    return readJson({ success: true, businessId, date, serviceId, appointmentId,
      durationMinutes,
      code: stopCode === "CLOSED" ? "CLOSED" : slots.length ? "AVAILABLE" : "NO_AVAILABILITY",
      slots: stopCode ? [] : slots.sort() });
  } catch {
    return readFailure(503, "SERVICE_UNAVAILABLE", "Unable to load appointment data. Please retry.");
  }
}
export const DAY = (request: Request) => read(request, "day");
export const CUSTOMERS = (request: Request) => read(request, "customers");
export const SERVICES = (request: Request) => read(request, "services");
export const AVAILABILITY = (request: Request) => read(request, "availability");
