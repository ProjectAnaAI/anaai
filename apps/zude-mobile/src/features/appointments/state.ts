import { ZudeApiError } from "../../lib/api";
import type { Appointment } from "../../lib/appointments-api";
export function validDate(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const value = new Date(`${date}T12:00:00Z`);
  return Number.isFinite(value.getTime()) && value.toISOString().slice(0, 10) === date && !date.startsWith("0000");
}
export function shiftDate(date: string, days: number) {
  if (!validDate(date)) return date;
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
export function timeLabel(time: string | null) {
  if (!time) return "Time unavailable";
  const [hour, minute] = time.split(":").map(Number);
  return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour >= 12 ? "PM" : "AM"}`;
}
export function lifecycleActions(status: Appointment["status"]) {
  return status === "Booked" ? ["Confirmed", "Cancelled"] as const : status === "Confirmed" ? ["Completed", "Cancelled"] as const : [];
}
export function isSlotConflict(error: unknown) {
  return error instanceof ZudeApiError && ["SLOT_CONFLICT", "OUTSIDE_HOURS", "CLOSED", "SOURCE_DATE_CHANGED"].includes(error.code);
}
export function safeMessage(error: unknown) {
  if (!(error instanceof ZudeApiError)) return "The action could not be verified. Retry without changing your selections.";
  if (error.status === 401) return "Your session expired. Please sign in again.";
  if (error.status === 403) return "Your account no longer has access to this business.";
  if (isSlotConflict(error)) return "That time is no longer available. Choose another available time.";
  if (error.code === "LOCAL_STORAGE_ERROR") return "Device storage is unavailable. No request was sent. Please retry.";
  if (error.code === "CONFIGURATION_ERROR") return "ZUDE API configuration is unavailable. Contact your administrator.";
  if (error.code === "NETWORK_ERROR") return "Unable to reach ZUDE. Check your connection and retry.";
  if (["INVALID_HOURS", "INVALID_EXISTING_SCHEDULE", "INVALID_DURATION"].includes(error.code)) return "The schedule could not be safely checked. Ask a manager to review the business configuration.";
  if (["INVALID_TRANSITION", "TERMINAL_APPOINTMENT", "APPOINTMENT_NOT_FOUND"].includes(error.code)) return "This appointment has changed. Refresh the day to see its current state.";
  if (error.status === 400) return "Check your customer, service, date and time selections.";
  return "ZUDE could not verify this request. Please retry.";
}
export function recoverConflict<T extends { time: string }>(selection: T): T {
  return { ...selection, time: "" };
}

export function uncertainAction(error: unknown) {
  if (error instanceof ZudeApiError && ["CONFIGURATION_ERROR", "LOCAL_STORAGE_ERROR"].includes(error.code)) return false;
  return !(error instanceof ZudeApiError) || error.status === 0 || error.status >= 500 || error.code === "INVALID_RESPONSE";
}
