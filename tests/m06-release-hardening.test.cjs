const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./support/working-fixture.cjs');
const { as } = require('./support/pglite-db.cjs');

test('historical multi-day shift is repaired by replacing its clock-out, with immutable issue/history and matching reports/CSV', async t => {
  const h = await fixture(t);
  const write = (route, body, key) => new Request(h.request(route), {
    method: 'POST', headers: { ...Object.fromEntries(h.request(route).headers), 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify(body),
  });
  const employee = await h.employee({ name: 'Synthetic long shift' });
  const event = (type, at, kind = null) => h.event(employee, type, Date.parse(at), kind);
  const clockIn = await event('CLOCK_IN', '2026-10-02T14:04:00-07:00');
  await event('BREAK_START', '2026-10-02T18:10:00-07:00', 'MEAL');
  const breakEnd = await event('BREAK_END', '2026-10-02T21:55:00-07:00', 'MEAL');
  const clockOut = await event('CLOCK_OUT', '2026-10-06T23:35:00-07:00');
  await event('CLOCK_IN', '2026-10-06T23:36:00-07:00');
  const originals = async () => (await h.db.query('select * from public.employee_time_events where employee_id=$1 order by seq', [employee])).rows;
  const before = await originals();
  const session = await h.sessionFor(employee);
  const issueId = (await as(h.db, 'service_role', "select public.m05_report_time_issue($1,$2,$3,$4,$5,'2026-10-02',$6,'Forgot to clock out') as r", [h.business, employee, h.device, session.id, randomUUID(), clockIn.id])).rows[0].r.issue.id;
  const sheets = h.load('server/handlers/timesheets.ts');
  const issues = h.load('server/handlers/time-issues.ts');
  const reports = h.load('server/handlers/time-reports.ts');
  const csv = h.load('server/time-reports.ts').reportCsv;
  const readIssue = async () => {
    const response = await issues.DETAIL(h.request(`/api/management/time-issues/${issueId}`));
    assert.equal(response.status, 200);
    return response.json();
  };
  const initial = await readIssue();
  assert.equal(initial.timesheet.days.find(d => d.date === '2026-10-03').workedMs, 24 * 3600000);
  assert.equal(initial.timesheet.days.find(d => d.date === '2026-10-02').shifts[0].open, false, 'later clock-out is retained as full shift context');
  const preview = async operations => {
    const response = await sheets.PREVIEW_CORRECTION(write(`/api/management/timesheets/${employee}/corrections/preview`, { operations, weekStart: '2026-09-28' }));
    return { status: response.status, body: await response.json() };
  };
  const duplicate = await preview([{ op: 'INSERT', type: 'CLOCK_OUT', occurredAt: '2026-10-02T22:00:00-07:00', after: breakEnd.id }]);
  assert.equal(duplicate.status, 422);
  assert.equal(duplicate.body.reason, 'INVALID_TRANSITION');
  const operations = [{ op: 'REPLACE', target: clockOut.id, occurredAt: '2026-10-02T22:00:00-07:00' }];
  const proposed = await preview(operations);
  assert.equal(proposed.status, 200);
  const committed = await sheets.COMMIT_CORRECTION(write(`/api/management/timesheets/${employee}/corrections`, {
    operations, weekStart: '2026-09-28', reason: 'Employee confirmed the actual clock-out',
    expectedRevision: proposed.body.correction.basedOnRevision, expectedWatermark: proposed.body.correction.basedOnWatermark,
  }, randomUUID()));
  assert.equal(committed.status, 201);
  const corrected = await committed.json();
  assert.equal(corrected.totals.workedMs, 251 * 60000);
  assert.deepEqual(await originals(), before);
  const context = await readIssue();
  assert.equal(context.issue.status, 'open', 'correction does not implicitly resolve the issue');
  assert.equal(context.issue.note, 'Forgot to clock out');
  assert.equal(context.timesheet.totals.workedMs, corrected.totals.workedMs);
  for (const grouping of ['employee', 'day', 'week', 'team']) {
    const response = await reports.EXPORT(write('/api/management/time-reports/export', { startDate: '2026-10-02', endDate: '2026-10-05', employeeId: employee, grouping }));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.report.totals.workedMs, corrected.totals.workedMs);
    assert.equal(result.report.rows.reduce((sum, row) => sum + row.workedMs, 0), corrected.totals.workedMs);
    assert.equal(result.report.totals.open, false);
    assert.equal(result.csv, csv(result.report));
  }
  const key = randomUUID();
  const resolve = () => issues.RESOLVE(write(`/api/management/time-issues/${issueId}/resolve`, { note: 'Corrected the existing late clock-out after employee review', correctionId: corrected.correction.id }, key));
  assert.equal((await resolve()).status, 201);
  assert.equal((await resolve()).status, 200);
  const resolved = await readIssue();
  assert.equal(resolved.issue.status, 'resolved');
  assert.equal(resolved.issue.resolution.correctionId, corrected.correction.id);
  assert.equal(resolved.issue.note, initial.issue.note);
  assert.deepEqual(await originals(), before);
});
