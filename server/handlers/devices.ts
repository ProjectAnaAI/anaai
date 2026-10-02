import { isUuid } from "@/lib/appointment-actions";
import { createSupabaseServiceClient } from "@/lib/supabase-server";
import { authorizedMember, jsonBody, pathId, readAllPages } from "../member";
import { readFailure, readJson } from "../read-api";
import { managementAuthority, managementForbidden } from "../operational-authority";
import { issueCredential } from "../device-security";
import { validEmployeePin, verifyEmployeePin } from "../employee-security";
import { denied, employeeIdentity, identityFailure, publicEmployee, registeredDevice, type Employee } from "../employee-identity";

const safeDeviceFields = "id,business_id,name,registered_at,last_seen_at,revoked_at";
const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;
const SESSION_MS = 8 * 60 * 60 * 1000;
const invalid = () => readFailure(400, "INVALID_REQUEST", "Invalid ZUDE identity request.");
const canManageDevices = (role: string) => role === "owner" || role === "manager";
// Account owner/manager first (before any device lookup), then shared-device
// mode narrows authority to the PIN-verified employee (devices:manage).
async function administrator(request: Request) {
  const member = await authorizedMember(request);
  if (!member.ok) return member;
  if (!canManageDevices(member.context.role)) return { ok: false as const, response: readFailure(403, "ROLE_FORBIDDEN", "Your business role does not allow device management.") };
  const managed = await managementAuthority(request, member.context);
  if (!managed.ok) return managed;
  if (!canManageDevices(managed.authority.role)) return { ok: false as const, response: managementForbidden(managed.authority, canManageDevices, "Your business role does not allow device management.") };
  return member;
}
export async function REGISTER(request: Request) {
  try {
    const member = await administrator(request);
    if (!member.ok) return member.response;
    const body = await jsonBody(request, ["name"]);
    if (!body || typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 100 || new URL(request.url).search) return invalid();
    const issued = issueCredential();
    const db = createSupabaseServiceClient();
    const result = await db.from("zude_devices").insert({ id: issued.id, business_id: member.context.businessId, name: body.name.trim(), credential_hash: issued.hash, credential_salt: issued.salt, registered_by_user_id: member.context.userId }).select(safeDeviceFields).single();
    if (result.error || !result.data) throw new Error("Registration failed");
    return readJson({ success: true, device: result.data, credential: issued.credential }, 201);
  } catch (error) { return identityFailure(error); }
}
export async function DIRECTORY(request: Request) {
  try {
    const member = await administrator(request);
    if (!member.ok) return member.response;
    if (new URL(request.url).search) return invalid();
    const db = createSupabaseServiceClient();
    const devices = await readAllPages((from, to) => db.from("zude_devices").select(safeDeviceFields).eq("business_id", member.context.businessId).order("id").range(from, to));
    return readJson({ success: true, businessId: member.context.businessId, devices });
  } catch (error) { return identityFailure(error); }
}
export async function REVOKE(request: Request) {
  try {
    const member = await administrator(request);
    if (!member.ok) return member.response;
    const body = await jsonBody(request, []);
    const id = pathId(request);
    if (!body || !isUuid(id) || new URL(request.url).search) return invalid();
    const db = createSupabaseServiceClient();
    const now = new Date().toISOString();
    // Only an unrevoked row is written, so the first revoked_at and
    // revoked_by_user_id are the permanent audit record.
    const result = await db.from("zude_devices").update({ revoked_at: now, revoked_by_user_id: member.context.userId, updated_at: now }).eq("id", id).eq("business_id", member.context.businessId).is("revoked_at", null).select(safeDeviceFields).maybeSingle();
    if (result.error) throw new Error("Revocation failed");
    if (!result.data) {
      // Idempotent repeat: report the existing revocation without rewriting it.
      const existing = await db.from("zude_devices").select(safeDeviceFields).eq("id", id).eq("business_id", member.context.businessId).maybeSingle();
      if (existing.error) throw new Error("Revocation lookup failed");
      if (!existing.data) return readFailure(404, "DEVICE_NOT_FOUND", "Device not found.");
      return readJson({ success: true, device: existing.data });
    }
    // Session validation always validates the device; this revokes all its
    // sessions atomically without a second, potentially failing write.
    return readJson({ success: true, device: result.data });
  } catch (error) { return identityFailure(error); }
}
export async function PIN(request: Request) {
  try {
    const body = await jsonBody(request, ["pin"]);
    if (!body || !validEmployeePin(body.pin)) return invalid();
    const { db, device } = await registeredDevice(request);
    const now = Date.now();
    if (device.pin_locked_until && Date.parse(device.pin_locked_until) > now) return readFailure(429, "PIN_LOCKED", "PIN entry is temporarily locked. Please try again later.");
    const attempts = (device.pin_locked_until ? 0 : device.failed_pin_attempts) + 1;
    const stamp = new Date(Math.max(now, Date.parse(device.updated_at) + 1)).toISOString();
    // Reserve an attempt BEFORE scrypt. Conditional update serializes across
    // server workers; losers fail closed, never run uncounted PIN guesses.
    const reserved = await db.from("zude_devices").update({ failed_pin_attempts: attempts, last_failed_pin_at: stamp, updated_at: stamp, pin_locked_until: attempts >= MAX_ATTEMPTS ? new Date(now + LOCK_MS).toISOString() : null }).eq("id", device.id).eq("business_id", device.business_id).eq("updated_at", device.updated_at).is("revoked_at", null).select("id").maybeSingle();
    if (reserved.error) throw new Error("Attempt reservation failed");
    if (!reserved.data) return readFailure(429, "PIN_RETRY", "PIN entry is busy. Please try again.");
    const employees = await readAllPages<Employee & { pin_hash: string; pin_salt: string }>((from, to) => db.from("employees").select("id,business_id,display_name,role,is_active,updated_at,pin_hash,pin_salt").eq("business_id", device.business_id).eq("is_active", true).order("id").range(from, to));
    const matches: Employee[] = [];
    for (const employee of employees) if (await verifyEmployeePin(body.pin, employee.pin_hash, employee.pin_salt)) matches.push(employee);
    // Fail closed if legacy/concurrent Team writes produced ambiguous PINs.
    if (matches.length !== 1) return readFailure(401, "PIN_INVALID", "Unable to unlock with that PIN.");
    const created = new Date(Math.max(Date.now(), Date.parse(stamp) + 1)).toISOString();
    const reset = await db.from("zude_devices").update({ failed_pin_attempts: 0, last_failed_pin_at: null, pin_locked_until: null, last_seen_at: stamp, updated_at: created }).eq("id", device.id).eq("business_id", device.business_id).eq("updated_at", stamp).is("revoked_at", null).select("id").maybeSingle();
    if (reset.error) throw new Error("Attempt reset failed");
    if (!reset.data) return readFailure(429, "PIN_RETRY", "PIN entry is busy. Please try again.");
    const employee = matches[0];
    const issued = issueCredential();
    const expires = new Date(Date.parse(created) + SESSION_MS).toISOString();
    const result = await db.from("employee_sessions").insert({ id: issued.id, business_id: device.business_id, device_id: device.id, employee_id: employee.id, token_hash: issued.hash, token_salt: issued.salt, created_at: created, expires_at: expires });
    if (result.error) throw new Error("Session issuance failed");
    // Revalidate after issuance to close employee/device changes during scrypt.
    const identity = await employeeIdentity(request, issued.credential);
    if (identity.employee.updated_at !== employee.updated_at) denied();
    return readJson({ success: true, session: issued.credential, expiresAt: expires, employee: publicEmployee(identity.employee), permissions: identity.permissions }, 201);
  } catch (error) { return identityFailure(error); }
}
export async function VALIDATE(request: Request) {
  try {
    const body = await jsonBody(request, ["session"]);
    if (!body) return invalid();
    const identity = await employeeIdentity(request, body.session);
    return readJson({ success: true, employee: publicEmployee(identity.employee), permissions: identity.permissions, expiresAt: identity.session.expires_at });
  } catch (error) { return identityFailure(error); }
}
export async function LOCK(request: Request) {
  try {
    const body = await jsonBody(request, ["session"]);
    if (!body) return invalid();
    const { db, session, device } = await employeeIdentity(request, body.session);
    const result = await db.from("employee_sessions").update({ revoked_at: new Date().toISOString() }).eq("id", session.id).eq("business_id", device.business_id).eq("device_id", device.id).select("id").maybeSingle();
    if (result.error) throw new Error("Session lock failed");
    if (!result.data) denied();
    return readJson({ success: true });
  } catch (error) { return identityFailure(error); }
}
