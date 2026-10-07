import { apiGet, apiWrite, ZudeApiError } from "./api";
import { operationalRequest } from "./operational-identity";
import type { TimeDay, Totals, BreakRecord } from "./time-clock-api";

export type TimesheetEmployee = { id: string; name: string; role: 'employee' | 'manager' | 'owner'; isActive: boolean };
export type TimesheetDirectory = { businessId: string; employees: TimesheetEmployee[] };
// Provenance (management only): `origin` inserted = added by a correction;
// `corrected` = an earlier correction changed this event's time or break type.
export type LedgerEvent = { id: string; shiftId: string; seq: number; type: 'CLOCK_IN' | 'CLOCK_OUT' | 'BREAK_START' | 'BREAK_END'; breakType: 'PAID' | 'MEAL' | null; occurredAt: string;
  origin: 'original' | 'inserted'; corrected: boolean; correctionRevision: number | null };
export type Timesheet = {
  businessId: string; employee: TimesheetEmployee; timezone: string; snapshotAt: string;
  currentWeekStart: string; previousWeekStart: string; nextWeekStart: string | null;
  week: { startDate: string; endDate: string; startsAt: string; endsAt: string };
  totals: Totals & { hasOpenShift: boolean }; days: TimeDay[]; events: LedgerEvent[];
};
const invalid = () => new ZudeApiError(0, 'INVALID_RESPONSE', 'Unable to verify this timesheet.');
const date = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v));
const instant = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v));
const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
function employee(e: TimesheetEmployee) {
  if (!e || typeof e.id !== 'string' || !e.id || typeof e.name !== 'string' || !['employee','manager','owner'].includes(e.role) || typeof e.isActive !== 'boolean') throw invalid();
  return { id: e.id, name: e.name, role: e.role, isActive: e.isActive };
}
function totals(t: Totals) {
  if (!t || ![t.workedMs,t.paidBreakMs,t.mealBreakMs].every(finite)) throw invalid();
  return { workedMs: t.workedMs, paidBreakMs: t.paidBreakMs, mealBreakMs: t.mealBreakMs };
}
function breakRecord(b: BreakRecord) {
  if (!b || !['PAID','MEAL'].includes(b.type) || !instant(b.startedAt) || (b.endedAt !== null && !instant(b.endedAt)) || b.open !== (b.endedAt === null) || !finite(b.durationMs) || !finite(b.intendedMinutes)) throw invalid();
  return { type:b.type,startedAt:b.startedAt,endedAt:b.endedAt,open:b.open,durationMs:b.durationMs,intendedMinutes:b.intendedMinutes };
}
function day(d: TimeDay) {
  if (!d || !date(d.date) || !instant(d.startsAt) || !instant(d.endsAt) || !Array.isArray(d.shifts) || d.shifts.length > 10000) throw invalid();
  return { date:d.date,startsAt:d.startsAt,endsAt:d.endsAt,...totals(d),shifts:d.shifts.map(s => {
    if (!s || typeof s.id !== 'string' || !instant(s.clockInAt) || (s.clockOutAt !== null && !instant(s.clockOutAt)) || s.open !== (s.clockOutAt === null) || typeof s.continuesFromPreviousDay !== 'boolean' || typeof s.continuesNextDay !== 'boolean' || !Array.isArray(s.breaks) || s.breaks.length > 10000) throw invalid();
    return { id:s.id,clockInAt:s.clockInAt,clockOutAt:s.clockOutAt,open:s.open,continuesFromPreviousDay:s.continuesFromPreviousDay,continuesNextDay:s.continuesNextDay,...totals(s),breaks:s.breaks.map(breakRecord) };
  }) };
}
export async function getTimesheetDirectory(businessId: string, signal: AbortSignal): Promise<TimesheetDirectory> {
  const data = await operationalRequest(businessId, headers => apiGet<TimesheetDirectory>('/api/management/timesheets', { businessId, signal, headers }));
  if (!data || data.businessId !== businessId || !Array.isArray(data.employees) || data.employees.length > 200) throw invalid();
  const employees = data.employees.map(employee);
  if (new Set(employees.map(e => e.id)).size !== employees.length) throw invalid();
  return { businessId, employees };
}
export async function getTimesheet(businessId: string, employeeId: string, weekStart: string | null, signal: AbortSignal): Promise<Timesheet> {
  const path = `/api/management/timesheets/${encodeURIComponent(employeeId)}${weekStart ? `?weekStart=${encodeURIComponent(weekStart)}` : ''}`;
  const data = await operationalRequest(businessId, headers => apiGet<Timesheet>(path, { businessId, signal, headers }));
  return parseTimesheet(data, businessId, employeeId, weekStart);
}
// One validator for Timesheet reads, correction previews and committed results.
export function parseTimesheet(data: Timesheet, businessId: string, employeeId: string, weekStart: string | null): Timesheet {
  if (!data || data.businessId !== businessId || data.employee?.id !== employeeId || !instant(data.snapshotAt) || typeof data.timezone !== 'string' || !data.timezone) throw invalid();
  try { new Intl.DateTimeFormat('en', {timeZone:data.timezone}).format(); } catch { throw invalid(); }
  const w = data.week;
  if (!w || !date(w.startDate) || !date(w.endDate) || !instant(w.startsAt) || !instant(w.endsAt) || (weekStart !== null && w.startDate !== weekStart) || !date(data.currentWeekStart) || !date(data.previousWeekStart) || (data.nextWeekStart !== null && !date(data.nextWeekStart)) || w.startDate > data.currentWeekStart || typeof data.totals?.hasOpenShift !== 'boolean' || !Array.isArray(data.days) || data.days.length !== 7 || !Array.isArray(data.events) || data.events.length > 10000) throw invalid();
  const days = data.days.map(day);
  if (new Set(days.map(d => d.date)).size !== 7 || days[0].date !== w.startDate || days[6].date !== w.endDate || days.some((d,i)=>i>0&&d.date<=days[i-1].date)) throw invalid();
  let previous = 0;
  const ids = new Set<string>();
  const events = data.events.map(e => {
    if (!e || typeof e.id !== 'string' || ids.has(e.id) || typeof e.shiftId !== 'string' || !Number.isSafeInteger(e.seq) || e.seq <= previous || !instant(e.occurredAt) || !['CLOCK_IN','CLOCK_OUT','BREAK_START','BREAK_END'].includes(e.type) || (e.type.startsWith('BREAK_') ? !['PAID','MEAL'].includes(e.breakType ?? '') : e.breakType !== null)) throw invalid();
    const origin = e.origin ?? 'original', corrected = e.corrected ?? false, correctionRevision = e.correctionRevision ?? null;
    if (!['original','inserted'].includes(origin) || typeof corrected !== 'boolean' || (correctionRevision !== null && !(Number.isSafeInteger(correctionRevision) && correctionRevision > 0))) throw invalid();
    ids.add(e.id); previous = e.seq;
    return { id:e.id,shiftId:e.shiftId,seq:e.seq,type:e.type,breakType:e.breakType,occurredAt:e.occurredAt,origin,corrected,correctionRevision };
  });
  return { businessId,employee:employee(data.employee),timezone:data.timezone,snapshotAt:data.snapshotAt,
    currentWeekStart:data.currentWeekStart,previousWeekStart:data.previousWeekStart,nextWeekStart:data.nextWeekStart,
    week:{startDate:w.startDate,endDate:w.endDate,startsAt:w.startsAt,endsAt:w.endsAt},totals:{...totals(data.totals),hasOpenShift:data.totals.hasOpenShift},days,events };
}
// ---- Corrections (M06 Slice 4 API) -----------------------------------------------------------
// Logical event ids come from Timesheet events; anchors are never indexes.
export type CorrectionOperation =
  | { op: 'INSERT'; type: LedgerEvent['type']; breakType?: 'PAID' | 'MEAL'; occurredAt: string; after?: string; before?: string; afterRef?: string; atStart?: true; ref?: string }
  | { op: 'REPLACE'; target: string; occurredAt: string; breakType?: 'PAID' | 'MEAL' }
  | { op: 'VOID'; target: string };
export type ClockState = 'OFF_CLOCK' | 'WORKING' | 'ON_PAID_BREAK' | 'ON_MEAL_BREAK';
export type CorrectionPreview = { timesheet: Timesheet; basedOnRevision: number; basedOnWatermark: number; resultingState: ClockState };
export type CorrectionCommit = { operations: CorrectionOperation[]; reason: string; expectedRevision: number; expectedWatermark: number; weekStart: string };
export type CorrectionReceipt = { timesheet: Timesheet; id: string; revision: number; replayed: boolean };
const counter = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
const correctionPath = (employeeId: string, preview: boolean) => `/api/management/timesheets/${encodeURIComponent(employeeId)}/corrections${preview ? '/preview' : ''}`;
// Server-authoritative preview. Nothing is written; inserted events carry
// provisional ids. The returned revision/watermark are what a commit must send.
export async function previewTimeCorrection(businessId: string, employeeId: string, request: { operations: CorrectionOperation[]; weekStart: string }, signal: AbortSignal): Promise<CorrectionPreview> {
  const data = await operationalRequest(businessId, headers => apiWrite<Timesheet & { preview?: unknown; correction?: { basedOnRevision?: unknown; basedOnWatermark?: unknown; resultingState?: unknown } }>(
    correctionPath(employeeId, true), { operations: request.operations, weekStart: request.weekStart }, { businessId, signal, headers, method: 'POST' }));
  const c = data?.correction;
  if (data?.preview !== true || !c || !counter(c.basedOnRevision) || !counter(c.basedOnWatermark) || !['OFF_CLOCK','WORKING','ON_PAID_BREAK','ON_MEAL_BREAK'].includes(c.resultingState as string)) throw invalid();
  return { timesheet: parseTimesheet(data, businessId, employeeId, request.weekStart), basedOnRevision: c.basedOnRevision as number,
    basedOnWatermark: c.basedOnWatermark as number, resultingState: c.resultingState as ClockState };
}
// Commit with one idempotency key per intended correction. A retry after an
// uncertain response MUST reuse the same key and the same request.
export async function commitTimeCorrection(businessId: string, employeeId: string, expectedUserId: string, request: CorrectionCommit, idempotencyKey: string): Promise<CorrectionReceipt> {
  const data = await operationalRequest(businessId, headers => apiWrite<Timesheet & { correction?: { id?: unknown; revision?: unknown; replayed?: unknown } }>(
    correctionPath(employeeId, false), { operations: request.operations, reason: request.reason, expectedRevision: request.expectedRevision, expectedWatermark: request.expectedWatermark, weekStart: request.weekStart },
    { businessId, expectedUserId, method: 'POST', headers: { ...headers, 'Idempotency-Key': idempotencyKey } }));
  const c = data?.correction;
  if (!c || typeof c.id !== 'string' || !c.id || !Number.isSafeInteger(c.revision) || (c.revision as number) < 1 || typeof c.replayed !== 'boolean') throw invalid();
  return { timesheet: parseTimesheet(data, businessId, employeeId, request.weekStart), id: c.id, revision: c.revision as number, replayed: c.replayed };
}

export function timesheetMessage(error: unknown) {
  if (error instanceof ZudeApiError) {
    if (error.status === 401) return 'Your session ended. Unlock or sign in again to continue.';
    if (error.status === 403 || error.code === 'EMPLOYEE_NOT_FOUND') return 'This employee’s timesheet is no longer available to your current role.';
    if (error.code === 'TIMESHEET_LIMIT_EXCEEDED') return 'The complete timesheet or employee list is too large to load. Contact your ZUDE administrator.';
    if (error.code === 'TIME_CONFIGURATION_UNAVAILABLE') return 'The business timezone is not configured. Ask an owner to check business settings.';
    if (error.code === 'NETWORK_ERROR') return 'Unable to reach ZUDE. Check your connection and retry.';
    if (error.code === 'INVALID_WEEK' || error.code === 'FUTURE_WEEK') return 'This business week is unavailable. Return to the current week.';
  }
  return 'Unable to load timesheets. Please retry.';
}
