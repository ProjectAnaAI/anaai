import { apiGet, apiMutate, ZudeApiError } from "./api";

export type Appointment = {
  id: string; customer_id: string | null; service_id: string | null;
  customer_name: string | null; service: string | null; appointment_date: string;
  appointment_time: string | null; status: "Booked" | "Confirmed" | "Cancelled" | "Completed";
  duration_minutes: number | null; notes: string | null;
};
export type Customer = { id: string; full_name: string; phone: string | null };
export type Service = { id: string; name: string; duration_minutes: number };
export type Availability = { businessId: string; date: string; serviceId: string; appointmentId: string | null; code: "AVAILABLE" | "NO_AVAILABILITY" | "CLOSED"; durationMinutes: number; slots: string[] };
function invalid(): never { throw new ZudeApiError(0, "INVALID_RESPONSE", "Unable to verify appointment data."); }
export function validAppointment(value: Appointment): boolean {
  return !!value && typeof value.id === "string" && typeof value.appointment_date === "string" &&
    ["Booked", "Confirmed", "Cancelled", "Completed"].includes(value.status);
}
function scoped<T extends { businessId: string }>(data: T, businessId: string): T {
  if (data.businessId !== businessId) invalid();
  return data;
}
export async function getDay(businessId: string, date: string, signal: AbortSignal) {
  const data = scoped(await apiGet<{ businessId: string; date: string; appointments: Appointment[] }>(`/api/appointments/day?date=${date}`, { businessId, signal }), businessId);
  if (data.date !== date || !Array.isArray(data.appointments) || data.appointments.some((a) => !validAppointment(a) || a.appointment_date !== date)) invalid();
  return data.appointments;
}
export async function getCustomers(businessId: string, q: string, offset: number, signal: AbortSignal) {
  const data = scoped(await apiGet<{ businessId: string; customers: Customer[]; nextOffset: number | null }>(`/api/customers?q=${encodeURIComponent(q)}&offset=${offset}`, { businessId, signal }), businessId);
  if (!Array.isArray(data.customers) || data.customers.some((c) => !c || typeof c.id !== "string" || typeof c.full_name !== "string")) invalid();
  return data;
}
export async function getServices(businessId: string, signal: AbortSignal) {
  const data = scoped(await apiGet<{ businessId: string; services: Service[] }>("/api/services", { businessId, signal }), businessId);
  if (!Array.isArray(data.services) || data.services.some((s) => !s || typeof s.id !== "string" || typeof s.name !== "string")) invalid();
  return data.services;
}
export async function getAvailability(businessId: string, date: string, serviceId: string, appointmentId: string | undefined, signal: AbortSignal) {
  const params = new URLSearchParams({ date, serviceId });
  if (appointmentId) params.set("appointmentId", appointmentId);
  const data = scoped(await apiGet<Availability>(`/api/appointments/availability?${params}`, { businessId, signal }), businessId);
  if (data.date !== date || data.serviceId !== serviceId || data.appointmentId !== (appointmentId || null) ||
      !["AVAILABLE", "NO_AVAILABILITY", "CLOSED"].includes(data.code) || !Array.isArray(data.slots) ||
      data.slots.some((s) => typeof s !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(s)) ||
      (data.code !== "AVAILABLE" && data.slots.length > 0)) invalid();
  return data;
}
export async function mutateAppointment(businessId: string, body: Record<string, unknown>, requestKey: string, expectedUserId: string) {
  const data = await apiMutate<{ appointment: Appointment; receipt: { business_id: string; appointment_id: string } }>(body, {
    businessId, requestKey, expectedUserId, method: body.appointmentId ? "PATCH" : "POST",
  });
  if (!validAppointment(data.appointment) || data.receipt?.business_id !== businessId ||
      data.receipt.appointment_id !== data.appointment.id || (body.appointmentId && body.appointmentId !== data.appointment.id)) invalid();
  return data.appointment;
}
