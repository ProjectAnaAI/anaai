import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServiceClient } from "@/lib/supabase-server";
import { credentialId, verifyCredential } from "./device-security";
import { readFailure } from "./read-api";

export type Device = { id: string; business_id: string; name: string; credential_hash: string; credential_salt: string; revoked_at: string | null; failed_pin_attempts: number; pin_locked_until: string | null; updated_at: string };
export type Employee = { id: string; business_id: string; display_name: string; role: "employee" | "manager" | "owner"; is_active: boolean; updated_at: string };
export type EmployeeSession = { id: string; business_id: string; device_id: string; employee_id: string; token_hash: string; token_salt: string; created_at: string; expires_at: string; revoked_at: string | null };
export class IdentityFailure extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export function denied(): never { throw new IdentityFailure(401, "IDENTITY_UNAUTHORIZED", "Device or employee session is unavailable. Please unlock again."); }
export function identityFailure(error: unknown) {
  return error instanceof IdentityFailure ? readFailure(error.status, error.code, error.message) : readFailure(503, "SERVICE_UNAVAILABLE", "ZUDE identity is unavailable. Please retry.");
}
export function publicEmployee(employee: Employee) {
  return { id: employee.id, businessId: employee.business_id, name: employee.display_name, role: employee.role };
}
export function effectivePermissions(role: Employee["role"]) {
  if (role === "owner") return ["team:manage-employees", "team:manage-managers", "devices:manage"] as const;
  if (role === "manager") return ["team:manage-employees", "devices:manage"] as const;
  return [] as const;
}
// Authoritative "this stored device credential can never work again" answers.
// Clients may forget their local credential ONLY on these codes. They are
// distinct from IDENTITY_UNAUTHORIZED (no device credential presented, a
// request-shape problem, or an employee-session failure), which must never
// cause a registered device to be forgotten.
function deviceInvalid(): never { throw new IdentityFailure(401, "DEVICE_INVALID", "This device registration is not valid. Register this device again."); }
function deviceRevoked(): never { throw new IdentityFailure(401, "DEVICE_REVOKED", "This device registration was revoked. Register this device again."); }
// Verifies a presented device credential. Shared by the device-authenticated
// identity endpoints and by shared-device management authority.
async function verifiedDevice(token: string | null | undefined): Promise<{ db: SupabaseClient; device: Device }> {
  if (!token) denied();
  const id = credentialId(token);
  // A presented credential that is malformed, unknown, or has the wrong secret
  // share one code, so the response is not an oracle for which locators exist.
  if (!id) deviceInvalid();
  const db = createSupabaseServiceClient();
  const { data, error } = await db.from("zude_devices").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error("Device lookup failed");
  const device = data as Device | null;
  if (!device || !verifyCredential(token, device.credential_hash, device.credential_salt)) deviceInvalid();
  // Revocation is disclosed only to a holder of the verified secret.
  if (device.revoked_at) deviceRevoked();
  return { db, device };
}
export async function registeredDevice(request: Request): Promise<{ db: SupabaseClient; device: Device }> {
  // No business selector is accepted on this credential boundary. The single
  // bounded lookup is the only service access before device verification.
  if (request.headers.has("x-anaai-business-id") || new URL(request.url).search) denied();
  return verifiedDevice(request.headers.get("authorization")?.match(/^ZudeDevice (\S+)$/)?.[1]);
}
async function sessionIdentity(db: SupabaseClient, device: Device, token: string) {
  const id = credentialId(token);
  if (!id) denied();
  const result = await db.from("employee_sessions").select("*").eq("id", id).eq("business_id", device.business_id).eq("device_id", device.id).maybeSingle();
  if (result.error) throw new Error("Session lookup failed");
  const session = result.data as EmployeeSession | null;
  // The successful PIN reservation timestamp is also the device identity
  // generation. A later PIN attempt invalidates all prior sessions, including
  // those whose offline Lock request could not reach the server.
  if (!session || session.revoked_at || Date.parse(session.created_at) !== Date.parse(device.updated_at) || !(Date.parse(session.expires_at) > Date.now()) || !verifyCredential(token, session.token_hash, session.token_salt)) denied();
  const found = await db.from("employees").select("id,business_id,display_name,role,is_active,updated_at").eq("business_id", device.business_id).eq("id", session.employee_id).maybeSingle();
  if (found.error) throw new Error("Employee lookup failed");
  const employee = found.data as Employee | null;
  // Changes to PIN, role, or activation invalidate prior sessions, including
  // deactivate/reactivate cycles; permissions are always read afresh.
  if (!employee || !employee.is_active || !["owner", "manager", "employee"].includes(employee.role) || !(Date.parse(employee.updated_at) <= Date.parse(session.created_at))) denied();
  return { db, device, session, employee, permissions: effectivePermissions(employee.role) };
}
// Future M05/M06 handlers call this boundary, then explicitly require their own
// permission. Never accept employee role/business/employee ID from request data.
export async function employeeIdentity(request: Request, token: unknown) {
  if (!credentialId(token) || typeof token !== "string") denied();
  const { db, device } = await registeredDevice(request);
  return sessionIdentity(db, device, token);
}
// Shared-device mode on account-authenticated requests: a registered device
// sends its credential and current employee session alongside the account
// bearer token. Returns null when neither header is present (account mode).
// If either is present, both must verify; a device without a valid employee
// session never falls back to account authority.
export const SHARED_DEVICE_HEADER = "x-zude-device";
export const EMPLOYEE_SESSION_HEADER = "x-zude-employee-session";
export async function sharedDeviceIdentity(request: Request) {
  const deviceToken = request.headers.get(SHARED_DEVICE_HEADER);
  const sessionToken = request.headers.get(EMPLOYEE_SESSION_HEADER);
  if (deviceToken === null && sessionToken === null) return null;
  const { db, device } = await verifiedDevice(deviceToken);
  if (!sessionToken) denied();
  return sessionIdentity(db, device, sessionToken);
}

export type EmployeePermission = "team:manage-employees" | "team:manage-managers" | "devices:manage";
export async function authorizedEmployee(request: Request, token: unknown, permission: EmployeePermission) {
  const identity = await employeeIdentity(request, token);
  if (!(identity.permissions as readonly string[]).includes(permission)) {
    throw new IdentityFailure(403, "EMPLOYEE_FORBIDDEN", "Your employee permissions do not allow this action.");
  }
  return identity;
}
