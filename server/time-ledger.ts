import type { SupabaseClient } from "@supabase/supabase-js";
import { readAllPages } from "./member";
import { addDays, businessWeek, localDayStart, mondayIndex, validTimezone, type TimeEvent } from "./time-calculation";

export class TimeFailure extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
// Versions are strings so PostgreSQL bigint watermarks never lose precision.
type LedgerVersion = { employeeId: string; originalWatermark: string; correctionRevision: string };
export const LEDGER_READ_ATTEMPTS = 2;
async function readVersion(db: SupabaseClient, businessId: string, employeeId: string | null) {
  const result = await db.rpc("m06_ledger_read_versions", { p_business_id: businessId, p_employee_id: employeeId });
  if (result.error || !Array.isArray(result.data)) throw new Error("Ledger version unavailable");
  const rows = result.data as LedgerVersion[];
  if (rows.length > (employeeId === null ? MAX_WORKING_ROSTER : 1)) {
    if (employeeId === null) throw tooLarge();
    throw new Error("Invalid ledger version scope");
  }
  const ids = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row.employeeId !== "string" || ids.has(row.employeeId) ||
        (employeeId !== null && row.employeeId !== employeeId) ||
        typeof row.originalWatermark !== "string" || !/^(0|[1-9]\d*)$/.test(row.originalWatermark) ||
        typeof row.correctionRevision !== "string" || !/^(0|[1-9]\d*)$/.test(row.correctionRevision)) throw new Error("Invalid ledger version");
    ids.add(row.employeeId);
  }
  return JSON.stringify(rows.map(row => [row.employeeId, row.originalWatermark, row.correctionRevision]).sort((a,b) => a[0].localeCompare(b[0])));
}
// Every query contributing to an interpretation must be inside `read`.
// Even an intermediate query failure is checked against V2: a concurrent
// rebuild can invalidate carry-in/count/boundary checks and merits a fresh
// attempt. Stable failures retain their existing error contract.
export async function consistentLedgerRead<T>(db: SupabaseClient, businessId: string, employeeId: string | null, read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < LEDGER_READ_ATTEMPTS; attempt++) {
    const before = await readVersion(db, businessId, employeeId);
    let value: T | undefined;
    let failure: unknown;
    let failed = false;
    try { value = await read(); } catch (error) { failed = true; failure = error; }
    const after = await readVersion(db, businessId, employeeId);
    if (before !== after) continue;
    if (failed) throw failure;
    return value as T;
  }
  throw new TimeFailure(503, "TIME_LEDGER_CHANGED", "Time records changed while loading. Please refresh and try again.");
}

export const eventFields = "id,seq,event_type,break_type,occurred_at";
// Every authoritative read uses the EFFECTIVE ledger: M05 originals plus
// immutable M06 corrections, folded by SQL (m06_time_fold) into a projection
// with the same columns. `id` is the logical event id and `seq` the effective
// order. Without corrections it is identical to employee_time_events (same ids
// and seq). m05_record_time_event validates new clock actions against the same
// projection, so reads and writes share one interpretation.
export const EFFECTIVE_EVENTS = "employee_time_effective_events";
// Timesheet pages also carry provenance (management views only, never
// employee-facing).
export const timesheetEventFields = "id,seq,event_type,break_type,occurred_at,origin,replaced,correction_revision";
export async function businessTimezone(db: SupabaseClient, businessId: string) {
  const { data, error } = await db.from("businesses").select("id,timezone").eq("id", businessId).maybeSingle();
  if (error) throw new Error("Business lookup failed");
  const timezone = (data as { timezone?: unknown } | null)?.timezone;
  if (!validTimezone(timezone)) throw new TimeFailure(503, "TIME_CONFIGURATION_UNAVAILABLE", "The business timezone is not configured.");
  return timezone;
}
// The employee's ledger from `from` onward, starting earlier at the clock-in
// of any shift still open at `from`. Returns the latest event before `from`
// too, so state is known when nothing happened since.
export function employeeLedger(db: SupabaseClient, businessId: string, employeeId: string, from: number) {
  return consistentLedgerRead(db, businessId, employeeId, () => employeeLedgerAttempt(db, businessId, employeeId, from));
}
async function employeeLedgerAttempt(db: SupabaseClient, businessId: string, employeeId: string, from: number) {
  const fromIso = new Date(from).toISOString();
  const scoped = () => db.from(EFFECTIVE_EVENTS).select(eventFields).eq("business_id", businessId).eq("employee_id", employeeId);
  const prior = await scoped().lt("occurred_at", fromIso).order("seq", { ascending: false }).limit(1).maybeSingle();
  if (prior.error) throw new Error("Time read failed");
  const before = prior.data as TimeEvent | null;
  let carry: number | null = null;
  if (before && before.event_type !== "CLOCK_OUT") {
    const opened = await scoped().eq("event_type", "CLOCK_IN").lt("occurred_at", fromIso).order("seq", { ascending: false }).limit(1).maybeSingle();
    if (opened.error || !opened.data) throw new Error("Time read failed");
    carry = (opened.data as TimeEvent).seq;
  }
  const events = await readAllPages<TimeEvent>((start, end) => (carry === null ? scoped().gte("occurred_at", fromIso) : scoped().gte("seq", carry)).order("seq", { ascending: true }).range(start, end));
  const latest = events[events.length - 1] ?? before;
  return { events, latest, snapshot: Math.max(Date.now(), latest ? Date.parse(latest.occurred_at) : 0) };
}

export const MAX_WORKING_ROSTER = 200;
const MAX_OPEN_EVENTS = 10000;
const BATCH_SIZE = 20;
type EmployeeHead = {
  id: string; display_name: string; role: 'employee' | 'manager' | 'owner'; is_active: boolean;
  latest: TimeEvent[]; opened: TimeEvent[];
};
const tooLarge = () => new TimeFailure(503, "WORKING_LIMIT_EXCEEDED", "The working roster is too large to load completely. Contact your ZUDE administrator.");

export function workingLedger(db: SupabaseClient, businessId: string) {
  return consistentLedgerRead(db, businessId, null, () => workingLedgerAttempt(db, businessId));
}
async function workingLedgerAttempt(db: SupabaseClient, businessId: string) {
  const timezone = await businessTimezone(db, businessId);
  // A single PostgREST statement captures employee metadata plus both heads
  // using the existing composite employee FK. Do NOT filter inactive employees.
  const relation = `${EFFECTIVE_EVENTS}!${EFFECTIVE_EVENTS}_business_employee_fkey`;
  const { data, error, count } = await db.from('employees')
    .select(`id,display_name,role,is_active,latest:${relation}(${eventFields}),opened:${relation}(${eventFields})`, { count: 'exact' })
    .eq('business_id', businessId).order('id').limit(MAX_WORKING_ROSTER + 1)
    .order('seq', { referencedTable: 'latest', ascending: false }).limit(1, { referencedTable: 'latest' })
    .eq('opened.event_type', 'CLOCK_IN')
    .order('seq', { referencedTable: 'opened', ascending: false }).limit(1, { referencedTable: 'opened' });
  if (error || !data || count === null) throw new Error('Working roster read failed');
  if (count > MAX_WORKING_ROSTER) throw tooLarge();
  if (data.length !== count) throw new Error('Incomplete working roster');
  const heads = data as unknown as EmployeeHead[];
  // Same M05 clock rule: server time, never earlier than an observed DB event.
  const snapshot = Math.max(Date.now(), ...heads.map(h => h.latest[0] ? Date.parse(h.latest[0].occurred_at) : 0));
  const open = heads.filter(h => h.latest[0] && h.latest[0].event_type !== 'CLOCK_OUT');
  const events = new Map<string, TimeEvent[]>();
  let total = 0;
  for (let offset = 0; offset < open.length; offset += BATCH_SIZE) {
    const batch = open.slice(offset, offset + BATCH_SIZE);
    const filters = batch.map(h => {
      const start = h.opened[0], end = h.latest[0];
      if (!start || !Number.isSafeInteger(start.seq) || !Number.isSafeInteger(end.seq) || start.seq > end.seq || !/^[0-9a-f-]{36}$/i.test(h.id)) throw new Error('Invalid working ledger head');
      events.set(h.id, []);
      return `and(employee_id.eq.${h.id},seq.gte.${start.seq},seq.lte.${end.seq})`;
    }).join(',');
    // Fixed per-employee upper seq bounds exclude concurrent appends. M05
    // serializes writes per employee, so no older event can commit later below
    // an observed head. Corrections can still rebuild these rows; the outer
    // version protocol, not these bounds, establishes read consistency.
    let loaded = 0;
    for (;;) {
      const result = await db.from(EFFECTIVE_EVENTS).select(`employee_id,${eventFields}`, { count: 'exact' })
        .eq('business_id', businessId).or(filters).order('seq').range(loaded, loaded + 499);
      if (result.error || !result.data || result.count === null) throw new Error('Working events read failed');
      if (total + result.count > MAX_OPEN_EVENTS) throw tooLarge();
      if (!result.data.length && loaded < result.count) throw new Error('Incomplete working events');
      for (const row of result.data as (TimeEvent & { employee_id: string })[]) {
        const group = events.get(row.employee_id);
        if (!group) throw new Error('Unexpected working employee');
        group.push(row);
      }
      loaded += result.data.length;
      if (loaded === result.count) { total += loaded; break; }
      if (loaded > result.count) throw new Error('Invalid working event count');
    }
    for (const h of batch) {
      const rows = events.get(h.id)!;
      if (rows[0]?.id !== h.opened[0].id || rows[rows.length - 1]?.id !== h.latest[0].id) throw new Error('Incomplete open shift');
    }
  }
  return { timezone, snapshot, employees: heads.map(h => ({
    employee: { id: h.id, name: h.display_name, role: h.role, isActive: h.is_active },
    latest: h.latest[0] ?? null, events: events.get(h.id) ?? [],
  })) };
}

export const MAX_TIMESHEET_EVENTS = 10000;
export const timesheetLimit = () => new TimeFailure(503, "TIMESHEET_LIMIT_EXCEEDED", "The complete timesheet is too large to load. Contact your ZUDE administrator.");

// The canonical business week for a request (Timesheet reads and correction
// previews share it): a real Monday in the business timezone, never future.
export function resolveWeek(timezone: string, snapshot: number, requestedWeek: string | null) {
  const current = businessWeek(snapshot, timezone);
  const startDate = requestedWeek ?? current.startDate;
  if (!/^[1-9]\d{3}-\d{2}-\d{2}$/.test(startDate) ||
      !Number.isFinite(Date.parse(`${startDate}T00:00:00Z`)) ||
      new Date(`${startDate}T00:00:00Z`).toISOString().slice(0, 10) !== startDate || mondayIndex(startDate) !== 0) {
    throw new TimeFailure(400, 'INVALID_WEEK', 'Choose a valid Monday date for the business week.');
  }
  if (startDate > current.startDate) throw new TimeFailure(400, 'FUTURE_WEEK', 'Future timesheets are not available.');
  const week = businessWeek(localDayStart(startDate, timezone), timezone);
  // Reject nonexistent local dates instead of normalizing them silently.
  if (week.startDate !== startDate) throw new TimeFailure(400, 'INVALID_WEEK', 'This business week is unavailable.');
  const navigation = { currentWeekStart: current.startDate, previousWeekStart: addDays(startDate, -7),
    nextWeekStart: startDate < current.startDate ? addDays(startDate, 7) : null };
  return { week, navigation };
}
// One employee/week. Seq bounds limit the window; the outer version protocol
// protects every boundary query and page against projection rebuilds.
// Load whole touching shifts: carry-in at the beginning, real closure at the
// end. Otherwise a historical shift closing next Monday would look open.
// (m06_effective_window implements the same window for correction previews.)
export type HistoricalEvent = TimeEvent & { origin?: "original" | "inserted"; replaced?: boolean; correction_revision?: number | null };
export function historicalLedger(db: SupabaseClient, businessId: string, employeeId: string, requestedWeek: string | null) {
  return consistentLedgerRead(db, businessId, employeeId, () => historicalLedgerAttempt(db, businessId, employeeId, requestedWeek));
}
async function historicalLedgerAttempt(db: SupabaseClient, businessId: string, employeeId: string, requestedWeek: string | null) {
  const timezone = await businessTimezone(db, businessId);
  const scoped = () => db.from(EFFECTIVE_EVENTS).select(eventFields).eq('business_id', businessId).eq('employee_id', employeeId);
  const paged = () => db.from(EFFECTIVE_EVENTS).select(timesheetEventFields, { count: 'exact' }).eq('business_id', businessId).eq('employee_id', employeeId);
  const head = await scoped().order('seq', { ascending: false }).limit(1).maybeSingle();
  if (head.error) throw new Error('Time head read failed');
  const latest = head.data as TimeEvent | null;
  const snapshot = Math.max(Date.now(), latest ? Date.parse(latest.occurred_at) : 0);
  const { week, navigation } = resolveWeek(timezone, snapshot, requestedWeek);
  if (!latest) return { timezone, snapshot, week, navigation, events: [] as HistoricalEvent[] };
  const bounded = () => scoped().lte('seq', latest.seq);
  const before = await bounded().lt('occurred_at', new Date(week.startsAt).toISOString()).order('seq', { ascending: false }).limit(1).maybeSingle();
  if (before.error) throw new Error('Carry-in read failed');
  let first: number | null = null;
  if (before.data && before.data.event_type !== 'CLOCK_OUT') {
    const opened = await bounded().eq('event_type', 'CLOCK_IN').lte('seq', before.data.seq).order('seq', { ascending: false }).limit(1).maybeSingle();
    if (opened.error || !opened.data) throw new Error('Missing carry-in clock-in');
    first = opened.data.seq;
  }
  const end = await bounded().lt('occurred_at', new Date(week.endsAt).toISOString()).order('seq', { ascending: false }).limit(1).maybeSingle();
  if (end.error) throw new Error('Week boundary read failed');
  if (!end.data || (first === null && Date.parse(end.data.occurred_at) < week.startsAt)) {
    return { timezone, snapshot, week, navigation, events: [] as HistoricalEvent[] };
  }
  let last: TimeEvent = end.data;
  if (last.event_type !== 'CLOCK_OUT') {
    const closed = await bounded().eq('event_type', 'CLOCK_OUT').gt('seq', last.seq).order('seq').limit(1).maybeSingle();
    if (closed.error) throw new Error('Carry-out read failed');
    last = (closed.data as TimeEvent | null) ?? latest;
  }
  const events: HistoricalEvent[] = [];
  let expected: number | null = null;
  for (;;) {
    let query = paged().lte('seq', last.seq);
    query = first === null ? query.gte('occurred_at', new Date(week.startsAt).toISOString()) : query.gte('seq', first);
    const page = await query.order('seq').range(events.length, events.length + 499);
    if (page.error || !page.data || page.count === null) throw new Error('Timesheet read failed');
    if (page.count > MAX_TIMESHEET_EVENTS) throw timesheetLimit();
    if (expected !== null && expected !== page.count) throw new Error('Timesheet changed while reading');
    expected = page.count;
    if (!page.data.length && events.length < expected) throw new Error('Incomplete timesheet');
    events.push(...page.data as HistoricalEvent[]);
    if (events.length === expected) break;
    if (events.length > expected) throw new Error('Invalid timesheet count');
  }
  if (!events.length || events[0].event_type !== 'CLOCK_IN' ||
      (first !== null && events[0].seq !== first) || events[events.length - 1].id !== last.id) throw new Error('Incomplete timesheet range');
  return { timezone, snapshot, week, navigation, events };
}
