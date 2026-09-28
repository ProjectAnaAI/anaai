import type { AppointmentRow } from "../features/today/todayData";
import { apiGet, ZudeApiError } from "./api";

export type BusinessRole = "owner" | "manager" | "staff";
export type Business = { id: string; name: string; timezone: string; role: BusinessRole };

export async function getBusinesses(signal?: AbortSignal) {
  const result = await apiGet<{ userId: string; businesses: Business[] }>("/api/businesses", { signal });
  if (typeof result.userId !== "string" || !result.userId || !Array.isArray(result.businesses) ||
      !result.businesses.every((business) => business && typeof business.id === "string" && business.id &&
        typeof business.name === "string" && typeof business.timezone === "string" &&
        ["owner", "manager", "staff"].includes(business.role))) {
    throw new ZudeApiError(502, "INVALID_RESPONSE", "Invalid business response from ZUDE.");
  }
  return result;
}

// Remembered selection is a preference within the freshly authorized list.
export function rememberedBusiness(businesses: Business[], rememberedId: string | null) {
  return businesses.length === 1 ? businesses[0] : businesses.find((business) => business.id === rememberedId);
}

export async function getTodayAppointments(businessId: string, date: string, signal?: AbortSignal) {
  const result = await apiGet<{ businessId: string; date: string; appointments: AppointmentRow[] }>(
    `/api/appointments?date=${encodeURIComponent(date)}`, { businessId, signal },
  );
  if (result.businessId !== businessId || result.date !== date || !Array.isArray(result.appointments)) {
    throw new ZudeApiError(502, "INVALID_RESPONSE", "Invalid appointment response from ZUDE.");
  }
  return result.appointments;
}
