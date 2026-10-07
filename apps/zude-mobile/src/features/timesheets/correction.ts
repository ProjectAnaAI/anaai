import { ZudeApiError } from "../../lib/api";
import type { ClockState, CorrectionOperation, LedgerEvent, Timesheet } from "../../lib/timesheets-api";
import { formatDuration } from "../time/state";

// Management time corrections, client side. Everything here only PREPARES a
// proposal: the server previews it authoritatively and validates the whole
// resulting ledger on commit. No totals are ever calculated here.

export type TimeField = { date: string; time: string; choice?: string };
export type Draft =
  | { kind: "add-clock-out"; shiftId: string; at: TimeField }
  | { kind: "add-break-end"; shiftId: string; at: TimeField }
  | { kind: "add-break"; shiftId: string; breakType: "PAID" | "MEAL"; start: TimeField; end: TimeField }
  | { kind: "add-shift"; clockIn: TimeField; clockOut: TimeField }
  | { kind: "correct-time"; eventId: string; at: TimeField }
  | { kind: "change-break-type"; eventId: string; to: "PAID" | "MEAL" }
  | { kind: "remove"; eventIds: string[] };

// Who may see the correction controls. Presentation only: it mirrors the
// server hierarchy (owners: any target; managers: regular employees), and the
// server re-checks every preview and commit.
export function mayCorrect(managementRole: string, targetRole: string) {
  return managementRole === "owner" || (managementRole === "manager" && targetRole === "employee");
}

// ---- Business-timezone time entry ----------------------------------------------------------
// The manager types a wall-clock time in the BUSINESS timezone (never the
// iPad's). It is converted to an exact instant here only to send it; the
// server's preview shows how it was understood, and DST gaps/overlaps are
// surfaced instead of guessed.
export function parseClock(text: string) {
  const m = text.trim().toLowerCase().replace(/\s+/g, " ").match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?$/);
  if (!m) return null;
  let hours = Number(m[1]); const minutes = Number(m[2] ?? "0");
  if (minutes > 59) return null;
  if (m[3]) {
    if (hours < 1 || hours > 12) return null;
    hours = (hours % 12) + (m[3].startsWith("p") ? 12 : 0);
  } else if (hours > 23 || m[2] === undefined) return null;
  return hours * 60 + minutes;
}
const formatters = new Map<string, Intl.DateTimeFormat>();
function wall(instant: number, timezone: string) {
  let f = formatters.get(timezone);
  if (!f) { f = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); formatters.set(timezone, f); }
  const p = Object.fromEntries(f.formatToParts(new Date(instant)).map(x => [x.type, x.value]));
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute));
}
// Every instant whose business-local wall time is date + minutes: none in a
// spring-forward gap, two in a fall-back overlap.
export function localInstants(date: string, minutes: number, timezone: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
  const [y, mo, d] = date.split("-").map(Number);
  const target = Date.UTC(y, mo - 1, d, 0, minutes);
  if (!Number.isFinite(target) || new Date(target).toISOString().slice(0, 10) !== date) return [];
  const found = new Set<number>();
  for (const probe of [target - 36 * 3600_000, target, target + 36 * 3600_000]) {
    const candidate = target - (wall(probe, timezone) - probe);
    if (wall(candidate, timezone) === target) found.add(candidate);
  }
  return [...found].sort((a, b) => a - b);
}
export function zoneName(instant: number, timezone: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "short" }).formatToParts(new Date(instant)).find(p => p.type === "timeZoneName")?.value ?? timezone;
}
export type ResolvedTime = { ok: true; iso: string } | { ok: false; problem: "missing" | "invalid" | "nonexistent" } | { ok: false; problem: "ambiguous"; options: { iso: string; label: string }[] };
export function resolveTime(field: TimeField, timezone: string): ResolvedTime {
  if (!field.date || !field.time.trim()) return { ok: false, problem: "missing" };
  const minutes = parseClock(field.time);
  if (minutes === null) return { ok: false, problem: "invalid" };
  const found = localInstants(field.date, minutes, timezone);
  if (!found.length) return /^\d{4}-\d{2}-\d{2}$/.test(field.date) && Number.isFinite(Date.parse(field.date)) ? { ok: false, problem: "nonexistent" } : { ok: false, problem: "invalid" };
  if (found.length === 1) return { ok: true, iso: new Date(found[0]).toISOString() };
  const options = found.map(i => ({ iso: new Date(i).toISOString(), label: `${field.time.trim()} ${zoneName(i, timezone)}` }));
  const chosen = options.find(o => o.iso === field.choice);
  return chosen ? { ok: true, iso: chosen.iso } : { ok: false, problem: "ambiguous", options };
}
export function timeProblem(result: ResolvedTime, timezone: string) {
  if (result.ok) return "";
  if (result.problem === "missing") return "Enter a date and time.";
  if (result.problem === "invalid") return "Enter a time like 5:30 PM or 17:30.";
  if (result.problem === "nonexistent") return `That time doesn’t exist in ${timezone} because the clocks moved forward. Enter a time after the change.`;
  return `That time happens twice in ${timezone} because the clocks moved back. Choose which one.`;
}

// ---- Building operations from the selected Timesheet context ------------------------------
export const shiftEvents = (sheet: Timesheet, shiftId: string) => sheet.events.filter(e => e.shiftId === shiftId);
// The break end paired with a BREAK_START (next BREAK_END in the same shift).
export function breakPair(sheet: Timesheet, event: LedgerEvent) {
  const events = shiftEvents(sheet, event.shiftId), i = events.findIndex(e => e.id === event.id);
  if (event.type === "BREAK_START") return { start: event, end: events.slice(i + 1).find(e => e.type === "BREAK_END") ?? null };
  if (event.type === "BREAK_END") return { start: [...events.slice(0, i)].reverse().find(e => e.type === "BREAK_START") ?? null, end: event };
  return null;
}
export type Built = { ok: true; operations: CorrectionOperation[] } | { ok: false; message: string };
const fail = (message: string): Built => ({ ok: false, message });
export function buildOperations(draft: Draft, sheet: Timesheet): Built {
  const tz = sheet.timezone, time = (field: TimeField) => resolveTime(field, tz);
  const need = (...fields: TimeField[]) => { for (const f of fields) { const r = time(f); if (!r.ok) return timeProblem(r, tz); } return ""; };
  const iso = (field: TimeField) => (time(field) as { ok: true; iso: string }).iso;
  const byId = (id: string) => sheet.events.find(e => e.id === id);
  switch (draft.kind) {
    case "add-clock-out": case "add-break-end": {
      const problem = need(draft.at); if (problem) return fail(problem);
      const last = shiftEvents(sheet, draft.shiftId).at(-1);
      if (!last || last.type === "CLOCK_OUT") return fail("This shift already has a clock-out.");
      if (draft.kind === "add-clock-out") {
        if (last.type === "BREAK_START") return fail("This shift ends on an open break. Add the missing break end first.");
        return { ok: true, operations: [{ op: "INSERT", type: "CLOCK_OUT", occurredAt: iso(draft.at), after: last.id }] };
      }
      if (last.type !== "BREAK_START" || !last.breakType) return fail("This shift has no open break.");
      return { ok: true, operations: [{ op: "INSERT", type: "BREAK_END", breakType: last.breakType, occurredAt: iso(draft.at), after: last.id }] };
    }
    case "add-break": {
      const problem = need(draft.start, draft.end); if (problem) return fail(problem);
      const start = Date.parse(iso(draft.start));
      // Placed after the last event at or before the break start, within the shift.
      const anchor = shiftEvents(sheet, draft.shiftId).filter(e => Date.parse(e.occurredAt) <= start).at(-1);
      if (!anchor) return fail("A break must start after the shift’s clock-in.");
      return { ok: true, operations: [
        { op: "INSERT", type: "BREAK_START", breakType: draft.breakType, occurredAt: iso(draft.start), after: anchor.id, ref: "break" },
        { op: "INSERT", type: "BREAK_END", breakType: draft.breakType, occurredAt: iso(draft.end), afterRef: "break" }] };
    }
    case "add-shift": {
      const problem = need(draft.clockIn, draft.clockOut); if (problem) return fail(problem);
      const start = Date.parse(iso(draft.clockIn));
      const before = sheet.events.filter(e => Date.parse(e.occurredAt) <= start).at(-1);
      const after = sheet.events.find(e => Date.parse(e.occurredAt) > start);
      const place = before ? { after: before.id } : after ? { before: after.id } : null;
      if (!place) return fail("This week has no recorded time to place a new shift next to. Adding a shift to an empty week isn’t available yet.");
      return { ok: true, operations: [
        { op: "INSERT", type: "CLOCK_IN", occurredAt: iso(draft.clockIn), ...place, ref: "shift" },
        { op: "INSERT", type: "CLOCK_OUT", occurredAt: iso(draft.clockOut), afterRef: "shift" }] };
    }
    case "correct-time": {
      const problem = need(draft.at); if (problem) return fail(problem);
      if (!byId(draft.eventId)) return fail("Choose an event from this timesheet.");
      return { ok: true, operations: [{ op: "REPLACE", target: draft.eventId, occurredAt: iso(draft.at) }] };
    }
    case "change-break-type": {
      const event = byId(draft.eventId), pair = event && breakPair(sheet, event);
      if (!pair?.start) return fail("Choose a break from this timesheet.");
      return { ok: true, operations: [pair.start, pair.end].filter((e): e is LedgerEvent => !!e)
        .map(e => ({ op: "REPLACE" as const, target: e.id, occurredAt: e.occurredAt, breakType: draft.to })) };
    }
    case "remove":
      if (!draft.eventIds.length || draft.eventIds.some(id => !byId(id))) return fail("Choose an entry from this timesheet.");
      return { ok: true, operations: draft.eventIds.map(id => ({ op: "VOID" as const, target: id })) };
  }
}

// ---- Plain-language presentation -----------------------------------------------------------
export const eventLabel = (event: Pick<LedgerEvent, "type" | "breakType">) => event.type === "CLOCK_IN" ? "Clock in" : event.type === "CLOCK_OUT" ? "Clock out"
  : `${event.breakType === "PAID" ? "Paid" : "Meal"} break ${event.type === "BREAK_START" ? "started" : "ended"}`;
export function when(stamp: string, timezone: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(stamp));
}
export function describeOperations(operations: CorrectionOperation[], sheet: Timesheet) {
  const tz = sheet.timezone, byId = (id: string) => sheet.events.find(e => e.id === id);
  return operations.map(op => {
    if (op.op === "INSERT") return `Add ${eventLabel({ type: op.type, breakType: op.breakType ?? null }).toLowerCase()} · ${when(op.occurredAt, tz)}`;
    const event = byId(op.target), label = event ? eventLabel(event) : "Entry";
    if (op.op === "VOID") return `Remove ${label.toLowerCase()} (${event ? when(event.occurredAt, tz) : "unknown time"}) from calculated time`;
    if (event && op.breakType && op.breakType !== event.breakType) return `Change ${label.toLowerCase()} to a ${op.breakType === "PAID" ? "paid" : "meal"} break`;
    return `Change ${label.toLowerCase()} from ${event ? when(event.occurredAt, tz) : "its recorded time"} to ${when(op.occurredAt, tz)}`;
  });
}
export const stateLabel = (state: ClockState) => state === "OFF_CLOCK" ? "Off the clock" : state === "WORKING" ? "Working" : state === "ON_PAID_BREAK" ? "On a paid break" : "On a meal break";
// What the preview changes, from two SERVER responses (current and proposed).
export function previewChanges(before: Timesheet, after: Timesheet) {
  const totals = (["workedMs", "paidBreakMs", "mealBreakMs"] as const).map(key => ({
    label: key === "workedMs" ? "Worked" : key === "paidBreakMs" ? "Paid breaks" : "Meal breaks",
    before: formatDuration(before.totals[key]), after: formatDuration(after.totals[key]), changed: before.totals[key] !== after.totals[key],
  }));
  // Every day whose time moved — including the next or previous day of an
  // overnight shift.
  const days = after.days.flatMap((d, i) => {
    const b = before.days[i];
    if (!b || (b.workedMs === d.workedMs && b.paidBreakMs === d.paidBreakMs && b.mealBreakMs === d.mealBreakMs && b.shifts.length === d.shifts.length)) return [];
    return [{ date: d.date, before: formatDuration(b.workedMs), after: formatDuration(d.workedMs), shiftsBefore: b.shifts.length, shiftsAfter: d.shifts.length }];
  });
  return { totals, days, openBefore: before.totals.hasOpenShift, openAfter: after.totals.hasOpenShift };
}

// ---- Errors -------------------------------------------------------------------------------
const reasonMessages: Record<string, string> = {
  INVALID_TRANSITION: "This change would leave an impossible sequence — for example a clock-out without a clock-in, a second clock-in, or a break that never ends. Check which entries need changing.",
  OUT_OF_ORDER: "Times must stay in order. The new time falls before an earlier entry or after a later one. Choose a time between the surrounding entries.",
  FUTURE_EVENT: "Corrections can’t use a time in the future. Choose a time that has already passed.",
  TARGET_NOT_FOUND: "That entry is no longer in this timesheet. Refresh and choose it again.",
  TARGET_VOIDED: "That entry was already removed by an earlier correction. Refresh the timesheet.",
  ANCHOR_NOT_FOUND: "The surrounding time record changed. Refresh the timesheet and try again.",
  INVALID_OPERATION: "That change isn’t available for this entry.",
};
export function correctionMessage(error: unknown) {
  if (error instanceof ZudeApiError) {
    if (error.code === "TIME_CORRECTION_INVALID") return reasonMessages[error.reason ?? ""] ?? "This correction would leave an invalid time record.";
    if (error.code === "TIME_CORRECTION_STALE") return "Time history changed since this correction was reviewed. The timesheet was refreshed — preview the correction again.";
    if (error.code === "TIME_REQUEST_CONFLICT") return "This correction could not be matched to the one you reviewed. Refresh and preview again.";
    if (error.status === 401) return "Your session ended. Unlock or sign in again to continue.";
    if (error.status === 403 || error.code === "EMPLOYEE_NOT_FOUND") return "Your current role can’t correct this employee’s time.";
    if (error.code === "INVALID_REQUEST" || error.code === "INVALID_WEEK" || error.code === "FUTURE_WEEK") return "Check the dates and times and try again.";
    if (error.code === "NETWORK_ERROR") return "Unable to reach ZUDE. Check your connection and try again.";
  }
  return "ZUDE couldn’t check this correction. Please try again.";
}
// A commit whose outcome is unknown: the server may have saved it.
export function commitUncertain(error: unknown) {
  return !(error instanceof ZudeApiError) || error.status === 0 || error.status >= 500;
}
export function authorityLost(error: unknown) {
  return error instanceof ZudeApiError && (error.status === 401 || error.status === 403 || error.code === "EMPLOYEE_NOT_FOUND");
}
