import { apiGet, ZudeApiError } from "./api";
import { identityRequest, type IdentityResult } from "./employee-identity-api";
import { effectiveManagementRole, operationalIdentity } from "./operational-identity";
import type { BusinessRole } from "./today-api";

// Existing authenticated APIs only. The result deliberately contains no IDs,
// employee names, credentials, or raw responses, and is never persisted.
export async function checkAuthority(businessId: string, userId: string, sharedMode: boolean) {
  if (typeof __DEV__ === "undefined" || !__DEV__) throw new Error("Diagnostics unavailable.");
  const held = operationalIdentity(businessId);
  const account = await apiGet<{ success: true; business: { id: string; name: string; role: BusinessRole } }>(
    "/api/current-business", { businessId, expectedUserId: userId },
  );
  if (account.business.id !== businessId) throw new Error("Business verification failed.");
  let verified: IdentityResult | null = null;
  if (held.mode === "employee") {
    verified = await identityRequest<IdentityResult>("/api/employee-session/validate",
      { businessId, credential: held.credential }, { session: held.session });
    if (verified.employee.businessId !== account.business.id) throw new Error("PIN belongs to another business.");
    if (!(Date.parse(verified.expiresAt) > Date.now())) throw new Error("PIN session expired.");
  }
  const current = operationalIdentity(businessId);
  if (current.mode !== held.mode || (held.mode === "employee" &&
      (current.mode !== "employee" || current.session !== held.session || current.credential !== held.credential))) {
    throw new ZudeApiError(401, "SESSION_CHANGED", "Session changed. Check again.");
  }
  const shared = sharedMode || held.mode !== "account";
  return {
    business: account.business.name,
    accountRole: account.business.role,
    pinStatus: verified ? "Verified" : shared ? "Missing — shared device locked" : "Missing — account mode",
    pinRole: verified?.employee.role ?? "None",
    effectiveRole: shared && !verified ? "Locked" : effectiveManagementRole(account.business.role, shared, verified?.permissions),
    project: publicProjectReference(),
  };
}

function publicProjectReference() {
  try {
    const url = new URL(process.env.EXPO_PUBLIC_SUPABASE_URL || "");
    return /^([a-z0-9]{20})\.supabase\.co$/.exec(url.hostname)?.[1] ?? "Unverified (custom/local URL)";
  } catch { return "Unavailable"; }
}
