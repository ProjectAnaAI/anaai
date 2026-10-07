import { apiUrl, ZudeApiError } from "./api";
import { operationalIdentity, reportIdentityRejection } from "./operational-identity";

// M05 Time Clock + My Time (server/handlers/time-clock.ts).
//
// Always "my clock": requests carry ONLY the registered device credential and
// the PIN-verified employee session. No account token, business ID, employee
// ID, role, timestamp or duration is sent; the server derives all of it. In
// account mode or while locked, nothing is sent.
export type ClockState = "OFF_CLOCK" | "WORKING" | "ON_PAID_BREAK" | "ON_MEAL_BREAK";
export type BreakType = "PAID" | "MEAL";
export type TimeAction = "clock-in" | "break-start" | "break-end" | "clock-out";
export type Totals = { workedMs: number; paidBreakMs: number; mealBreakMs: number };
export type BreakRecord = { type: BreakType; intendedMinutes: number; startedAt: string; endedAt: string | null; open: boolean; durationMs: number };
export type CurrentShift = Totals & { id: string; clockInAt: string; elapsedMs: number; break: BreakRecord | null };
export type TimeEmployee = { id: string; name: string; role: "employee" | "manager" | "owner" };
export type TimeClockView = {
  businessId: string; timezone: string; serverNow: string; employee: TimeEmployee; state: ClockState;
  shift: CurrentShift | null; today: Totals & { date: string };
};
export type DayShift = Totals & { id: string; clockInAt: string; clockOutAt: string | null; open: boolean; continuesFromPreviousDay: boolean; continuesNextDay: boolean; breaks: BreakRecord[] };
export type TimeDay = Totals & { date: string; startsAt: string; endsAt: string; shifts: DayShift[] };
export type TimeIssue = { id: string; work_date: string | null; time_event_id: string | null; note: string; status: "open" | "resolved"; created_at: string };
export type MyTimeView = TimeClockView & {
  week: Totals & { startDate: string; endDate: string; today: string; startsAt: string; endsAt: string };
  days: TimeDay[]; issues: TimeIssue[];
};

const STATES: readonly ClockState[] = ["OFF_CLOCK", "WORKING", "ON_PAID_BREAK", "ON_MEAL_BREAK"];
const invalidResponse = () => new ZudeApiError(0, "INVALID_RESPONSE", "Invalid response from ZUDE.");
const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const totals = (value: unknown) => {
  const record = value as Partial<Totals> | null;
  return !!record && finite(record.workedMs) && finite(record.paidBreakMs) && finite(record.mealBreakMs);
};

async function timeRequest<T>(businessId: string, path: string, options: { method?: "GET" | "POST"; body?: Record<string, unknown>; requestKey?: string; signal?: AbortSignal } = {}): Promise<T> {
  const identity = operationalIdentity(businessId);
  if (identity.mode !== "employee") throw new ZudeApiError(401, "IDENTITY_REQUIRED", "Unlock with your employee PIN to use the time clock.");
  if (options.signal?.aborted) throw new ZudeApiError(0, "CANCELLED", "Request cancelled.");
  const url = apiUrl(path);
  let response: Response;
  let payload: { success?: unknown; code?: unknown } | null;
  try {
    response = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.requestKey ? { "Idempotency-Key": options.requestKey } : {}),
        Authorization: `ZudeDevice ${identity.credential}`,
        "x-zude-employee-session": identity.session,
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      signal: options.signal, cache: "no-store", redirect: "error",
    });
    try { payload = await response.json(); } catch { throw new ZudeApiError(response.status, "INVALID_RESPONSE", "Invalid response from ZUDE."); }
  } catch (error) {
    if (options.signal?.aborted) throw new ZudeApiError(0, "CANCELLED", "Request cancelled.");
    if (error instanceof ZudeApiError) throw error;
    throw new ZudeApiError(0, "NETWORK_ERROR", "Unable to reach ZUDE. Please try again.");
  }
  if (!response.ok || payload?.success !== true) {
    // Uncoded failures never become identity or device codes.
    const code = typeof payload?.code === "string" && /^[A-Z_]{1,64}$/.test(payload.code) ? payload.code : "REQUEST_FAILED";
    const error = new ZudeApiError(response.status, code, "The time clock request did not complete.");
    // DEVICE_INVALID / DEVICE_REVOKED run M04 device recovery;
    // IDENTITY_UNAUTHORIZED locks the employee session. Nothing else does.
    reportIdentityRejection(error, identity);
    throw error;
  }
  return payload as T;
}

function checkView<T extends TimeClockView>(businessId: string, view: T): T {
  if (view?.businessId !== businessId || !STATES.includes(view.state) || typeof view.timezone !== "string" ||
      typeof view.employee?.name !== "string" || !totals(view.today) || (view.shift !== null && !totals(view.shift))) throw invalidResponse();
  return view;
}
export async function getTimeClock(businessId: string, signal?: AbortSignal) {
  return checkView(businessId, await timeRequest<TimeClockView>(businessId, "/api/time-clock", { signal }));
}
// `requestKey` is reused when retrying the same action after an unknown
// outcome, so a timed-out request can never record the action twice.
export async function recordTimeAction(businessId: string, action: TimeAction, requestKey: string, breakType?: BreakType) {
  const body = action === "break-start" ? { breakType } : {};
  return checkView(businessId, await timeRequest<TimeClockView & { replayed: boolean }>(businessId, `/api/time-clock/${action}`, { method: "POST", body, requestKey }));
}
export async function getMyTime(businessId: string, signal?: AbortSignal) {
  const view = checkView(businessId, await timeRequest<MyTimeView>(businessId, "/api/my-time", { signal }));
  if (!totals(view.week) || !Array.isArray(view.days) || !view.days.every((day) => totals(day) && Array.isArray(day.shifts)) || !Array.isArray(view.issues)) throw invalidResponse();
  return view;
}
export async function reportTimeIssue(businessId: string, requestKey: string, report: { note: string; workDate: string | null }) {
  const result = await timeRequest<{ success: true; issue: TimeIssue }>(businessId, "/api/my-time/issues", { method: "POST", body: { note: report.note.trim(), workDate: report.workDate }, requestKey });
  if (typeof result.issue?.id !== "string") throw invalidResponse();
  return result.issue;
}
