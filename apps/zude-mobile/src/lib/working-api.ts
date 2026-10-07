import { apiGet, ZudeApiError } from "./api";
import { operationalRequest } from "./operational-identity";
import type { ClockState, CurrentShift } from "./time-clock-api";
export type WorkingEmployee = { employee: { id: string; name: string; role: "employee" | "manager" | "owner"; isActive: boolean }; state: ClockState; stateStartedAt: string | null; shift: CurrentShift | null; inactiveOpenShift: boolean };
export type WorkingView = { businessId: string; timezone: string; snapshotAt: string; employees: WorkingEmployee[] };
const states = ['OFF_CLOCK', 'WORKING', 'ON_PAID_BREAK', 'ON_MEAL_BREAK'];
const instant = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v));
const duration = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const invalid = () => new ZudeApiError(0, "INVALID_RESPONSE", "Unable to verify Who's Working.");
export async function getWorking(businessId: string, signal: AbortSignal): Promise<WorkingView> {
  const data = await operationalRequest(businessId, headers => apiGet<WorkingView>("/api/management/working", { businessId, signal, headers }));
  if (!data || data.businessId !== businessId || !instant(data.snapshotAt) || !Array.isArray(data.employees) || data.employees.length > 200) throw invalid();
  try { new Intl.DateTimeFormat('en', { timeZone: data.timezone }).format(); } catch { throw invalid(); }
  if (typeof data.timezone !== 'string' || !data.timezone) throw invalid();
  const ids = new Set<string>();
  const employees = data.employees.map(row => {
    const e = row?.employee, s = row?.shift;
    if (!e || typeof e.id !== 'string' || !e.id || ids.has(e.id) || typeof e.name !== 'string' || typeof e.isActive !== 'boolean' || !['employee','manager','owner'].includes(e.role) || !states.includes(row.state) || (row.stateStartedAt !== null && !instant(row.stateStartedAt)) || row.inactiveOpenShift !== (!e.isActive && row.state !== 'OFF_CLOCK')) throw invalid();
    ids.add(e.id);
    if (row.state === 'OFF_CLOCK' ? s !== null : !s) throw invalid();
    if (s && (!instant(s.clockInAt) || typeof s.id !== 'string' || ![s.elapsedMs,s.workedMs,s.paidBreakMs,s.mealBreakMs].every(duration))) throw invalid();
    const b = s?.break;
    if (b && (!['PAID','MEAL'].includes(b.type) || !instant(b.startedAt) || !duration(b.durationMs) || !duration(b.intendedMinutes) || b.open !== true || b.endedAt !== null)) throw invalid();
    if ((row.state === 'ON_PAID_BREAK' || row.state === 'ON_MEAL_BREAK') && (!b || b.type !== (row.state === 'ON_PAID_BREAK' ? 'PAID' : 'MEAL'))) throw invalid();
    if (row.state === 'WORKING' && b) throw invalid();
    // Keep explicit safe fields; unexpected response properties never enter UI state.
    return { employee: { id:e.id,name:e.name,role:e.role,isActive:e.isActive },state:row.state,stateStartedAt:row.stateStartedAt,inactiveOpenShift:row.inactiveOpenShift,
      shift:s ? { id:s.id,clockInAt:s.clockInAt,elapsedMs:s.elapsedMs,workedMs:s.workedMs,paidBreakMs:s.paidBreakMs,mealBreakMs:s.mealBreakMs,
        break:b ? {type:b.type,intendedMinutes:b.intendedMinutes,startedAt:b.startedAt,endedAt:b.endedAt,open:b.open,durationMs:b.durationMs}:null }:null };
  });
  return { businessId,timezone:data.timezone,snapshotAt:data.snapshotAt,employees };
}
