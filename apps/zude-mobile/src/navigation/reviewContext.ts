// Route context selects records; existing APIs remain the authority.
export type ReviewParams = Record<string, string | string[] | undefined>;
export type TimesheetContext = { employeeId: string; week: string | null; day: string | null };
export function validId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function weekForDay(day: string) {
  const date = new Date(day); date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return date.toISOString().slice(0, 10);
}
export function issueContext(params: ReviewParams) {
  return params.issueId === undefined ? { id: null, invalid: false }
    : validId(params.issueId) ? { id: params.issueId, invalid: false } : { id: null, invalid: true };
}
export function timesheetContext(params: ReviewParams): { context: TimesheetContext | null; invalid: boolean } {
  const { employeeId, weekStart, day } = params;
  if (employeeId === undefined && weekStart === undefined && day === undefined) return { context: null, invalid: false };
  if (!validId(employeeId) || weekStart !== undefined && (!validDate(weekStart) || weekForDay(weekStart) !== weekStart) || day !== undefined && !validDate(day)) return { context: null, invalid: true };
  const week = typeof weekStart === "string" ? weekStart : typeof day === "string" ? weekForDay(day) : null;
  if (typeof day === "string" && week !== weekForDay(day)) return { context: null, invalid: true };
  return { context: { employeeId, week, day: typeof day === "string" ? day : null }, invalid: false };
}
export function timesheetDestination(employeeId: string, startedAt: string | undefined, timezone: string) {
  const parts = startedAt ? new Intl.DateTimeFormat("en", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(startedAt)) : [];
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const day = startedAt ? `${fields.year}-${fields.month}-${fields.day}` : undefined;
  return { pathname: "/timesheets" as const, params: { employeeId, ...(day ? { day, weekStart: weekForDay(day) } : {}) } };
}
