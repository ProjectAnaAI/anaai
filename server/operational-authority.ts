import type { BusinessContext, BusinessRole } from "@/lib/business-context";
import { IdentityFailure, sharedDeviceIdentity } from "./employee-identity";
import { readFailure } from "./read-api";

// Management authority for account-authenticated requests.
//
// A. Account/setup mode (no shared-device headers): the verified
//    business_members role applies, exactly as before. This is how an owner or
//    manager sets up Team and registers the first device.
// B. Shared-device mode (device credential + employee session headers): the
//    effective role is the WEAKER of the account role and the role implied by
//    the PIN-verified employee's permissions. An employee who unlocks an
//    owner-signed-in iPad therefore has no management authority.
//
// Nothing here is read from client-declared role/employee fields; employee
// identity comes only from server-verified credentials.
const rank: Record<BusinessRole, number> = { staff: 0, manager: 1, owner: 2 };
function employeeAuthorityRole(permissions: readonly string[]): BusinessRole {
  if (permissions.includes("team:manage-managers")) return "owner";
  if (permissions.includes("team:manage-employees")) return "manager";
  return "staff";
}
// Identifiers only: never retain credential/token/hash material in authority.
export type ManagementAuthority = { role: BusinessRole; accountRole: BusinessRole; accountUserId: string } & (
  | { mode: "account"; employeeId: null; deviceId: null; sessionId: null }
  | { mode: "shared-device"; employeeId: string; deviceId: string; sessionId: string }
);
// Only call with authority produced above, never with request body fields.
export function managementWriteActor(authority: ManagementAuthority) {
  return {
    p_actor_id: authority.accountUserId,
    p_authority_mode: authority.mode,
    p_expected_account_role: authority.accountRole,
    p_actor_employee_id: authority.employeeId,
    p_actor_device_id: authority.deviceId,
    p_actor_session_id: authority.sessionId,
  };
}
export async function managementAuthority(request: Request, context: BusinessContext):
  Promise<{ ok: true; authority: ManagementAuthority } | { ok: false; response: Response }> {
  try {
    const identity = await sharedDeviceIdentity(request);
    if (!identity) return { ok: true, authority: { mode: "account", role: context.role, accountRole: context.role, accountUserId: context.userId, employeeId: null, deviceId: null, sessionId: null } };
    // The device credential decides its business; it must match the verified
    // account business, never the other way round.
    if (identity.device.business_id !== context.businessId) {
      return { ok: false, response: readFailure(403, "DEVICE_BUSINESS_MISMATCH", "This device is registered to another business.") };
    }
    const employeeRole = employeeAuthorityRole(identity.permissions);
    const role = rank[employeeRole] < rank[context.role] ? employeeRole : context.role;
    return { ok: true, authority: { mode: "shared-device", role, accountRole: context.role, accountUserId: context.userId, employeeId: identity.employee.id, deviceId: identity.device.id, sessionId: identity.session.id } };
  } catch (error) {
    if (error instanceof IdentityFailure) return { ok: false, response: readFailure(error.status, error.code, error.message) };
    throw error;
  }
}
// When the account could act but the PIN-verified employee cannot, say so
// distinctly; otherwise keep the existing account-role code.
export function managementForbidden(authority: ManagementAuthority, allowed: (role: BusinessRole) => boolean, message: string) {
  return authority.mode === "shared-device" && allowed(authority.accountRole)
    ? readFailure(403, "EMPLOYEE_FORBIDDEN", "The employee signed in on this device is not allowed to do this.")
    : readFailure(403, "ROLE_FORBIDDEN", message);
}
