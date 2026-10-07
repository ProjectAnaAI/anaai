import { createSupabaseServiceClient } from "@/lib/supabase-server";
import { authorizedMember } from "../member";
import { managementAuthority, managementForbidden } from "../operational-authority";
import { readFailure, readJson } from "../read-api";
import { buildShifts, clockState, currentShiftView } from "../time-calculation";
import { TimeFailure, workingLedger } from "../time-ledger";

const allowed = (role: string) => role === "manager" || role === "owner";
export async function GET(request: Request) {
  try {
    const member = await authorizedMember(request);
    if (!member.ok) return member.response;
    const managed = await managementAuthority(request, member.context);
    if (!managed.ok) return managed.response;
    if (!allowed(managed.authority.role)) return managementForbidden(managed.authority, allowed, "Who's Working is for managers and owners.");
    if (new URL(request.url).search) return readFailure(400, "INVALID_REQUEST", "This working roster does not accept filters.");
    const ledger = await workingLedger(createSupabaseServiceClient(), member.context.businessId);
    const employees = ledger.employees.flatMap(({ employee, latest, events }) => {
      const state = clockState(latest);
      if (!employee.isActive && state === "OFF_CLOCK") return [];
      return [{ employee, state, stateStartedAt: latest?.occurred_at ?? null,
        shift: currentShiftView(buildShifts(events), state, ledger.snapshot),
        inactiveOpenShift: !employee.isActive && state !== "OFF_CLOCK" }];
    });
    employees.sort((a, b) => Number(a.state === "OFF_CLOCK") - Number(b.state === "OFF_CLOCK") || a.employee.name.localeCompare(b.employee.name) || a.employee.id.localeCompare(b.employee.id));
    return readJson({ success: true, businessId: member.context.businessId, timezone: ledger.timezone,
      snapshotAt: new Date(ledger.snapshot).toISOString(), employees });
  } catch (error) {
    if (error instanceof TimeFailure) return readFailure(error.status, error.code, error.message);
    return readFailure(503, "TIME_UNAVAILABLE", "Unable to load Who's Working. Please retry.");
  }
}
