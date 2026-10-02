import { ZudeApiError } from "../../lib/api";
import type { RegisteredDeviceRecord } from "../../lib/devices-api";
import { safeMessage } from "../appointments/state";

// Active devices first, newest registration first; revoked devices stay
// listed as history.
export function sortDevices(devices: readonly RegisteredDeviceRecord[]) {
  return [...devices].sort((a, b) => (a.revokedAt ? 1 : 0) - (b.revokedAt ? 1 : 0) || Date.parse(b.registeredAt) - Date.parse(a.registeredAt) || a.id.localeCompare(b.id));
}
// Server instants shown in the business's timezone; never raw ISO text.
export function deviceTime(value: string | null, timezone: string) {
  if (!value) return "Not yet";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unavailable";
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
  }
}
export function deviceMessage(error: unknown) {
  if (error instanceof ZudeApiError) {
    if (error.code === "DEVICE_NOT_FOUND") return "This device is no longer available. Refresh Registered Devices.";
    if (error.code === "ROLE_FORBIDDEN" || error.code === "EMPLOYEE_FORBIDDEN") return "You are not allowed to manage registered devices.";
    if (error.code === "IDENTITY_REQUIRED" || error.code === "IDENTITY_UNAUTHORIZED") return "Unlock with an employee PIN, then try again.";
    if (error.code === "DEVICE_INVALID" || error.code === "DEVICE_REVOKED") return "This iPad's registration is no longer valid.";
    if (error.code === "INVALID_RESPONSE") return "The device change could not be verified. Refresh Registered Devices.";
    if (error.status === 0 && error.code === "NETWORK_ERROR") return "Unable to reach ZUDE. The change was not confirmed. Check your connection, refresh and retry.";
    if (error.status >= 500) return "Unable to update registered devices. Refresh, then retry.";
  }
  return safeMessage(error);
}
