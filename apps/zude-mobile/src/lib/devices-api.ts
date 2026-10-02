import { apiGet, apiWrite, ZudeApiError } from "./api";
import { operationalRequest } from "./operational-identity";

// Safe registered-device fields only. Credentials, hashes and salts are never
// part of this type, and anything else in a response is dropped.
export type RegisteredDeviceRecord = { id: string; name: string; registeredAt: string; lastSeenAt: string | null; revokedAt: string | null };

function invalid(): never { throw new ZudeApiError(0, "INVALID_RESPONSE", "Unable to verify device data."); }
const instant = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
function device(value: unknown, businessId: string): RegisteredDeviceRecord {
  const row = value as Record<string, unknown> | null;
  if (!row || typeof row.id !== "string" || typeof row.name !== "string" || row.business_id !== businessId || !instant(row.registered_at) ||
      (row.last_seen_at != null && !instant(row.last_seen_at)) || (row.revoked_at != null && !instant(row.revoked_at))) invalid();
  return { id: row.id, name: row.name, registeredAt: row.registered_at as string, lastSeenAt: (row.last_seen_at as string | null) ?? null, revokedAt: (row.revoked_at as string | null) ?? null };
}

export async function getRegisteredDevices(businessId: string, signal: AbortSignal) {
  const data = await operationalRequest(businessId, (headers) =>
    apiGet<{ businessId: string; devices: unknown[] }>("/api/devices", { businessId, signal, headers }));
  if (data.businessId !== businessId || !Array.isArray(data.devices)) invalid();
  return data.devices.map((row) => device(row, businessId));
}
// Server revocation (POST /api/devices/:id, body {}). Idempotent on the server;
// the first revocation time and actor are kept. This never touches the local
// device credential: a revoked device discovers DEVICE_REVOKED on its next
// device-authenticated request and runs the secure recovery path itself.
export async function revokeRegisteredDevice(businessId: string, userId: string, id: string) {
  const data = await operationalRequest(businessId, (headers) =>
    apiWrite<{ device: unknown }>(`/api/devices/${encodeURIComponent(id)}`, {}, { businessId, expectedUserId: userId, method: "POST", headers }));
  const revoked = device(data.device, businessId);
  if (revoked.id !== id || !revoked.revokedAt) invalid();
  return revoked;
}
