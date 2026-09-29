import { apiGet, apiWrite, ZudeApiError } from "./api";
import type { Appointment } from "./appointments-api";

export type CustomerStatusFilter = "active" | "archived";
export type CustomerListItem = { id: string; full_name: string; phone: string | null; email: string | null; is_active: boolean };
export type CustomerRecord = CustomerListItem & { notes: string | null };
export type CustomerHistoryItem = Pick<Appointment, "id" | "customer_id" | "service" | "appointment_date" | "appointment_time" | "status" | "duration_minutes">;
export type CustomerDirectory = {
  businessId: string; customers: CustomerListItem[]; total: number; nextOffset: number | null;
  counts: { active: number; archived: number };
};
export type CustomerDetail = {
  businessId: string; customer: CustomerRecord; appointments: CustomerHistoryItem[];
  summary: { total: number; completed: number; cancelled: number; upcomingId: string | null; lastVisitId: string | null };
};
export type CustomerFields = { name: string; phone: string; email: string; notes: string };

function invalid(): never { throw new ZudeApiError(0, "INVALID_RESPONSE", "Unable to verify customer data."); }
function validCustomer(value: CustomerListItem) {
  return !!value && typeof value.id === "string" && typeof value.full_name === "string" && typeof value.is_active === "boolean";
}
function scoped<T extends { businessId: string }>(data: T, businessId: string) {
  if (data.businessId !== businessId) invalid();
  return data;
}

export async function getCustomerDirectory(businessId: string, query: { q: string; status: CustomerStatusFilter; offset: number }, signal: AbortSignal) {
  const params = new URLSearchParams({ q: query.q, status: query.status, offset: String(query.offset) });
  const data = scoped(await apiGet<CustomerDirectory>(`/api/customers/directory?${params}`, { businessId, signal }), businessId);
  if (!Array.isArray(data.customers) || !data.customers.every(validCustomer) ||
      data.customers.some((c) => c.is_active !== (query.status === "active")) ||
      typeof data.counts?.active !== "number" || typeof data.counts?.archived !== "number") invalid();
  return data;
}

export async function getCustomerDetail(businessId: string, customerId: string, signal: AbortSignal) {
  const data = scoped(await apiGet<CustomerDetail>(`/api/customers/${encodeURIComponent(customerId)}`, { businessId, signal }), businessId);
  if (!validCustomer(data.customer) || data.customer.id !== customerId || !Array.isArray(data.appointments) ||
      data.appointments.some((a) => !a || typeof a.id !== "string" || a.customer_id !== customerId) ||
      typeof data.summary?.total !== "number") invalid();
  return data;
}

// Empty optional fields are sent as null; the server applies the web rules.
function body(fields: CustomerFields) {
  return { name: fields.name, phone: fields.phone.trim() || null, email: fields.email.trim() || null, notes: fields.notes.trim() || null };
}
async function write(businessId: string, expectedUserId: string, path: string, method: "POST" | "PATCH", payload: Record<string, unknown>) {
  const data = scoped(await apiWrite<{ businessId: string; customer: CustomerRecord }>(path, payload, { businessId, expectedUserId, method }), businessId);
  if (!validCustomer(data.customer)) invalid();
  return data.customer;
}
export function createCustomer(businessId: string, userId: string, fields: CustomerFields) {
  return write(businessId, userId, "/api/customers", "POST", body(fields));
}
export async function updateCustomer(businessId: string, userId: string, customerId: string, fields: CustomerFields) {
  const customer = await write(businessId, userId, `/api/customers/${encodeURIComponent(customerId)}`, "PATCH", body(fields));
  if (customer.id !== customerId) invalid();
  return customer;
}
export async function setCustomerActive(businessId: string, userId: string, customerId: string, isActive: boolean) {
  const customer = await write(businessId, userId, `/api/customers/${encodeURIComponent(customerId)}`, "PATCH", { isActive });
  if (customer.id !== customerId || customer.is_active !== isActive) invalid();
  return customer;
}
