import { isUuid } from "@/lib/appointment-actions";
import { createSupabaseServiceClient } from "@/lib/supabase-server";
import { authorizedMember, jsonBody, pathId } from "../member";
import { managementAuthority, managementForbidden, managementWriteActor, type ManagementAuthority } from "../operational-authority";
import { readFailure, readJson } from "../read-api";
import { buildShifts, dayView, windowTotals, type BusinessWeek } from "../time-calculation";
import { businessTimezone, historicalLedger, MAX_WORKING_ROSTER, resolveWeek, TimeFailure, timesheetLimit, type HistoricalEvent } from "../time-ledger";

const employeeFields = 'id,display_name,role,is_active';
type Target = { id: string; display_name: string; role: 'employee' | 'manager' | 'owner'; is_active: boolean };
const safeEmployee = (row: Target) => ({ id: row.id, name: row.display_name, role: row.role, isActive: row.is_active });
const manager = (role: string) => role === 'manager' || role === 'owner';
// Preserve Team's existing owner-employee policy, without adding provisioning.
// The same hierarchy is enforced transactionally for corrections in SQL.
const mayRead = (actor: string, target: string) => actor === 'owner' || (actor === 'manager' && target === 'employee');
async function authority(request: Request) {
  const member = await authorizedMember(request);
  if (!member.ok) return member;
  const managed = await managementAuthority(request, member.context);
  if (!managed.ok) return managed;
  if (!manager(managed.authority.role)) return { ok: false as const,
    response: managementForbidden(managed.authority, manager, 'Timesheets are for managers and owners.') };
  return { ok: true as const, businessId: member.context.businessId, role: managed.authority.role, authority: managed.authority };
}
function failure(error: unknown) {
  return error instanceof TimeFailure ? readFailure(error.status, error.code, error.message)
    : readFailure(503, 'TIME_UNAVAILABLE', 'Unable to load timesheets. Please retry.');
}
// Safe, server-filtered picker. Includes inactive employees with historical time.
export async function DIRECTORY(request: Request) {
  try {
    const actor = await authority(request);
    if (!actor.ok) return actor.response;
    if (new URL(request.url).search) return readFailure(400, 'INVALID_REQUEST', 'The timesheet directory does not accept filters.');
    let query = createSupabaseServiceClient().from('employees').select(employeeFields, { count: 'exact' }).eq('business_id', actor.businessId);
    if (actor.role === 'manager') query = query.eq('role', 'employee');
    const result = await query.order('display_name').order('id').limit(MAX_WORKING_ROSTER + 1);
    if (result.error || !result.data || result.count === null) throw new Error('Directory read failed');
    if (result.count > MAX_WORKING_ROSTER) throw timesheetLimit();
    if (result.data.length !== result.count) throw new Error('Incomplete directory');
    return readJson({ success: true, businessId: actor.businessId, employees: (result.data as Target[]).map(safeEmployee) });
  } catch (error) { return failure(error); }
}
type WeekContext = { week: BusinessWeek; navigation: { currentWeekStart: string; previousWeekStart: string; nextWeekStart: string | null } };
// One response shape for reads, previews and committed corrections. Totals
// always come from the M05 calculation helpers over effective events.
export function timesheetBody(businessId: string, employee: Target, timezone: string, snapshot: number, { week, navigation }: WeekContext, events: HistoricalEvent[]) {
  const shifts = buildShifts(events);
  let shiftId = "";
  return { success: true, businessId, employee: safeEmployee(employee), timezone,
    snapshotAt: new Date(snapshot).toISOString(), ...navigation,
    week: { startDate: week.startDate, endDate: week.endDate, startsAt: new Date(week.startsAt).toISOString(), endsAt: new Date(week.endsAt).toISOString() },
    totals: { ...windowTotals(shifts, week.startsAt, week.endsAt, snapshot), hasOpenShift: shifts.some(s => s.end === null) },
    days: week.days.map(day => dayView(shifts, day, snapshot)),
    // Carry-in/out detail is deliberately retained; UI labels out-of-week
    // events as shift context. Only totals are clipped to the selected week.
    // Provenance: original vs. correction-inserted, and whether a correction
    // replaced its time. No actor, session or device details.
    events: events.map(e => {
      if (e.event_type === "CLOCK_IN") shiftId = e.id;
      return { id: e.id, shiftId, seq: e.seq, type: e.event_type, breakType: e.break_type, occurredAt: e.occurred_at,
        origin: e.origin ?? 'original', corrected: e.replaced ?? false, correctionRevision: e.correction_revision ?? null };
    }),
  };
}
async function target(businessId: string, role: string, id: string) {
  const db = createSupabaseServiceClient();
  const found = await db.from('employees').select(employeeFields).eq('business_id', businessId).eq('id', id).maybeSingle();
  if (found.error) throw new Error('Target lookup failed');
  if (!found.data) return { ok: false as const, response: readFailure(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found.') };
  const employee = found.data as Target;
  if (!mayRead(role, employee.role)) return { ok: false as const, response: readFailure(403, 'ROLE_FORBIDDEN', 'Your current role cannot view this employee’s timesheets.') };
  return { ok: true as const, db, employee };
}
export async function GET(request: Request) {
  try {
    const actor = await authority(request);
    if (!actor.ok) return actor.response;
    const id = pathId(request), params = new URL(request.url).searchParams;
    if (!isUuid(id) || [...params.keys()].some(key => key !== 'weekStart') || params.getAll('weekStart').length > 1) {
      return readFailure(400, 'INVALID_REQUEST', 'Choose an employee and business week.');
    }
    const found = await target(actor.businessId, actor.role, id);
    if (!found.ok) return found.response;
    const ledger = await historicalLedger(found.db, actor.businessId, id, params.get('weekStart'));
    return readJson(timesheetBody(actor.businessId, found.employee, ledger.timezone, ledger.snapshot, ledger, ledger.events));
  } catch (error) { return failure(error); }
}

// ---- Corrections (backend only; no correction UI in Slice 4) -------------------------------
// POST /api/management/timesheets/:employeeId/corrections/preview
// POST /api/management/timesheets/:employeeId/corrections
//
// Operations (applied in order; logical ids come from Timesheet event ids):
//   { op: "INSERT", type, breakType?, occurredAt, after | before | afterRef | atStart, ref? }
//   { op: "REPLACE", target, occurredAt, breakType? }   same position and type
//   { op: "VOID", target }
// The client proposes historical times; SQL validates the whole resulting
// ledger with the M05 transition rule and the database clock. Preview never
// authorizes a commit: commit re-verifies everything under the employee lock.
const MAX_OPERATIONS = 20;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;
const operationKeys: Record<string, readonly string[]> = {
  INSERT: ['op', 'type', 'breakType', 'occurredAt', 'after', 'before', 'afterRef', 'atStart', 'ref'],
  REPLACE: ['op', 'target', 'occurredAt', 'breakType'],
  VOID: ['op', 'target'],
};
const correctionReasons = new Set(['ANCHOR_NOT_FOUND', 'TARGET_NOT_FOUND', 'TARGET_VOIDED', 'INVALID_OPERATION', 'FUTURE_EVENT', 'OUT_OF_ORDER', 'INVALID_TRANSITION']);
// Shape only; SQL is authoritative for every rule.
function validOperations(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= MAX_OPERATIONS && value.every(op => {
    if (!op || typeof op !== 'object' || Array.isArray(op)) return false;
    const o = op as Record<string, unknown>, keys = operationKeys[o.op as string];
    if (!keys || Object.keys(o).some(k => !keys.includes(k))) return false;
    if (o.occurredAt !== undefined && (typeof o.occurredAt !== 'string' || !instantPattern.test(o.occurredAt) || !Number.isFinite(Date.parse(o.occurredAt)))) return false;
    if (o.breakType !== undefined && o.breakType !== null && o.breakType !== 'PAID' && o.breakType !== 'MEAL') return false;
    for (const k of ['target', 'after', 'before']) if (o[k] !== undefined && !isUuid(o[k])) return false;
    return true;
  });
}
// /api/management/timesheets/:employeeId/corrections[/preview]
function correctionTarget(request: Request, preview: boolean) {
  const parts = new URL(request.url).pathname.split('/').filter(Boolean);
  const tail = preview ? ['corrections', 'preview'] : ['corrections'];
  const ok = parts.slice(-tail.length).join('/') === tail.join('/');
  const id = ok ? decodeURIComponent(parts[parts.length - tail.length - 1] ?? '') : '';
  return isUuid(id) ? id : null;
}
function correctionFailure(error: { code?: string; message?: string; details?: string | null }) {
  if (error.code === '28000') return readFailure(401, 'IDENTITY_UNAUTHORIZED', 'Device or employee session is unavailable. Please unlock again.');
  if (error.code === '42501') return readFailure(403, 'ROLE_FORBIDDEN', 'Your current role cannot correct this employee’s time.');
  if (error.code === 'Z0003') return readFailure(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found.');
  if (error.code === 'Z0001' && error.message && correctionReasons.has(error.message)) {
    return readJson({ success: false, code: 'TIME_CORRECTION_INVALID', reason: error.message,
      eventId: isUuid(error.details) ? error.details : null,
      error: 'This correction would leave an invalid time record.' }, 422);
  }
  if (error.code === '22023' || error.code?.startsWith('22')) return readFailure(400, 'INVALID_REQUEST', 'Invalid time correction.');
  return null;
}
async function correction(request: Request, preview: boolean) {
  try {
    const actor = await authority(request);
    if (!actor.ok) return actor.response;
    const id = correctionTarget(request, preview);
    const key = request.headers.get('idempotency-key');
    const body = await jsonBody(request, preview ? ['weekStart', 'operations'] : ['weekStart', 'operations', 'reason', 'expectedRevision', 'expectedWatermark']);
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    if (!id || !body || new URL(request.url).search || !validOperations(body.operations) ||
        (body.weekStart !== undefined && typeof body.weekStart !== 'string') ||
        (!preview && (!isUuid(key) || !reason || reason.length > 500 ||
          !Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 0 ||
          !Number.isSafeInteger(body.expectedWatermark) || (body.expectedWatermark as number) < 0))) {
      return readFailure(400, 'INVALID_REQUEST', 'Invalid time correction.');
    }
    const found = await target(actor.businessId, actor.role, id);
    if (!found.ok) return found.response;
    const timezone = await businessTimezone(found.db, actor.businessId);
    const requestedWeek = (body.weekStart as string | undefined) ?? null;
    const context = resolveWeek(timezone, Date.now(), requestedWeek);
    const { data, error } = await found.db.rpc('m06_correct_employee_time', {
      p_business_id: actor.businessId, p_employee_id: id, ...managementWriteActor(actor.authority as ManagementAuthority),
      p_operations: body.operations, p_reason: preview ? null : reason, p_request_id: preview ? null : key,
      p_expected_revision: preview ? null : body.expectedRevision, p_expected_watermark: preview ? null : body.expectedWatermark,
      p_commit: !preview,
      p_window_start: new Date(context.week.startsAt).toISOString(), p_window_end: new Date(context.week.endsAt).toISOString(),
    });
    if (error) {
      const mapped = correctionFailure(error);
      if (mapped) return mapped;
      throw new Error('Correction failed');
    }
    const result = data as { ok?: unknown; code?: unknown; replayed?: unknown; correction_id?: unknown; revision?: unknown; watermark?: unknown; state?: unknown;
      events?: HistoricalEvent[] | null; head?: { occurred_at: string } | null } | null;
    if (result?.ok !== true) {
      if (result?.code === 'TIME_CORRECTION_STALE') return readJson({ success: false, code: 'TIME_CORRECTION_STALE',
        error: 'This timesheet changed. Refresh and preview the correction again.', revision: result.revision, watermark: result.watermark }, 409);
      if (result?.code === 'TIME_REQUEST_CONFLICT') return readFailure(409, 'TIME_REQUEST_CONFLICT', 'This request was already used for a different correction.');
      throw new Error('Unexpected correction result');
    }
    if (preview) {
      const snapshot = Math.max(Date.now(), result.head ? Date.parse(result.head.occurred_at) : 0);
      return readJson({ ...timesheetBody(actor.businessId, found.employee, timezone, snapshot, context, result.events ?? []),
        preview: true, correction: { basedOnRevision: result.revision, basedOnWatermark: result.watermark, resultingState: result.state } });
    }
    // Committed (or an exact replay): return the fresh authoritative week.
    const ledger = await historicalLedger(found.db, actor.businessId, id, requestedWeek);
    return readJson({ ...timesheetBody(actor.businessId, found.employee, ledger.timezone, ledger.snapshot, ledger, ledger.events),
      correction: { id: result.correction_id, revision: result.revision, watermark: result.watermark, replayed: result.replayed === true } },
      result.replayed === true ? 200 : 201);
  } catch (error) { return failure(error); }
}
export const PREVIEW_CORRECTION = (request: Request) => correction(request, true);
export const COMMIT_CORRECTION = (request: Request) => correction(request, false);
