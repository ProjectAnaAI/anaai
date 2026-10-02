import { ZudeApiError } from "./api";
import type { BusinessRole } from "./today-api";

// Shared-device management authority (server/operational-authority.ts).
//
// "account"  – no shared-device registration: requests carry only the account.
// "employee" – a registered shared device with a PIN-verified employee: Team,
//              device and catalog management also carry the device credential
//              and employee session, so the server narrows authority to that
//              employee.
// "locked"   – a shared device with no verified employee (or storage not yet
//              confirmed): management requests are refused before sending.
//
// Held in memory only and published by the employee identity provider.
export type OperationalIdentity =
  | { mode: "account" }
  | { mode: "locked" }
  | { mode: "employee"; credential: string; session: string };
export type OperationalRejection = { code: string; credential: string; session: string };

let published: { businessId: string; identity: OperationalIdentity } | null = null;
const listeners = new Set<(rejection: OperationalRejection) => void>();

export function publishOperationalIdentity(businessId: string, identity: OperationalIdentity) {
  published = { businessId, identity };
}
// Nothing published (no identity provider) is account mode. A different
// business than the one published fails closed.
export function operationalIdentity(businessId: string): OperationalIdentity {
  if (!published) return { mode: "account" };
  return published.businessId === businessId ? published.identity : { mode: "locked" };
}
export function onOperationalRejection(listener: (rejection: OperationalRejection) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const IDENTITY_CODES = new Set(["IDENTITY_UNAUTHORIZED", "DEVICE_INVALID", "DEVICE_REVOKED"]);
// Wraps a management request. Identity rejections are reported to the identity
// provider (which locks, or runs device recovery); they are never retried.
export async function operationalRequest<T>(businessId: string, send: (headers: Record<string, string>) => Promise<T>): Promise<T> {
  const identity = operationalIdentity(businessId);
  if (identity.mode === "locked") throw new ZudeApiError(401, "IDENTITY_REQUIRED", "Unlock with an employee PIN to continue.");
  if (identity.mode === "account") return send({});
  try {
    return await send({ "x-zude-device": identity.credential, "x-zude-employee-session": identity.session });
  } catch (error) {
    if (error instanceof ZudeApiError && error.status === 401 && IDENTITY_CODES.has(error.code)) {
      for (const listener of [...listeners]) listener({ code: error.code, credential: identity.credential, session: identity.session });
    }
    throw error;
  }
}

// Presentation mirror of the server rule: the weaker of the account role and
// the role implied by the PIN-verified employee's permissions. The server
// remains authoritative.
const rank: Record<BusinessRole, number> = { staff: 0, manager: 1, owner: 2 };
export function effectiveManagementRole(accountRole: BusinessRole, sharedDevice: boolean, permissions: readonly string[] | null | undefined): BusinessRole {
  if (!sharedDevice) return accountRole;
  const employeeRole: BusinessRole = permissions?.includes("team:manage-managers") ? "owner"
    : permissions?.includes("team:manage-employees") ? "manager" : "staff";
  return rank[employeeRole] < rank[accountRole] ? employeeRole : accountRole;
}
