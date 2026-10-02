import { isUuid } from "@/lib/appointment-actions";
import { validateService } from "@/lib/service-validation";
import { readFailure, readJson } from "../read-api";
import { managementAuthority, managementForbidden } from "../operational-authority";
import { authorizedMember, canManageCatalog, jsonBody, optionalText, pathId, readAllPages } from "../member";

// Thin wrappers over the web Services rules (lib/service-validation.ts):
// owner/manager manage the catalog, services are deactivated rather than
// deleted, and an existing service's duration never changes because existing
// appointments depend on it. Scheduling reads the service row; nothing here
// touches availability or capacity.
const serviceFields = "id, name, duration_minutes, price, description, is_active";
type Service = { id: string; name: string; duration_minutes: number | null; price: number | null; description: string | null; is_active: boolean };

function invalidRequest() {
  return readFailure(400, "INVALID_REQUEST", "Invalid service request.");
}
function roleForbidden() {
  return readFailure(403, "ROLE_FORBIDDEN", "Your business role does not allow service changes.");
}
function validationFailure(error: unknown) {
  const message = typeof (error as { message?: unknown })?.message === "string" ? (error as Error).message : "";
  const code = /duration/i.test(message) ? "SERVICE_DURATION_INVALID"
    : /price/i.test(message) ? "SERVICE_PRICE_INVALID" : "SERVICE_NAME_INVALID";
  return readFailure(400, code, message || "Invalid service.");
}

export async function CATALOG(request: Request) {
  try {
    const member = await authorizedMember(request);
    if (!member.ok) return member.response;
    const { db, context } = member;
    if (new URL(request.url).searchParams.size) {
      return readFailure(400, "INVALID_REQUEST", "Service catalog does not accept query parameters.");
    }
    // Catalog reads stay open to every member; canManage reflects the effective
    // (shared-device-narrowed) authority so staff-level users see read-only.
    const managed = await managementAuthority(request, context);
    if (!managed.ok) return managed.response;
    const services = (await readAllPages<Service>((from, to) => db.from("services").select(serviceFields)
      .eq("business_id", context.businessId).order("id").range(from, to)))
      .sort((first, second) => first.is_active !== second.is_active ? (first.is_active ? -1 : 1)
        : first.name.localeCompare(second.name) || first.id.localeCompare(second.id));
    return readJson({ success: true, businessId: context.businessId, canManage: canManageCatalog({ ...context, role: managed.authority.role }), services });
  } catch {
    return readFailure(503, "SERVICE_UNAVAILABLE", "Unable to load services. Please retry.");
  }
}

function numberText(value: unknown) {
  return value === null || value === undefined ? "" : typeof value === "number" ? String(value) : null;
}

async function save(request: Request, id: string | null) {
  const member = await authorizedMember(request);
  if (!member.ok) return member.response;
  const { db, context } = member;
  if (!canManageCatalog(context)) return roleForbidden();
  const managed = await managementAuthority(request, context);
  if (!managed.ok) return managed.response;
  if (!canManageCatalog({ ...context, role: managed.authority.role })) {
    return managementForbidden(managed.authority, (role) => canManageCatalog({ ...context, role }), "Your business role does not allow service changes.");
  }
  if (id !== null && !isUuid(id)) return invalidRequest();
  const body = await jsonBody(request, ["name", "durationMinutes", "price", "description", "isActive"]);
  if (!body) return invalidRequest();
  if (id !== null && "durationMinutes" in body) {
    return readFailure(400, "DURATION_LOCKED", "Duration cannot be changed for an existing service. Create a new service with the new duration, then deactivate this one.");
  }
  const statusOnly = id !== null && Object.keys(body).length === 1 && "isActive" in body;
  const price = numberText(body.price);
  const duration = numberText(body.durationMinutes);
  if (statusOnly ? typeof body.isActive !== "boolean"
    : typeof body.name !== "string" || price === null || duration === null || !optionalText(body.description) ||
      (body.isActive !== undefined && typeof body.isActive !== "boolean") ||
      (id !== null && !("price" in body && "description" in body))) {
    return invalidRequest();
  }
  let existing: Service | null = null;
  if (id) {
    const found = await db.from("services").select(serviceFields)
      .eq("business_id", context.businessId).eq("id", id).maybeSingle();
    if (found.error) throw new Error();
    // Another tenant's ID is indistinguishable from a missing one.
    if (!found.data) return readFailure(404, "SERVICE_NOT_FOUND", "Service not found.");
    existing = found.data as Service;
  }
  let values: Record<string, unknown>;
  if (statusOnly) {
    values = { is_active: body.isActive };
  } else {
    if (typeof body.description === "string" && body.description.trim().length > 2000) {
      return readFailure(400, "SERVICE_DESCRIPTION_INVALID", "Description must be 2000 characters or fewer.");
    }
    try {
      const { duration_minutes, ...editable } = validateService({
        name: body.name as string, duration: duration as string, price: price as string,
        description: (body.description as string | null) || "", active: (body.isActive as boolean | undefined) ?? existing?.is_active ?? true,
      });
      values = id ? editable : { ...editable, duration_minutes };
    } catch (error) {
      return validationFailure(error);
    }
  }
  const query = id
    ? db.from("services").update(values).eq("id", id).eq("business_id", context.businessId)
    // user_id is retained for compatibility with the current production schema.
    : db.from("services").insert({ ...values, business_id: context.businessId, user_id: context.userId });
  const { data, error } = await query.select(serviceFields).single();
  if (error || !data) throw new Error();
  return readJson({ success: true, businessId: context.businessId, service: data }, id ? 200 : 201);
}

export async function CREATE(request: Request) {
  try {
    return await save(request, null);
  } catch {
    return readFailure(503, "SERVICE_UNAVAILABLE", "Unable to save service. Refresh and try again.");
  }
}

export async function UPDATE(request: Request) {
  try {
    return await save(request, pathId(request));
  } catch {
    return readFailure(503, "SERVICE_UNAVAILABLE", "Unable to save service. Refresh and try again.");
  }
}
