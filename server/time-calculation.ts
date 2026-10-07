// M05 time calculation. Pure functions over the authoritative event ledger
// (supabase/migrations/202610010001_m05_time_clock.sql).
//
// - Worked (paid) time = elapsed clock time minus MEAL break time.
//   PAID break time stays inside worked time; it is reported separately and
//   never subtracted again.
// - Open shifts and open breaks run until the server's `now`.
// - Workweek: Monday 00:00 to the next Monday 00:00 in the business timezone.
//   Day and week boundaries are local midnights converted to instants, so DST
//   days are 23 or 25 hours long, never a fixed 24.
// - Time is attributed to the local day (and week) in which it was worked: a
//   shift crossing midnight contributes to both days.

export type TimeEventType = "CLOCK_IN" | "BREAK_START" | "BREAK_END" | "CLOCK_OUT";
export type BreakType = "PAID" | "MEAL";
export type ClockState = "OFF_CLOCK" | "WORKING" | "ON_PAID_BREAK" | "ON_MEAL_BREAK";
export type TimeEvent = { id: string; seq: number; event_type: TimeEventType; break_type: BreakType | null; occurred_at: string };
export type Break = { type: BreakType; start: number; end: number | null };
export type Shift = { id: string; start: number; end: number | null; breaks: Break[] };
export type Totals = { workedMs: number; paidBreakMs: number; mealBreakMs: number };

export const INTENDED_BREAK_MINUTES: Record<BreakType, number> = { PAID: 10, MEAL: 30 };

export function clockState(latest: Pick<TimeEvent, "event_type" | "break_type"> | null | undefined): ClockState {
  if (!latest || latest.event_type === "CLOCK_OUT") return "OFF_CLOCK";
  if (latest.event_type === "BREAK_START") return latest.break_type === "PAID" ? "ON_PAID_BREAK" : "ON_MEAL_BREAK";
  return "WORKING";
}

// Events must be in ledger (seq) order. Events before the first CLOCK_IN are
// ignored: the loader always starts at the clock-in of any shift still open
// at the window start.
export function buildShifts(events: readonly TimeEvent[]): Shift[] {
  const shifts: Shift[] = [];
  let open: Shift | null = null;
  for (const event of events) {
    const at = Date.parse(event.occurred_at);
    if (!Number.isFinite(at)) throw new Error("Invalid time event.");
    if (event.event_type === "CLOCK_IN") {
      open = { id: event.id, start: at, end: null, breaks: [] };
      shifts.push(open);
    } else if (!open) {
      continue;
    } else if (event.event_type === "BREAK_START" && event.break_type) {
      open.breaks.push({ type: event.break_type, start: at, end: null });
    } else if (event.event_type === "BREAK_END") {
      const current = open.breaks[open.breaks.length - 1];
      if (current && current.end === null) current.end = at;
    } else if (event.event_type === "CLOCK_OUT") {
      open.end = at;
      open = null;
    }
  }
  return shifts;
}

function overlap(start: number, end: number, from: number, to: number) {
  return Math.max(0, Math.min(end, to) - Math.max(start, from));
}
// Totals inside [from, to), with open intervals ending at `now`.
export function windowTotals(shifts: readonly Shift[], from: number, to: number, now: number): Totals {
  const totals: Totals = { workedMs: 0, paidBreakMs: 0, mealBreakMs: 0 };
  const limit = Math.min(to, now);
  for (const shift of shifts) {
    let worked = overlap(shift.start, shift.end ?? now, from, limit);
    for (const item of shift.breaks) {
      const inside = overlap(item.start, item.end ?? shift.end ?? now, from, limit);
      if (item.type === "MEAL") { totals.mealBreakMs += inside; worked -= inside; } else totals.paidBreakMs += inside;
    }
    totals.workedMs += Math.max(0, worked);
  }
  return totals;
}

// ---- Business-local calendar -----------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timezone: string) {
  let value = formatters.get(timezone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
    formatters.set(timezone, value);
  }
  return value;
}
export function validTimezone(timezone: unknown): timezone is string {
  if (typeof timezone !== "string" || !timezone) return false;
  try { formatter(timezone); return true; } catch { return false; }
}
// The business-local calendar date (YYYY-MM-DD) of an instant.
export function localDate(instant: number, timezone: string) {
  const parts = formatter(timezone).formatToParts(new Date(instant));
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export function addDays(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}
// 0 = Monday ... 6 = Sunday.
export function mondayIndex(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
}
// The first instant whose business-local date is `date`. A binary search
// rather than offset arithmetic, so DST transitions (including zones where
// midnight itself is skipped) are exact.
export function localDayStart(date: string, timezone: string) {
  const [year, month, day] = date.split("-").map(Number);
  const utcMidnight = Date.UTC(year, month - 1, day);
  let low = utcMidnight - 18 * 3600_000, high = utcMidnight + 18 * 3600_000;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (localDate(middle, timezone) >= date) high = middle; else low = middle;
  }
  return high;
}
export type LocalDay = { date: string; startsAt: number; endsAt: number };
export type BusinessWeek = { today: string; startDate: string; endDate: string; startsAt: number; endsAt: number; days: LocalDay[] };
export function businessWeek(now: number, timezone: string): BusinessWeek {
  const today = localDate(now, timezone);
  const startDate = addDays(today, -mondayIndex(today));
  const starts = Array.from({ length: 8 }, (_, index) => localDayStart(addDays(startDate, index), timezone));
  const days = starts.slice(0, 7).map((startsAt, index) => ({ date: addDays(startDate, index), startsAt, endsAt: starts[index + 1] }));
  return { today, startDate, endDate: addDays(startDate, 6), startsAt: starts[0], endsAt: starts[7], days };
}

// ---- Presentation payloads ---------------------------------------------------------------

const iso = (value: number | null) => value === null ? null : new Date(value).toISOString();
export function breakView(item: Break, shiftEnd: number | null, now: number) {
  const end = item.end ?? shiftEnd;
  return {
    type: item.type, intendedMinutes: INTENDED_BREAK_MINUTES[item.type],
    startedAt: iso(item.start), endedAt: iso(end), open: end === null,
    durationMs: Math.max(0, (end ?? now) - item.start),
  };
}
export function dayView(shifts: readonly Shift[], day: LocalDay, now: number) {
  const touching = shifts.filter((shift) => shift.start < day.endsAt && (shift.start >= day.startsAt || (shift.end ?? now) > day.startsAt));
  return {
    date: day.date, startsAt: iso(day.startsAt), endsAt: iso(day.endsAt),
    ...windowTotals(touching, day.startsAt, day.endsAt, now),
    shifts: touching.map((shift) => ({
      id: shift.id, clockInAt: iso(shift.start), clockOutAt: iso(shift.end), open: shift.end === null,
      continuesFromPreviousDay: shift.start < day.startsAt,
      continuesNextDay: (shift.end ?? now) > day.endsAt,
      ...windowTotals([shift], day.startsAt, day.endsAt, now),
      breaks: shift.breaks
        .filter((item) => item.start < day.endsAt && (item.end ?? shift.end ?? now) >= day.startsAt)
        .map((item) => breakView(item, shift.end, now)),
    })),
  };
}
// The open shift as of `now` (Time Clock).
export function currentShiftView(shifts: readonly Shift[], state: ClockState, now: number) {
  const shift = shifts[shifts.length - 1];
  if (state === "OFF_CLOCK" || !shift || shift.end !== null) return null;
  const open = shift.breaks.find((item) => item.end === null);
  return {
    id: shift.id, clockInAt: iso(shift.start), elapsedMs: Math.max(0, now - shift.start),
    ...windowTotals([shift], shift.start, now, now),
    break: open ? breakView(open, null, now) : null,
  };
}
