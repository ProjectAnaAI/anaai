import { isUuid } from "@/lib/appointment-actions";
import { customerPhoneTaken, normalizeCustomerPhone, validateCustomer } from "@/lib/customer-validation";
import {
  businessNowKey,
  compareAppointmentsNewestFirst,
  summarizeCustomerHistory,
  type CustomerAppointment,
} from "@/lib/customer-insights";
import { readFailure, readJson } from "../read-api";
import { authorizedMember, jsonBody, optionalText, pathId, readAllPages } from "../member";

// Thin wrappers over the web CRM rules (lib/customer-validation.ts,
// lib/customer-insights.ts). Customers are archived, never deleted.
const customerFields = "id, full_name, phone, email, notes, is_active";
const historyFields = "id, customer_id, service, appointment_date, appointment_time, status, duration_minutes";
const pageSize = 50;
type ListedCustomer = { id: string; full_name: string; phone: string | null; email: string | null; is_active: boolean };

function unavailable() {
  return readFailure(503, "SERVICE_UNAVAILABLE", "Unable to load customers. Please retry.");
}
function invalidRequest() {
  return readFailure(400, "INVALID_REQUEST", "Invalid customer request.");
}

// Validation messages come from the shared web rules; codes let clients
// explain the problem without trusting server text.
function validationFailure(error: unknown) {
  const message = typeof (error as { message?: unknown })?.message === "string" ? (error as Error).message : "";
  const code = /phone/i.test(message) ? "CUSTOMER_PHONE_INVALID"
    : /email/i.test(message) ? "CUSTOMER_EMAIL_INVALID" : "CUSTOMER_NAME_INVALID";
  return readFailure(400, code, message || "Invalid customer.");
}

// Web Customers page semantics: active first, then name; substring search over
// name, phone and email; active/archived/all filter.
export async function DIRECTORY(request: Request) {
  try {
    const member = await authorizedMember(request);
    if (!member.ok) return member.response;
    const { db, context } = member;
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some((key) => !["q", "status", "offset"].includes(key) || params.getAll(key).length !== 1)) {
      return readFailure(400, "INVALID_REQUEST", "Unsupported query parameters.");
    }
    const q = (params.get("q") || "").trim().toLowerCase();
    const status = params.get("status") || "active";
    const rawOffset = params.get("offset") || "0";
    if (q.length > 100 || !["active", "archived", "all"].includes(status) || !/^\d{1,6}$/.test(rawOffset)) {
      return readFailure(400, "INVALID_REQUEST", "Invalid customer search.");
    }
    const offset = Number(rawOffset);
    const all = await readAllPages<ListedCustomer>((from, to) => db.from("customers")
      .select("id, full_name, phone, email, is_active").eq("business_id", context.businessId)
      .order("id").range(from, to));
    const matching = all.filter((customer) =>
      (status === "all" || customer.is_active === (status === "active")) &&
      (!q || [customer.full_name, customer.phone || "", customer.email || ""].join(" ").toLowerCase().includes(q)))
      .sort((first, second) => first.is_active !== second.is_active ? (first.is_active ? -1 : 1)
        : first.full_name.localeCompare(second.full_name) || first.id.localeCompare(second.id));
    const active = all.filter((customer) => customer.is_active).length;
    return readJson({
      success: true, businessId: context.businessId, status, q,
      customers: matching.slice(offset, offset + pageSize),
      total: matching.length,
      nextOffset: offset + pageSize < matching.length ? offset + pageSize : null,
      counts: { active, archived: all.length - active },
    });
  } catch {
    return unavailable();
  }
}

export async function DETAIL(request: Request) {
  try {
    const member = await authorizedMember(request);
    if (!member.ok) return member.response;
    const { db, context } = member;
    const id = pathId(request);
    if (!isUuid(id) || new URL(request.url).searchParams.size) return invalidRequest();
    const customer = await db.from("customers").select(customerFields)
      .eq("business_id", context.businessId).eq("id", id).maybeSingle();
    if (customer.error) throw new Error();
    // Another tenant's ID is indistinguishable from a missing one.
    if (!customer.data) return readFailure(404, "CUSTOMER_NOT_FOUND", "Customer not found.");
    /* Read-only: the CRM never updates or deletes appointments. */
    // Appointment notes are not part of the customer view; the web summary
    // helper only needs the schedule/status fields.
    const history = (await readAllPages<Omit<CustomerAppointment, "notes">>((from, to) => db.from("appointments")
      .select(historyFields).eq("business_id", context.businessId).eq("customer_id", id)
      .order("id").range(from, to)))
      .sort((first, second) => compareAppointmentsNewestFirst({ ...first, notes: null }, { ...second, notes: null }));
    const summary = summarizeCustomerHistory(history.map((appointment) => ({ ...appointment, notes: null })),
      businessNowKey(context.timezone));
    return readJson({
      success: true, businessId: context.businessId, customer: customer.data, appointments: history,
      summary: {
        total: summary.count, completed: summary.completedCount, cancelled: summary.cancelledCount,
        upcomingId: summary.upcoming?.id ?? null, lastVisitId: summary.lastPast?.id ?? null,
      },
    });
  } catch {
    return unavailable();
  }
}

const editableFields = ["name", "phone", "email", "notes"] as const;

async function save(request: Request, id: string | null) {
  const member = await authorizedMember(request);
  if (!member.ok) return member.response;
  const { db, context } = member;
  if (id !== null && !isUuid(id)) return invalidRequest();
  const body = await jsonBody(request, id ? [...editableFields, "isActive"] : editableFields);
  if (!body) return invalidRequest();
  const statusOnly = id !== null && Object.keys(body).length === 1 && "isActive" in body;
  if (statusOnly ? typeof body.isActive !== "boolean"
    : "isActive" in body || typeof body.name !== "string" || !optionalText(body.phone) || !optionalText(body.email) || !optionalText(body.notes)) {
    return invalidRequest();
  }
  if (id) {
    const existing = await db.from("customers").select("id")
      .eq("business_id", context.businessId).eq("id", id).maybeSingle();
    if (existing.error) throw new Error();
    if (!existing.data) return readFailure(404, "CUSTOMER_NOT_FOUND", "Customer not found.");
  }
  let values: Record<string, unknown>;
  if (statusOnly) {
    values = { is_active: body.isActive };
  } else {
    try {
      values = validateCustomer({ name: body.name as string, phone: (body.phone as string | null) || "",
        email: (body.email as string | null) || undefined, notes: (body.notes as string | null) || undefined });
    } catch (error) {
      return validationFailure(error);
    }
    const phoneKey = normalizeCustomerPhone((values.phone as string | null) || "");
    if (phoneKey) {
      const phone = await customerPhoneTaken(db, context.businessId, phoneKey, id || undefined);
      if (phone === "error") throw new Error();
      if (phone === "taken") {
        return readFailure(409, "DUPLICATE_PHONE", "A customer with this phone number already exists. Select or edit the existing customer.");
      }
    }
  }
  const query = id
    ? db.from("customers").update(values).eq("id", id).eq("business_id", context.businessId)
    : db.from("customers").insert({ ...values, business_id: context.businessId, user_id: context.userId, is_active: true });
  const { data, error } = await query.select(customerFields).single();
  if (error || !data) throw new Error();
  return readJson({ success: true, businessId: context.businessId, customer: data }, id ? 200 : 201);
}

export async function CREATE(request: Request) {
  try {
    return await save(request, null);
  } catch {
    return readFailure(503, "SERVICE_UNAVAILABLE", "Unable to save the customer. Refresh and try again.");
  }
}

export async function UPDATE(request: Request) {
  try {
    return await save(request, pathId(request));
  } catch {
    return readFailure(503, "SERVICE_UNAVAILABLE", "Unable to save the customer. Refresh and try again.");
  }
}
