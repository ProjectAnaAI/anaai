// M05 worked-time and business-week calculation (server/time-calculation.ts).
const { test } = require('node:test');
const strict = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const assert = Object.assign((...a) => strict(...a), strict, { deepEqual: (a, b, m) => strict.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), m) });
const exports_ = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('server/time-calculation.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports: exports_, Intl, Date, Math, Number, Map, Array, String });
const c = exports_;
const H = 3600_000, M = 60_000;
let seq = 0;
const ev = (event_type, at, break_type = null) => ({ id: 'e' + ++seq, seq, event_type, break_type, occurred_at: new Date(at).toISOString() });
const T = (s) => Date.parse(s);

test('example shift: 8h elapsed, 30m meal subtracted, 10m paid break NOT subtracted again', () => {
  const shifts = c.buildShifts([ev('CLOCK_IN', T('2026-09-29T09:00:00Z')), ev('BREAK_START', T('2026-09-29T10:00:00Z'), 'PAID'), ev('BREAK_END', T('2026-09-29T10:10:00Z'), 'PAID'),
    ev('BREAK_START', T('2026-09-29T12:00:00Z'), 'MEAL'), ev('BREAK_END', T('2026-09-29T12:30:00Z'), 'MEAL'), ev('CLOCK_OUT', T('2026-09-29T17:00:00Z'))]);
  const totals = c.windowTotals(shifts, T('2026-09-29T00:00:00Z'), T('2026-09-30T00:00:00Z'), T('2026-09-30T12:00:00Z'));
  assert.deepEqual(totals, { workedMs: 7.5 * H, paidBreakMs: 10 * M, mealBreakMs: 30 * M });
});
test('open shift and open breaks run to the server now only', () => {
  const now = T('2026-09-29T12:15:00Z');
  const working = c.buildShifts([ev('CLOCK_IN', T('2026-09-29T09:00:00Z'))]);
  assert.equal(c.windowTotals(working, 0, Infinity, now).workedMs, 3.25 * H);
  const meal = c.buildShifts([ev('CLOCK_IN', T('2026-09-29T09:00:00Z')), ev('BREAK_START', T('2026-09-29T12:00:00Z'), 'MEAL')]);
  assert.deepEqual(c.windowTotals(meal, 0, Infinity, now), { workedMs: 3 * H, paidBreakMs: 0, mealBreakMs: 15 * M });
  const paid = c.buildShifts([ev('CLOCK_IN', T('2026-09-29T09:00:00Z')), ev('BREAK_START', T('2026-09-29T12:00:00Z'), 'PAID')]);
  assert.deepEqual(c.windowTotals(paid, 0, Infinity, now), { workedMs: 3.25 * H, paidBreakMs: 15 * M, mealBreakMs: 0 });
  const view = c.currentShiftView(meal, 'ON_MEAL_BREAK', now);
  assert.equal(view.elapsedMs, 3.25 * H); assert.equal(view.workedMs, 3 * H);
  assert.deepEqual([view.break.type, view.break.intendedMinutes, view.break.open, view.break.durationMs], ['MEAL', 30, true, 15 * M]);
  assert.equal(c.currentShiftView(c.buildShifts([ev('CLOCK_IN', 0), ev('CLOCK_OUT', H)]), 'OFF_CLOCK', now), null);
});
test('a break longer than intended is reported as actual, never truncated', () => {
  const s = c.buildShifts([ev('CLOCK_IN', 0), ev('BREAK_START', H, 'PAID'), ev('BREAK_END', H + 25 * M, 'PAID'), ev('CLOCK_OUT', 4 * H)]);
  assert.deepEqual(c.windowTotals(s, 0, Infinity, 5 * H), { workedMs: 4 * H, paidBreakMs: 25 * M, mealBreakMs: 0 });
  assert.equal(c.breakView(s[0].breaks[0], 4 * H, 5 * H).durationMs, 25 * M);
  assert.deepEqual(c.INTENDED_BREAK_MINUTES, { PAID: 10, MEAL: 30 });
});
test('state derives from the latest ledger event', () => {
  assert.equal(c.clockState(null), 'OFF_CLOCK');
  assert.equal(c.clockState({ event_type: 'CLOCK_IN', break_type: null }), 'WORKING');
  assert.equal(c.clockState({ event_type: 'BREAK_START', break_type: 'PAID' }), 'ON_PAID_BREAK');
  assert.equal(c.clockState({ event_type: 'BREAK_START', break_type: 'MEAL' }), 'ON_MEAL_BREAK');
  assert.equal(c.clockState({ event_type: 'BREAK_END', break_type: 'MEAL' }), 'WORKING');
  assert.equal(c.clockState({ event_type: 'CLOCK_OUT', break_type: null }), 'OFF_CLOCK');
});
test('multiple shifts in one day add up and stay separate', () => {
  const tz = 'America/New_York';
  const shifts = c.buildShifts([ev('CLOCK_IN', T('2026-09-29T13:00:00Z')), ev('CLOCK_OUT', T('2026-09-29T16:00:00Z')),
    ev('CLOCK_IN', T('2026-09-29T18:00:00Z')), ev('BREAK_START', T('2026-09-29T19:00:00Z'), 'MEAL'), ev('BREAK_END', T('2026-09-29T19:30:00Z'), 'MEAL'), ev('CLOCK_OUT', T('2026-09-29T21:00:00Z'))]);
  const week = c.businessWeek(T('2026-09-30T12:00:00Z'), tz);
  const day = c.dayView(shifts, week.days.find(d => d.date === '2026-09-29'), T('2026-09-30T12:00:00Z'));
  assert.equal(day.shifts.length, 2); assert.equal(day.workedMs, 5.5 * H); assert.equal(day.mealBreakMs, 30 * M);
  assert.deepEqual(day.shifts.map(s => s.workedMs), [3 * H, 2.5 * H]);
});
test('a shift crossing midnight is split between the two local days', () => {
  const tz = 'America/New_York';  // 22:00 → 02:00 local = 02:00Z → 06:00Z
  const shifts = c.buildShifts([ev('CLOCK_IN', T('2026-09-30T02:00:00Z')), ev('BREAK_START', T('2026-09-30T03:30:00Z'), 'MEAL'), ev('BREAK_END', T('2026-09-30T04:30:00Z'), 'MEAL'), ev('CLOCK_OUT', T('2026-09-30T06:00:00Z'))]);
  const now = T('2026-10-01T12:00:00Z'), week = c.businessWeek(now, tz);
  const tue = c.dayView(shifts, week.days.find(d => d.date === '2026-09-29'), now);
  const wed = c.dayView(shifts, week.days.find(d => d.date === '2026-09-30'), now);
  // Meal 23:30–00:30 local: 30m on each side.
  assert.deepEqual([tue.workedMs, tue.mealBreakMs, wed.workedMs, wed.mealBreakMs], [1.5 * H, 30 * M, 1.5 * H, 30 * M]);
  assert.equal(tue.shifts[0].continuesNextDay, true); assert.equal(wed.shifts[0].continuesFromPreviousDay, true);
  assert.equal(tue.shifts[0].id, wed.shifts[0].id);
  assert.equal(c.windowTotals(shifts, week.startsAt, week.endsAt, now).workedMs, 3 * H);
});
test('workweek is Monday 00:00 to next Monday 00:00 in the business timezone', () => {
  // Sunday 2026-10-04 23:30 in New York is Monday 03:30Z: still the old week there.
  const ny = c.businessWeek(T('2026-10-05T03:30:00Z'), 'America/New_York');
  assert.deepEqual([ny.today, ny.startDate, ny.endDate], ['2026-10-04', '2026-09-28', '2026-10-04']);
  assert.equal(new Date(ny.startsAt).toISOString(), '2026-09-28T04:00:00.000Z');
  assert.equal(new Date(ny.endsAt).toISOString(), '2026-10-05T04:00:00.000Z');
  // The same instant in Tokyo is already Monday of the next week.
  const tokyo = c.businessWeek(T('2026-10-05T03:30:00Z'), 'Asia/Tokyo');
  assert.deepEqual([tokyo.today, tokyo.startDate], ['2026-10-05', '2026-10-05']);
  assert.equal(new Date(tokyo.startsAt).toISOString(), '2026-10-04T15:00:00.000Z');
  // A Monday is its own week start.
  assert.equal(c.businessWeek(T('2026-09-28T04:00:00Z'), 'America/New_York').startDate, '2026-09-28');
  assert.equal(c.businessWeek(T('2026-09-28T03:59:59Z'), 'America/New_York').startDate, '2026-09-21');
});
test('a shift open across the week boundary counts only its in-week part', () => {
  const tz = 'America/New_York', week = c.businessWeek(T('2026-09-29T12:00:00Z'), tz);
  const shifts = c.buildShifts([ev('CLOCK_IN', week.startsAt - 2 * H)]);
  assert.equal(c.windowTotals(shifts, week.startsAt, week.endsAt, week.startsAt + 3 * H).workedMs, 3 * H);
  const monday = c.dayView(shifts, week.days[0], week.startsAt + 3 * H);
  assert.equal(monday.shifts[0].continuesFromPreviousDay, true); assert.equal(monday.shifts[0].open, true);
});
test('DST: spring-forward and fall-back days are 23 and 25 hours; week boundaries stay at local midnight', () => {
  const tz = 'America/New_York';
  const spring = c.businessWeek(T('2027-03-12T12:00:00Z'), tz);  // DST starts Sun 2027-03-14
  const sunday = spring.days[6];
  assert.equal(sunday.date, '2027-03-14'); assert.equal(sunday.endsAt - sunday.startsAt, 23 * H);
  assert.equal(new Date(spring.startsAt).toISOString(), '2027-03-08T05:00:00.000Z');
  assert.equal(new Date(spring.endsAt).toISOString(), '2027-03-15T04:00:00.000Z');
  assert.equal(spring.endsAt - spring.startsAt, 167 * H);
  const fall = c.businessWeek(T('2026-11-02T12:00:00Z'), tz);     // DST ends Sun 2026-11-01
  const fallSunday = c.businessWeek(T('2026-11-01T12:00:00Z'), tz).days[6];
  assert.equal(fallSunday.endsAt - fallSunday.startsAt, 25 * H);
  assert.equal(new Date(fall.startsAt).toISOString(), '2026-11-02T05:00:00.000Z');
  // A shift spanning the 2am fall-back: wall clock 00:00–04:00 is 5 real hours.
  const shifts = c.buildShifts([ev('CLOCK_IN', T('2026-11-01T04:00:00Z')), ev('CLOCK_OUT', T('2026-11-01T09:00:00Z'))]);
  assert.equal(c.dayView(shifts, fallSunday, T('2026-11-02T00:00:00Z')).workedMs, 5 * H);
});
test('a zone whose midnight is skipped still gets an exact day start', () => {
  // America/Santiago springs forward at 00:00 → 01:00 (2026-09-06).
  const start = c.localDayStart('2026-09-06', 'America/Santiago');
  assert.equal(c.localDate(start, 'America/Santiago'), '2026-09-06');
  assert.equal(c.localDate(start - 1, 'America/Santiago'), '2026-09-05');
});
test('invalid timezones are refused', () => {
  assert.equal(c.validTimezone('America/New_York'), true);
  for (const bad of ['', 'Mars/Base', null, 5]) assert.equal(c.validTimezone(bad), false);
});
