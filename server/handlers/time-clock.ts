import { businessTimezone, employeeLedger, TimeFailure } from "../time-ledger";
import { isUuid } from "@/lib/appointment-actions";
import { jsonBody } from "../member";
import { readFailure, readJson } from "../read-api";
import { EMPLOYEE_SESSION_HEADER, IdentityFailure, employeeIdentity, publicEmployee } from "../employee-identity";
import { buildShifts, businessWeek, clockState, currentShiftView, dayView, windowTotals, type BreakType, type TimeEventType } from "../time-calculation";

// M05 Time Clock + My Time. Always "my clock": the employee, device and
// business come ONLY from the verified M04 device credential
// (Authorization: ZudeDevice …) and employee session (x-zude-employee-session).
// No account bearer token, business selector, employee ID, role, timestamp or
// duration is accepted from the client. A manager or owner PIN acts only on
// their own time.
//
// Every write goes through m05_record_time_event (serialized, re-verified,
// idempotent per Idempotency-Key, database-stamped).

type Identity = Awaited<ReturnType<typeof employeeIdentity>>;
const invalid = () => readFailure(400, "INVALID_REQUEST", "Invalid time clock request.");
const issueFields = "id,work_date,time_event_id,note,status,created_at";

function timeFailure(error: unknown) {
  if (error instanceof IdentityFailure || error instanceof TimeFailure) return readFailure(error.status, error.code, error.message);
  return readFailure(503, "TIME_UNAVAILABLE", "The ZUDE time clock is unavailable. Please retry.");
}
// Identity codes are preserved (DEVICE_INVALID / DEVICE_REVOKED drive M04
// device recovery). A race inside the write transaction — deactivated
// employee, revoked device, locked or expired session — is reported as
// IDENTITY_UNAUTHORIZED, never as a device rejection.
function rpcFailure(error: { code?: string } | null) {
  if (error?.code === "42501") return new IdentityFailure(401, "IDENTITY_UNAUTHORIZED", "Device or employee session is unavailable. Please unlock again.");
  if (error?.code === "22023") return new TimeFailure(400, "INVALID_REQUEST", "Invalid time clock request.");
  return new Error("Time clock write failed");
}
async function timeIdentity(request: Request) {
  return employeeIdentity(request, request.headers.get(EMPLOYEE_SESSION_HEADER));
}
async function timeView(identity: Identity) {
  const timezone = await businessTimezone(identity.db, identity.device.business_id);
  const { events, latest, snapshot } = await employeeLedger(identity.db, identity.device.business_id, identity.employee.id, businessWeek(Date.now(), timezone).startsAt);
  // Server "now", never earlier than the newest database-stamped event.
  const now = snapshot;
  const week = businessWeek(now, timezone);
  const shifts = buildShifts(events);
  const state = clockState(latest);
  const today = week.days.find((day) => day.date === week.today)!;
  return {
    timezone, week, shifts, now,
    summary: {
      businessId: identity.device.business_id, timezone, serverNow: new Date(now).toISOString(),
      employee: publicEmployee(identity.employee), state,
      shift: currentShiftView(shifts, state, now),
      today: { date: today.date, ...windowTotals(shifts, today.startsAt, today.endsAt, now) },
    },
  };
}

export async function STATE(request: Request) {
  try {
    const identity = await timeIdentity(request);
    return readJson({ success: true, ...(await timeView(identity)).summary });
  } catch (error) { return timeFailure(error); }
}

async function transition(request: Request, action: TimeEventType) {
  try {
    const identity = await timeIdentity(request);
    const key = request.headers.get("idempotency-key");
    const body = await jsonBody(request, action === "BREAK_START" ? ["breakType"] : []);
    const breakType = (action === "BREAK_START" ? body?.breakType : null) as BreakType | null;
    if (!body || !isUuid(key) || new URL(request.url).search || (action === "BREAK_START" && breakType !== "PAID" && breakType !== "MEAL")) return invalid();
    const { data, error } = await identity.db.rpc("m05_record_time_event", {
      p_business_id: identity.device.business_id, p_employee_id: identity.employee.id,
      p_device_id: identity.device.id, p_session_id: identity.session.id,
      p_action: action, p_break_type: breakType, p_request_id: key,
    });
    if (error) throw rpcFailure(error);
    const result = data as { ok?: unknown; replayed?: unknown; code?: unknown } | null;
    const view = (await timeView(identity)).summary;
    if (result?.ok !== true) {
      const code = result?.code === "TIME_REQUEST_CONFLICT" ? "TIME_REQUEST_CONFLICT" : "TIME_INVALID_TRANSITION";
      return readJson({ success: false, code, error: code === "TIME_REQUEST_CONFLICT" ? "This request was already used for a different action." : "That time clock action does not match your current status.", state: view.state }, 409);
    }
    return readJson({ success: true, replayed: result.replayed === true, ...view });
  } catch (error) { return timeFailure(error); }
}
export const CLOCK_IN = (request: Request) => transition(request, "CLOCK_IN");
export const BREAK_START = (request: Request) => transition(request, "BREAK_START");
export const BREAK_END = (request: Request) => transition(request, "BREAK_END");
export const CLOCK_OUT = (request: Request) => transition(request, "CLOCK_OUT");

// Self only, current business-local workweek only. No employee, week or date
// selector exists.
export async function MY_TIME(request: Request) {
  try {
    const identity = await timeIdentity(request);
    const { timezone, week, shifts, now, summary } = await timeView(identity);
    const issues = await identity.db.from("employee_time_issues").select(issueFields)
      .eq("business_id", identity.device.business_id).eq("employee_id", identity.employee.id)
      .gte("created_at", new Date(week.startsAt).toISOString()).order("created_at", { ascending: true }).limit(100);
    if (issues.error) throw new Error("Issue read failed");
    return readJson({
      success: true, ...summary, timezone,
      week: {
        startDate: week.startDate, endDate: week.endDate, today: week.today,
        startsAt: new Date(week.startsAt).toISOString(), endsAt: new Date(week.endsAt).toISOString(),
        ...windowTotals(shifts, week.startsAt, week.endsAt, now),
      },
      days: week.days.filter((day) => day.date <= week.today).map((day) => dayView(shifts, day, now)),
      issues: issues.data ?? [],
    });
  } catch (error) { return timeFailure(error); }
}

// Report a time issue: an append-only note for a manager (resolved in M06).
// It never edits, adds or removes time events.
export async function REPORT_ISSUE(request: Request) {
  try {
    const identity = await timeIdentity(request);
    const key = request.headers.get("idempotency-key");
    const body = await jsonBody(request, ["note", "workDate", "eventId"]);
    if (!body || !isUuid(key) || new URL(request.url).search) return invalid();
    const note = typeof body.note === "string" ? body.note.trim() : "";
    if (!note || note.length > 1000) return invalid();
    if (body.eventId !== undefined && body.eventId !== null && !isUuid(body.eventId)) return invalid();
    const timezone = await businessTimezone(identity.db, identity.device.business_id);
    const week = businessWeek(Date.now(), timezone);
    // Only a day of the employee's current week, up to today.
    if (body.workDate !== undefined && body.workDate !== null && !week.days.some((day) => day.date === body.workDate && day.date <= week.today)) return invalid();
    const { data, error } = await identity.db.rpc("m05_report_time_issue", {
      p_business_id: identity.device.business_id, p_employee_id: identity.employee.id,
      p_device_id: identity.device.id, p_session_id: identity.session.id, p_request_id: key,
      p_work_date: body.workDate ?? null, p_time_event_id: body.eventId ?? null, p_note: note,
    });
    if (error) throw rpcFailure(error);
    const result = data as { ok?: unknown; replayed?: unknown; issue?: unknown } | null;
    // A request key reused for a different note, day or event is refused
    // rather than silently answered with the original report.
    if (result?.ok !== true) return readFailure(409, "TIME_REQUEST_CONFLICT", "This request was already used for a different report.");
    return readJson({ success: true, replayed: result.replayed === true, issue: result.issue }, result.replayed === true ? 200 : 201);
  } catch (error) { return timeFailure(error); }
}
