import type { SupabaseClient } from "@supabase/supabase-js";
import { isBusinessRole, type BusinessContext } from "@/lib/business-context";

export async function listMemberBusinesses(
  db: SupabaseClient,
  memberships: { business_id: string; role: string }[],
) {
  const roles = new Map(memberships.filter((m) => isBusinessRole(m.role))
    .map((m) => [m.business_id, m.role]));
  if (!roles.size) return [];
  const { data, error } = await db.from("businesses")
    .select("id, name, timezone").in("id", [...roles.keys()])
    .order("name").order("id");
  if (error) throw new Error("Business read failed.");
  const businesses = (data ?? []).filter((business) => roles.has(business.id)).map((business) => ({
    id: business.id, name: business.name, timezone: business.timezone,
    role: roles.get(business.id)!,
  }));
  // A membership with no readable business is an error, not an onboarding state.
  if (!businesses.length) throw new Error("Business read failed.");
  return businesses;
}

export type TodayAppointment = {
  id: string;
  customer_name: string | null;
  service: string | null;
  appointment_time: string | null;
  status: string;
  duration_minutes: number | null;
};

// Receives resolved context, never an unchecked business ID from the HTTP request.
export async function listTodayAppointments(db: SupabaseClient, context: BusinessContext, date: string) {
  const appointments: TodayAppointment[] = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await db.from("appointments")
      .select("id, customer_name, service, appointment_time, status, duration_minutes")
      .eq("business_id", context.businessId).eq("appointment_date", date)
      .order("appointment_time", { ascending: true }).order("id", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error("Appointment read failed.");
    appointments.push(...(data ?? []));
    if (!data || data.length < pageSize) return appointments;
  }
}
