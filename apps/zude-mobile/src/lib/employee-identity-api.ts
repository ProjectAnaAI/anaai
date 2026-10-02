import { apiUrl, apiWrite, ZudeApiError } from "./api";
export type EmployeeIdentity = { id: string; businessId: string; name: string; role: "employee" | "manager" | "owner" };
export type IdentityResult = { success: true; employee: EmployeeIdentity; permissions: string[]; expiresAt: string };
export type IssuedSession = IdentityResult & { session: string };
export type RegisteredDevice = { businessId: string; credential: string };
export function registerDevice(name: string, businessId: string, expectedUserId: string) {
  return apiWrite<{ success: true; credential: string; device: { id: string; business_id: string } }>("/api/devices", { name }, { businessId, expectedUserId, method: "POST" });
}

// Codes the server emits only when the presented device credential itself can
// never authenticate again (server/employee-identity.ts). Nothing else — wrong
// PIN, lockout, session failure, network or 5xx — may forget a device.
const DEVICE_REJECTED = new Set(["DEVICE_INVALID", "DEVICE_REVOKED"]);
export function deviceCredentialRejected(error: unknown) {
  return error instanceof ZudeApiError && error.status === 401 && isDeviceRejectionCode(error.code);
}
// For rejections already known to be 401s (shared-device management requests).
export function isDeviceRejectionCode(code: string) {
  return DEVICE_REJECTED.has(code);
}

// Server codes are preserved; display text is always client-owned, never the
// server's or a provider's.
function identityMessage(code: string) {
  switch (code) {
    case "PIN_INVALID": return "Unable to unlock with that PIN. Check your PIN and try again.";
    case "PIN_LOCKED": return "PIN entry is temporarily locked. Please try again later.";
    case "PIN_RETRY": return "PIN entry is busy. Please try again.";
    case "DEVICE_INVALID":
    case "DEVICE_REVOKED": return "This device registration is no longer valid.";
    case "IDENTITY_UNAUTHORIZED": return "Your employee session ended. Enter your PIN to unlock.";
    case "INVALID_REQUEST": return "ZUDE could not process that request. Please retry.";
    default: return "ZUDE identity is unavailable. Please retry.";
  }
}
function responseCode(status: number, body: unknown) {
  const code = (body as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Z_]{1,64}$/.test(code)) return code;
  // Fallbacks never produce a device-rejection code.
  return status === 429 ? "PIN_LOCKED" : status === 401 ? "IDENTITY_UNAUTHORIZED" : status === 400 ? "INVALID_REQUEST" : "IDENTITY_UNAVAILABLE";
}
export async function identityRequest<T>(path: "/api/device/pin" | "/api/employee-session/validate" | "/api/employee-session/lock", device: RegisteredDevice, body: { pin: string } | { session: string }): Promise<T> {
  const url = apiUrl(path);
  try {
    const response = await fetch(url, { method: "POST", headers: { Authorization: `ZudeDevice ${device.credential}`, Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store", redirect: "error" });
    const result = await response.json();
    if (!response.ok || result?.success !== true) {
      const code = responseCode(response.status, result);
      throw new ZudeApiError(response.status, code, identityMessage(code));
    }
    return result as T;
  } catch (error) {
    if (error instanceof ZudeApiError) throw error;
    throw new ZudeApiError(0, "NETWORK_ERROR", "Unable to reach ZUDE. Please retry.");
  }
}
