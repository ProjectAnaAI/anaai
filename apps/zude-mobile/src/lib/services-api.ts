import { apiGet, apiWrite, ZudeApiError } from "./api";

export type CatalogService = {
  id: string; name: string; duration_minutes: number | null; price: number | null; description: string | null; is_active: boolean;
};
export type ServiceFields = { name: string; duration: string; price: string; description: string; active: boolean };

function invalid(): never { throw new ZudeApiError(0, "INVALID_RESPONSE", "Unable to verify service data."); }
function validService(value: CatalogService) {
  return !!value && typeof value.id === "string" && typeof value.name === "string" && typeof value.is_active === "boolean" &&
    (value.duration_minutes === null || typeof value.duration_minutes === "number") && (value.price === null || typeof value.price === "number");
}
function scoped<T extends { businessId: string }>(data: T, businessId: string) {
  if (data.businessId !== businessId) invalid();
  return data;
}

export async function getServiceCatalog(businessId: string, signal: AbortSignal) {
  const data = scoped(await apiGet<{ businessId: string; canManage: boolean; services: CatalogService[] }>("/api/services/catalog", { businessId, signal }), businessId);
  if (!Array.isArray(data.services) || !data.services.every(validService) || typeof data.canManage !== "boolean") invalid();
  return data;
}

// Numeric text that is not a plain number is sent as-is so the server's
// shared validation, not the device, decides and explains the rejection.
function numeric(value: string) {
  const text = value.trim();
  if (!text) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : text;
}
async function write(businessId: string, expectedUserId: string, path: string, method: "POST" | "PATCH", payload: Record<string, unknown>) {
  const data = scoped(await apiWrite<{ businessId: string; service: CatalogService }>(path, payload, { businessId, expectedUserId, method }), businessId);
  if (!validService(data.service)) invalid();
  return data.service;
}
export function createService(businessId: string, userId: string, fields: ServiceFields) {
  return write(businessId, userId, "/api/services", "POST", {
    name: fields.name, durationMinutes: numeric(fields.duration), price: numeric(fields.price),
    description: fields.description.trim() || null, isActive: fields.active,
  });
}
// Duration is never sent for an existing service: it is locked by product rule.
export async function updateService(businessId: string, userId: string, serviceId: string, fields: ServiceFields) {
  const service = await write(businessId, userId, `/api/services/${encodeURIComponent(serviceId)}`, "PATCH", {
    name: fields.name, price: numeric(fields.price), description: fields.description.trim() || null, isActive: fields.active,
  });
  if (service.id !== serviceId) invalid();
  return service;
}
export async function setServiceActive(businessId: string, userId: string, serviceId: string, isActive: boolean) {
  const service = await write(businessId, userId, `/api/services/${encodeURIComponent(serviceId)}`, "PATCH", { isActive });
  if (service.id !== serviceId || service.is_active !== isActive) invalid();
  return service;
}
