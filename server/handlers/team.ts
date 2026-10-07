import type { SupabaseClient } from "@supabase/supabase-js";

import { isUuid } from "@/lib/appointment-actions";
import { createSupabaseServiceClient } from "@/lib/supabase-server";
import {
  hashEmployeePin,
  validEmployeePin,
  verifyEmployeePin,
} from "../employee-security";
import {
  authorizedMember,
  jsonBody,
  pathId,
  readAllPages,
} from "../member";
import { readFailure, readJson } from "../read-api";
import { managementAuthority, managementForbidden, managementWriteActor } from "../operational-authority";

type EmployeeRole = "employee" | "manager" | "owner";

type EmployeeSecurityRow = {
  id: string;
  pin_hash: string;
  pin_salt: string;
};

type EmployeeRow = {
  id: string;
  business_id: string;
  display_name: string;
  role: EmployeeRole;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

const publicFields =
  "id, business_id, display_name, role, is_active, created_at, updated_at";

const securityFields = "id, pin_hash, pin_salt";

function invalidRequest(message = "Invalid team request.") {
  return readFailure(400, "INVALID_REQUEST", message);
}

function roleForbidden(
  message = "Your business role does not allow this Team change.",
) {
  return readFailure(403, "ROLE_FORBIDDEN", message);
}

function unavailable(message = "Unable to update Team. Please retry.") {
  return readFailure(503, "SERVICE_UNAVAILABLE", message);
}

// SQL identity rejections must trigger the existing native session recovery.
// Never classify a transactional race as a permanent device rejection.
function writeFailure(error: { code?: string } | null) {
  if (error?.code === "28000") return readFailure(401, "IDENTITY_UNAUTHORIZED", "Your employee session ended. Unlock again.");
  if (error?.code === "42501") return roleForbidden();
  if (error?.code === "40001") return readFailure(409, "TEAM_CHANGED", "Team changed. Refresh and retry.");
  if (error?.code === "22023") return invalidRequest();
  return unavailable();
}

function canManageTeam(role: string) {
  return role === "owner" || role === "manager";
}

function validRole(value: unknown): value is EmployeeRole {
  return value === "employee" || value === "manager" || value === "owner";
}

function validName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= 100
  );
}

function canCreateRole(
  membershipRole: string,
  employeeRole: EmployeeRole,
) {
  if (membershipRole === "owner") {
    return true;
  }

  return membershipRole === "manager" && employeeRole === "employee";
}

function canModifyEmployee(
  membershipRole: string,
  existingRole: EmployeeRole,
) {
  if (membershipRole === "owner") {
    return true;
  }

  return membershipRole === "manager" && existingRole === "employee";
}

function canAssignRole(
  membershipRole: string,
  employeeRole: EmployeeRole,
) {
  if (membershipRole === "owner") {
    return true;
  }

  return membershipRole === "manager" && employeeRole === "employee";
}

function pinEmployeeId(request: Request) {
  try {
    const segments = new URL(request.url).pathname
      .split("/")
      .filter(Boolean);

    if (
      segments.length < 2 ||
      segments[segments.length - 1] !== "pin"
    ) {
      return "";
    }

    return decodeURIComponent(segments[segments.length - 2] || "");
  } catch {
    return "";
  }
}

function serviceDb() {
  return createSupabaseServiceClient();
}

async function pinTaken(
  db: SupabaseClient,
  businessId: string,
  pin: string,
  excludeEmployeeId?: string,
) {
  const employees = await readAllPages<EmployeeSecurityRow>((from, to) =>
    db
      .from("employees")
      .select(securityFields)
      .eq("business_id", businessId)
      .eq("is_active", true)
      .order("id")
      .range(from, to),
  );

  for (const employee of employees) {
    if (
      excludeEmployeeId &&
      employee.id === excludeEmployeeId
    ) {
      continue;
    }

    if (
      await verifyEmployeePin(
        pin,
        employee.pin_hash,
        employee.pin_salt,
      )
    ) {
      return { taken: true, snapshot: employees };
    }
  }

  return { taken: false, snapshot: employees };
}

async function findEmployee(
  db: SupabaseClient,
  businessId: string,
  employeeId: string,
) {
  const result = await db
    .from("employees")
    .select(publicFields)
    .eq("business_id", businessId)
    .eq("id", employeeId)
    .maybeSingle();

  if (result.error) {
    throw new Error("Team lookup failed.");
  }

  return (result.data as EmployeeRow | null) ?? null;
}

export async function DIRECTORY(request: Request) {
  try {
    const member = await authorizedMember(request);
    if (!member.ok) {
      return member.response;
    }

    const { context } = member;

    if (!canManageTeam(context.role)) {
      return roleForbidden();
    }

    // Shared-device mode narrows authority to the PIN-verified employee.
    const managed = await managementAuthority(request, context);
    if (!managed.ok) {
      return managed.response;
    }

    const { authority } = managed;

    if (!canManageTeam(authority.role)) {
      return managementForbidden(authority, canManageTeam, "Your business role does not allow this Team change.");
    }

    const params = new URL(request.url).searchParams;

    if (
      [...params.keys()].some(
        (key) =>
          key !== "status" ||
          params.getAll(key).length !== 1,
      )
    ) {
      return invalidRequest();
    }

    const status = params.get("status") || "active";

    if (!["active", "inactive", "all"].includes(status)) {
      return invalidRequest();
    }

    const db = serviceDb();

    let query = db
      .from("employees")
      .select(publicFields)
      .eq("business_id", context.businessId);

    if (status === "active") {
      query = query.eq("is_active", true);
    } else if (status === "inactive") {
      query = query.eq("is_active", false);
    }

    const { data, error } = await query
      .order("display_name", { ascending: true })
      .order("id", { ascending: true });

    if (error) {
      throw new Error("Team read failed.");
    }

    return readJson({
      success: true,
      businessId: context.businessId,
      canManage: true,
      employees: data ?? [],
    });
  } catch {
    return unavailable("Unable to load Team. Please retry.");
  }
}

export async function CREATE(request: Request) {
  try {
    const member = await authorizedMember(request);
    if (!member.ok) {
      return member.response;
    }

    const { context } = member;

    if (!canManageTeam(context.role)) {
      return roleForbidden();
    }

    // Shared-device mode narrows authority to the PIN-verified employee.
    const managed = await managementAuthority(request, context);
    if (!managed.ok) {
      return managed.response;
    }

    const { authority } = managed;

    if (!canManageTeam(authority.role)) {
      return managementForbidden(authority, canManageTeam, "Your business role does not allow this Team change.");
    }

    const body = await jsonBody(request, [
      "name",
      "role",
      "pin",
    ]);

    if (!body) {
      return invalidRequest();
    }

    if (
      !validName(body.name) ||
      !validRole(body.role) ||
      !validEmployeePin(body.pin)
    ) {
      return invalidRequest(
        "Name, role, and a 4–6 digit PIN are required.",
      );
    }

    if (!canCreateRole(authority.role, body.role)) {
      const role = body.role;
      return managementForbidden(authority, (actor) => canCreateRole(actor, role),
        "Only a business owner can create manager or owner employees.");
    }

    const db = serviceDb();

    const checked = await pinTaken(db, context.businessId, body.pin);
    if (checked.taken) return readFailure(409, "PIN_IN_USE", "That PIN is already assigned to an active employee.");

    const pin = await hashEmployeePin(body.pin);

    const { data, error } = await db
      .rpc("m04_write_employee", {
        p_business_id: context.businessId,
        ...managementWriteActor(authority),
        p_employee_id: null,
        p_expected_updated_at: null,
        p_pin_snapshot: checked.snapshot,
        p_values: {
        business_id: context.businessId,
        display_name: body.name.trim(),
        role: body.role,
        pin_hash: pin.hash,
        pin_salt: pin.salt,
        is_active: true,
        created_by_user_id: context.userId,
        updated_by_user_id: context.userId,
        },
      })
      .select(publicFields)
      .single();

    if (error || !data) {
      return writeFailure(error);
    }

    return readJson(
      {
        success: true,
        businessId: context.businessId,
        employee: data,
      },
      201,
    );
  } catch {
    return unavailable();
  }
}

export async function UPDATE(request: Request) {
  try {
    const member = await authorizedMember(request);
    if (!member.ok) {
      return member.response;
    }

    const { context } = member;

    if (!canManageTeam(context.role)) {
      return roleForbidden();
    }

    // Shared-device mode narrows authority to the PIN-verified employee.
    const managed = await managementAuthority(request, context);
    if (!managed.ok) {
      return managed.response;
    }

    const { authority } = managed;

    if (!canManageTeam(authority.role)) {
      return managementForbidden(authority, canManageTeam, "Your business role does not allow this Team change.");
    }

    const id = pathId(request);

    if (!isUuid(id)) {
      return invalidRequest();
    }

    const body = await jsonBody(request, [
      "name",
      "role",
      "isActive",
      "pin",
    ]);

    if (!body || Object.keys(body).length === 0) {
      return invalidRequest();
    }

    if ("name" in body && !validName(body.name)) {
      return invalidRequest("Employee name is invalid.");
    }

    if ("role" in body && !validRole(body.role)) {
      return invalidRequest("Employee role is invalid.");
    }

    if (
      "isActive" in body &&
      typeof body.isActive !== "boolean"
    ) {
      return invalidRequest();
    }

    if (
      "pin" in body &&
      !validEmployeePin(body.pin)
    ) {
      return invalidRequest("A 4–6 digit PIN is required.");
    }

    const db = serviceDb();

    const employee = await findEmployee(
      db,
      context.businessId,
      id,
    );

    if (!employee) {
      return readFailure(
        404,
        "EMPLOYEE_NOT_FOUND",
        "Employee not found.",
      );
    }

    if (!canModifyEmployee(authority.role, employee.role)) {
      return managementForbidden(authority, (actor) => canModifyEmployee(actor, employee.role),
        "Only a business owner can manage manager or owner employees.");
    }

    const nextRole = (
      "role" in body ? body.role : employee.role
    ) as EmployeeRole;

    if (!canAssignRole(authority.role, nextRole)) {
      return managementForbidden(authority, (actor) => canAssignRole(actor, nextRole),
        "Only a business owner can assign the manager or owner role.");
    }

    const reactivating =
      employee.is_active === false &&
      body.isActive === true;

    if (reactivating && !("pin" in body)) {
      return readFailure(
        409,
        "REACTIVATION_REQUIRES_PIN",
        "Employee reactivation requires a new PIN.",
      );
    }

    if ("pin" in body && !reactivating) {
      return invalidRequest(
        "PIN may only be supplied when reactivating an inactive employee.",
      );
    }

    const values: Record<string, unknown> = {
      updated_by_user_id: context.userId,
      updated_at: new Date().toISOString(),
    };

    if ("name" in body) {
      values.display_name = (body.name as string).trim();
    }

    if ("role" in body) {
      values.role = body.role;
    }

    if ("isActive" in body) {
      values.is_active = body.isActive;
    }

    let pinSnapshot: EmployeeSecurityRow[] | null = null;
    if (reactivating) {
      const candidatePin = body.pin as string;

      const checked = await pinTaken(db, context.businessId, candidatePin, id);
      if (checked.taken) return readFailure(409, "PIN_IN_USE", "That PIN is already assigned to another active employee.");
      pinSnapshot = checked.snapshot;

      const pin = await hashEmployeePin(candidatePin);

      values.pin_hash = pin.hash;
      values.pin_salt = pin.salt;
      values.is_active = true;
    }

    const { data, error } = await db
      .rpc("m04_write_employee", {
        p_business_id: context.businessId, ...managementWriteActor(authority),
        p_employee_id: id, p_expected_updated_at: employee.updated_at,
        p_pin_snapshot: pinSnapshot, p_values: values,
      })
      .select(publicFields)
      .single();

    if (error || !data) {
      return writeFailure(error);
    }

    return readJson({
      success: true,
      businessId: context.businessId,
      employee: data,
    });
  } catch {
    return unavailable();
  }
}

export async function RESET_PIN(request: Request) {
  try {
    const member = await authorizedMember(request);
    if (!member.ok) {
      return member.response;
    }

    const { context } = member;

    if (!canManageTeam(context.role)) {
      return roleForbidden();
    }

    // Shared-device mode narrows authority to the PIN-verified employee.
    const managed = await managementAuthority(request, context);
    if (!managed.ok) {
      return managed.response;
    }

    const { authority } = managed;

    if (!canManageTeam(authority.role)) {
      return managementForbidden(authority, canManageTeam, "Your business role does not allow this Team change.");
    }

    const id = pinEmployeeId(request);

    if (!isUuid(id)) {
      return invalidRequest();
    }

    const body = await jsonBody(request, ["pin"]);

    if (!body || !validEmployeePin(body.pin)) {
      return invalidRequest("A 4–6 digit PIN is required.");
    }

    const db = serviceDb();

    const employee = await findEmployee(
      db,
      context.businessId,
      id,
    );

    if (!employee) {
      return readFailure(
        404,
        "EMPLOYEE_NOT_FOUND",
        "Employee not found.",
      );
    }

    if (!canModifyEmployee(authority.role, employee.role)) {
      return managementForbidden(authority, (actor) => canModifyEmployee(actor, employee.role),
        "Only a business owner can reset a manager or owner employee PIN.");
    }

    if (!employee.is_active) {
      return readFailure(
        409,
        "EMPLOYEE_INACTIVE",
        "Reactivate the employee with a new PIN instead.",
      );
    }

    const checked = await pinTaken(db, context.businessId, body.pin, id);
    if (checked.taken) return readFailure(409, "PIN_IN_USE", "That PIN is already assigned to another active employee.");

    const pin = await hashEmployeePin(body.pin);

    const { data, error } = await db
      .rpc("m04_write_employee", {
        p_business_id: context.businessId, ...managementWriteActor(authority),
        p_employee_id: id, p_expected_updated_at: employee.updated_at,
        p_pin_snapshot: checked.snapshot,
        p_values: {
        pin_hash: pin.hash,
        pin_salt: pin.salt,
        updated_by_user_id: context.userId,
        updated_at: new Date().toISOString(),
        },
      })
      .select(publicFields)
      .single();

    if (error || !data) {
      return writeFailure(error);
    }

    return readJson({
      success: true,
      businessId: context.businessId,
      employee: data,
    });
  } catch {
    return unavailable();
  }
}