// M06 Slice 5 — native management correction UI: client API, pure correction
// logic, the rendered correction panel, and Timesheets integration.
const { test } = require('node:test');
const strict = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
const assert = Object.assign((...a) => strict(...a), strict, { deepEqual: (a, b, m) => strict.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), m) });
const root = 'apps/zude-mobile/src/';
function load(file, imports = {}, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(root + file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { exports, URL, URLSearchParams, AbortController, Date, Intl, JSON, ...globals, require(name) { if (Object.hasOwn(imports, name)) return imports[name]; throw Error('Unexpected import ' + name); } });
  return exports;
}
const B = 'business-a', TZ = 'America/Los_Angeles', H = 3600000;
class ApiError extends Error { constructor(status, code, message = 'private provider detail', reason) { super(message); this.status = status; this.code = code; this.reason = reason; } }
const zero = { workedMs: 0, paidBreakMs: 0, mealBreakMs: 0 };
// A week with one open shift on Tue 2026-03-03 (09:00 PST clock-in).
function sheet({ employee = { id: 'riley', name: 'Riley', role: 'employee', isActive: true }, events, shifts, totals, days } = {}) {
  const d = (i) => new Date(Date.parse('2026-03-02T00:00:00Z') + i * 86400000).toISOString().slice(0, 10);
  const clockIn = { id: 'in1', shiftId: 'in1', seq: 1, type: 'CLOCK_IN', breakType: null, occurredAt: '2026-03-03T17:00:00Z', origin: 'original', corrected: false, correctionRevision: null };
  const shift = { id: 'in1', clockInAt: clockIn.occurredAt, clockOutAt: null, open: true, continuesFromPreviousDay: false, continuesNextDay: true, ...zero, workedMs: 7 * H, breaks: [] };
  return { businessId: B, employee, timezone: TZ, snapshotAt: '2026-03-08T12:00:00Z', currentWeekStart: '2026-03-09', previousWeekStart: '2026-02-23', nextWeekStart: '2026-03-09',
    week: { startDate: '2026-03-02', endDate: '2026-03-08', startsAt: '2026-03-02T08:00:00Z', endsAt: '2026-03-09T07:00:00Z' },
    totals: totals ?? { ...zero, workedMs: 100 * H, hasOpenShift: true },
    days: days ?? Array.from({ length: 7 }, (_, i) => ({ date: d(i), startsAt: d(i) + 'T08:00:00Z', endsAt: d(i + 1) + 'T08:00:00Z', ...zero, workedMs: i === 1 ? 7 * H : i > 1 ? 24 * H : 0, shifts: i === 1 ? (shifts ?? [shift]) : [] })),
    events: events ?? [clockIn] };
}
const tsApi = (api) => load('lib/timesheets-api.ts', { './api': api, './operational-identity': { operationalRequest: async (b, send) => send({ 'x-zude-device': 'DEVICE', 'x-zude-employee-session': 'SESSION' }) } });
const realState = load('features/time/state.ts', { '../../lib/api': { ZudeApiError: ApiError } });
const correction = load('features/timesheets/correction.ts', { '../../lib/api': { ZudeApiError: ApiError }, '../time/state': realState });

// ---- Client API ---------------------------------------------------------------------------
function transport(respond) {
  const calls = [];
  const api = load('lib/api.ts', { './supabase': { supabase: { auth: { async getSession() { return { data: { session: { access_token: 'TOKEN', user: { id: 'account' } } }, error: null }; } } } } }, {
    __DEV__: false, process: { env: { EXPO_PUBLIC_ZUDE_API_URL: 'https://zude.invalid' } },
    async fetch(url, init) { const u = new URL(url); calls.push({ u, init, body: init.body ? JSON.parse(init.body) : undefined }); const { status = 200, body } = respond(u, init); return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); },
  });
  return { calls, api, ts: tsApi(api) };
}
const op = [{ op: 'INSERT', type: 'CLOCK_OUT', occurredAt: '2026-03-04T01:00:00.000Z', after: 'in1' }];
test('preview/commit use the existing transport, operational headers and a stable Idempotency-Key; no client authority', async () => {
  const fresh = sheet();
  const h = transport((u) => ({ status: u.pathname.endsWith('/preview') ? 200 : 201, body: u.pathname.endsWith('/preview')
    ? { success: true, ...fresh, preview: true, correction: { basedOnRevision: 2, basedOnWatermark: 41, resultingState: 'OFF_CLOCK' } }
    : { success: true, ...fresh, correction: { id: 'c1', revision: 3, watermark: 41, replayed: false } } }));
  const p = await h.ts.previewTimeCorrection(B, 'riley', { operations: op, weekStart: '2026-03-02' }, new AbortController().signal);
  assert.deepEqual([p.basedOnRevision, p.basedOnWatermark, p.resultingState], [2, 41, 'OFF_CLOCK']);
  const r = await h.ts.commitTimeCorrection(B, 'riley', 'account', { operations: op, reason: 'Forgot to clock out', expectedRevision: 2, expectedWatermark: 41, weekStart: '2026-03-02' }, 'key-1');
  assert.deepEqual([r.id, r.revision, r.replayed], ['c1', 3, false]); assert.equal(r.timesheet.employee.id, 'riley');
  const [pv, cm] = h.calls;
  assert.equal(pv.u.pathname, '/api/management/timesheets/riley/corrections/preview'); assert.equal(cm.u.pathname, '/api/management/timesheets/riley/corrections');
  assert.deepEqual(pv.body, { operations: op, weekStart: '2026-03-02' });
  assert.deepEqual(cm.body, { operations: op, reason: 'Forgot to clock out', expectedRevision: 2, expectedWatermark: 41, weekStart: '2026-03-02' });
  assert.equal(cm.init.headers['Idempotency-Key'], 'key-1'); assert.equal(cm.init.headers.Authorization, 'Bearer TOKEN');
  for (const c of h.calls) { assert.equal(c.init.headers['x-zude-device'], 'DEVICE'); assert.equal(c.init.headers['x-anaai-business-id'], B); assert.doesNotMatch(JSON.stringify(c.body), /role|actor|workedMs|businessId/); }
});
test('invalid-correction reason codes reach the UI; malformed or foreign responses are rejected', async () => {
  const h = transport(() => ({ status: 422, body: { success: false, code: 'TIME_CORRECTION_INVALID', reason: 'OUT_OF_ORDER', eventId: 'x', error: 'SQL private detail' } }));
  await assert.rejects(h.ts.previewTimeCorrection(B, 'riley', { operations: op, weekStart: '2026-03-02' }, new AbortController().signal), e => e.code === 'TIME_CORRECTION_INVALID' && e.reason === 'OUT_OF_ORDER' && !e.message.includes('SQL'));
  const bad = transport(() => ({ status: 422, body: { success: false, code: 'TIME_CORRECTION_INVALID', reason: '<script>' } }));
  await assert.rejects(bad.ts.previewTimeCorrection(B, 'riley', { operations: op, weekStart: '2026-03-02' }, new AbortController().signal), e => e.reason === undefined);
  for (const body of [{ success: true, ...sheet(), preview: true, correction: { basedOnRevision: -1, basedOnWatermark: 1, resultingState: 'OFF_CLOCK' } },
    { success: true, ...sheet({ employee: { id: 'other', name: 'O', role: 'employee', isActive: true } }), preview: true, correction: { basedOnRevision: 0, basedOnWatermark: 1, resultingState: 'OFF_CLOCK' } }]) {
    await assert.rejects(transport(() => ({ body })).ts.previewTimeCorrection(B, 'riley', { operations: op, weekStart: '2026-03-02' }, new AbortController().signal), e => e.code === 'INVALID_RESPONSE');
  }
  const prov = sheet({ events: [{ ...sheet().events[0], origin: 'inserted', corrected: false, correctionRevision: 2 }] });
  const parsed = await transport(() => ({ body: { success: true, ...prov } })).ts.getTimesheet(B, 'riley', '2026-03-02', new AbortController().signal);
  assert.deepEqual([parsed.events[0].origin, parsed.events[0].correctionRevision], ['inserted', 2]);
});

// ---- Pure logic ---------------------------------------------------------------------------
test('business-timezone entry: 12h/24h times, DST gap rejected, DST overlap requires a choice', () => {
  const c = correction;
  assert.equal(c.parseClock('5:30 PM'), 17 * 60 + 30); assert.equal(c.parseClock('17:30'), 17 * 60 + 30); assert.equal(c.parseClock('12 am'), 0); assert.equal(c.parseClock('9'), null); assert.equal(c.parseClock('25:00'), null);
  assert.deepEqual(c.resolveTime({ date: '2026-03-03', time: '5:00 PM' }, TZ), { ok: true, iso: '2026-03-04T01:00:00.000Z' }, 'business time, not device time');
  assert.equal(c.resolveTime({ date: '2026-03-08', time: '2:30 AM' }, TZ).problem, 'nonexistent');
  const amb = c.resolveTime({ date: '2025-11-02', time: '1:30 AM' }, TZ);
  assert.equal(amb.problem, 'ambiguous'); assert.deepEqual(amb.options.map(o => o.iso), ['2025-11-02T08:30:00.000Z', '2025-11-02T09:30:00.000Z']);
  assert.match(amb.options[0].label, /PDT/); assert.match(amb.options[1].label, /PST/);
  assert.deepEqual(c.resolveTime({ date: '2025-11-02', time: '1:30 AM', choice: amb.options[1].iso }, TZ), { ok: true, iso: '2025-11-02T09:30:00.000Z' });
  assert.match(c.timeProblem(amb, TZ), /happens twice/); assert.match(c.timeProblem({ ok: false, problem: 'nonexistent' }, TZ), /doesn’t exist/);
});
test('5-11. drafts become stable-id operations (never indexes) for every human action', () => {
  const c = correction, at = (time, date = '2026-03-03') => ({ date, time });
  const breakStart = { id: 'bs', shiftId: 'in1', seq: 2, type: 'BREAK_START', breakType: 'PAID', occurredAt: '2026-03-03T19:00:00Z', origin: 'original', corrected: false, correctionRevision: null };
  const breakEnd = { ...breakStart, id: 'be', seq: 3, type: 'BREAK_END', occurredAt: '2026-03-03T19:10:00Z' };
  const s = sheet({ events: [sheet().events[0], breakStart, breakEnd] });
  assert.deepEqual(c.buildOperations({ kind: 'add-clock-out', shiftId: 'in1', at: at('5:00 PM') }, s), { ok: true, operations: [{ op: 'INSERT', type: 'CLOCK_OUT', occurredAt: '2026-03-04T01:00:00.000Z', after: 'be' }] });
  const shift = c.buildOperations({ kind: 'add-shift', clockIn: at('6:00 AM'), clockOut: at('8:00 AM') }, s);
  assert.deepEqual(shift.operations.map(o => [o.op, o.type, o.before ?? o.after ?? o.afterRef]), [['INSERT', 'CLOCK_IN', 'in1'], ['INSERT', 'CLOCK_OUT', 'shift']], 'missing clock-in placed before the next entry');
  const meal = c.buildOperations({ kind: 'add-break', shiftId: 'in1', breakType: 'MEAL', start: at('12:00 PM'), end: at('12:30 PM') }, s);
  assert.deepEqual(meal.operations.map(o => [o.type, o.breakType, o.after ?? o.afterRef]), [['BREAK_START', 'MEAL', 'be'], ['BREAK_END', 'MEAL', 'break']]);
  const paid = c.buildOperations({ kind: 'add-break', shiftId: 'in1', breakType: 'PAID', start: at('10:00 AM'), end: at('10:10 AM') }, s);
  assert.deepEqual(paid.operations.map(o => [o.type, o.breakType, o.after ?? o.afterRef]), [['BREAK_START', 'PAID', 'in1'], ['BREAK_END', 'PAID', 'break']], 'positioned within the shift by time');
  assert.deepEqual(c.buildOperations({ kind: 'correct-time', eventId: 'in1', at: at('8:45 AM') }, s).operations, [{ op: 'REPLACE', target: 'in1', occurredAt: '2026-03-03T16:45:00.000Z' }]);
  assert.deepEqual(c.buildOperations({ kind: 'change-break-type', eventId: 'bs', to: 'MEAL' }, s).operations,
    [{ op: 'REPLACE', target: 'bs', occurredAt: breakStart.occurredAt, breakType: 'MEAL' }, { op: 'REPLACE', target: 'be', occurredAt: breakEnd.occurredAt, breakType: 'MEAL' }]);
  assert.deepEqual(c.buildOperations({ kind: 'remove', eventIds: ['bs', 'be'] }, s).operations, [{ op: 'VOID', target: 'bs' }, { op: 'VOID', target: 'be' }]);
  // Guard rails that explain instead of guessing.
  assert.match(c.buildOperations({ kind: 'add-clock-out', shiftId: 'in1', at: at('') }, s).message, /Enter a date and time/);
  const open = sheet({ events: [sheet().events[0], breakStart] });
  assert.match(c.buildOperations({ kind: 'add-clock-out', shiftId: 'in1', at: at('5:00 PM') }, open).message, /open break/);
  assert.deepEqual(c.buildOperations({ kind: 'add-break-end', shiftId: 'in1', at: at('11:15 AM') }, open).operations, [{ op: 'INSERT', type: 'BREAK_END', breakType: 'PAID', occurredAt: '2026-03-03T19:15:00.000Z', after: 'bs' }]);
  assert.match(c.buildOperations({ kind: 'add-shift', clockIn: at('6:00 AM'), clockOut: at('8:00 AM') }, sheet({ events: [] })).message, /empty week/);
});
test('17-20/43. plain-language review, before/after including overnight days, and removal is never "deleted"', () => {
  const c = correction, before = sheet();
  const after = sheet({ totals: { ...zero, workedMs: 8 * H, hasOpenShift: false } });
  after.days = after.days.map((d, i) => ({ ...d, workedMs: i === 1 ? 7 * H : i === 2 ? H : 0 }));
  const changes = c.previewChanges(before, after);
  assert.deepEqual(changes.totals[0], { label: 'Worked', before: '100h 00m', after: '8h 00m', changed: true });
  assert.deepEqual(changes.days.map(d => d.date), ['2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08'], 'every changed day, including after midnight');
  assert.deepEqual([changes.openBefore, changes.openAfter], [true, false]);
  const lines = c.describeOperations([...op, { op: 'VOID', target: 'in1' }, { op: 'REPLACE', target: 'in1', occurredAt: '2026-03-03T16:45:00Z' }], before);
  assert.match(lines[0], /^Add clock out · Tue, Mar 3, 5:00 PM$/);
  assert.match(lines[1], /Remove clock in .* from calculated time/); assert.doesNotMatch(lines.join(' '), /delet|VOID|INSERT|REPLACE|anchor|revision|entry id/i);
  assert.match(lines[2], /Change clock in from Tue, Mar 3, 9:00 AM to Tue, Mar 3, 8:45 AM/);
  assert.equal(c.stateLabel('OFF_CLOCK'), 'Off the clock');
});
test('29-35. every server reason maps to guidance; raw text never shown', () => {
  const c = correction;
  const expected = { INVALID_TRANSITION: /impossible sequence/, OUT_OF_ORDER: /stay in order/, FUTURE_EVENT: /future/, TARGET_NOT_FOUND: /no longer in this timesheet/, TARGET_VOIDED: /already removed/, ANCHOR_NOT_FOUND: /surrounding time record changed/, INVALID_OPERATION: /isn’t available/ };
  for (const [reason, pattern] of Object.entries(expected)) {
    const text = c.correctionMessage(new ApiError(422, 'TIME_CORRECTION_INVALID', 'SQLSTATE Z0001 private', reason));
    assert.match(text, pattern); assert.doesNotMatch(text, /SQL|private|Z0001/);
  }
  assert.match(c.correctionMessage(new ApiError(409, 'TIME_CORRECTION_STALE')), /Time history changed since this correction was reviewed/);
  for (const e of [new ApiError(500, 'X', 'stack trace at db'), new Error('boom')]) assert.doesNotMatch(c.correctionMessage(e), /stack|boom/);
  assert.equal(c.commitUncertain(new ApiError(0, 'NETWORK_ERROR')), true); assert.equal(c.commitUncertain(new ApiError(503, 'TIME_UNAVAILABLE')), true);
  assert.equal(c.commitUncertain(new ApiError(409, 'TIME_CORRECTION_STALE')), false);
  assert.equal(c.mayCorrect('manager', 'employee'), true); assert.equal(c.mayCorrect('manager', 'manager'), false); assert.equal(c.mayCorrect('manager', 'owner'), false);
  assert.equal(c.mayCorrect('owner', 'manager'), true); assert.equal(c.mayCorrect('owner', 'owner'), true); assert.equal(c.mayCorrect('staff', 'employee'), false);
});

// ---- Correction panel ---------------------------------------------------------------------
function panel({ base = sheet(), dayIndex = 1 } = {}) {
  const slots = [], pending = [], calls = [], events = [];
  let cursor = 0, dirty = false, tree, uuid = 0;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => v === b[i]);
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], v => { const next = typeof v === 'function' ? v(slots[i]) : v; if (!Object.is(next, slots[i])) { slots[i] = next; dirty = true; } }]; },
    useRef(initial) { const i = cursor++; return slots[i] ?? (slots[i] = { current: initial }); },
    useEffect(fn, deps) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) { const prev = slots[i]; slots[i] = { deps, cleanup: prev?.cleanup }; pending.push(() => { slots[i].cleanup?.(); slots[i].cleanup = fn(); }); } },
  };
  // Closing the overnight shift changes Tue and every following day.
  const fresh = sheet({ totals: { ...zero, workedMs: 8 * H, hasOpenShift: false } });
  fresh.days = fresh.days.map((d, i) => ({ ...d, workedMs: i === 1 ? 7 * H : i === 2 ? H : 0 }));
  const api = {
    previewTimeCorrection(...args) { return new Promise((resolve, reject) => calls.push({ kind: 'preview', args, resolve, reject })); },
    commitTimeCorrection(...args) { return new Promise((resolve, reject) => calls.push({ kind: 'commit', args, resolve, reject })); },
  };
  const Panel = load('features/timesheets/CorrectionPanel.tsx', {
    react, 'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'Fragment' },
    'react-native': { StyleSheet: { create: s => s }, Text: 'Text', View: 'View' }, 'expo-crypto': { randomUUID: () => 'key-' + ++uuid },
    '../../components/ui': { Button: 'Button', styles: {} }, '../../components/records': { LabeledField: 'LabeledField', recordStyles: {} },
    '../../components/workspace': { PaneTitle: 'PaneTitle' }, '../../lib/api': { ZudeApiError: ApiError }, '../../lib/timesheets-api': api,
    '../../theme/tokens': load('theme/tokens.ts'), '../time/state': realState, '../appointments/controls': { Notice: 'Notice' }, './correction': correction,
  }).CorrectionPanel;
  const props = { businessId: B, userId: 'account', sheet: base, day: base.days[dayIndex],
    onCommitted: (t, replayed) => events.push(['committed', t, replayed]), onStale: () => events.push(['stale']), onAuthorityLost: (e) => events.push(['authority', e.code]), onClose: () => events.push(['close']) };
  function nodes(n) { if (!n || typeof n !== 'object') return []; if (Array.isArray(n)) return n.flatMap(nodes); return [n, ...['children', 'action'].flatMap(k => nodes(n.props?.[k]))]; }
  const h = {
    calls, events, fresh,
    render() { let n = 0; do { assert.ok(n++ < 15); dirty = false; cursor = 0; tree = Panel(props); while (pending.length) pending.shift()(); } while (dirty); return tree; },
    nodes() { return nodes(tree); },
    text() { return h.nodes().map(n => n.type === 'Text' ? [].concat(n.props.children).filter(v => typeof v === 'string' || typeof v === 'number').join('') : n.type === 'Notice' ? n.props.message : n.type === 'PaneTitle' ? n.props.title : '').join('\n'); },
    button(label) { return h.nodes().find(n => n.type === 'Button' && n.props.label === label); },
    labels() { return h.nodes().filter(n => n.type === 'Button').map(n => n.props.label); },
    click(label) { h.render(); const b = h.button(label); assert.ok(b, 'Button ' + label + ' in ' + h.labels().join('|')); assert.ok(!b.props.disabled, 'Enabled ' + label); b.props.onPress(); h.render(); },
    type(label, value) { h.render(); const f = h.nodes().find(n => n.type === 'LabeledField' && n.props.label === label); assert.ok(f, 'Field ' + label); f.props.onChangeText(value); h.render(); },
    field(label) { return h.nodes().find(n => n.type === 'LabeledField' && n.props.label === label); },
    async resolve(i, value) { calls[i].resolve(value); await new Promise(r => setImmediate(r)); h.render(); },
    async reject(i, error) { calls[i].reject(error); await new Promise(r => setImmediate(r)); h.render(); },
    unmount() { for (const s of slots) s?.cleanup?.(); },
  };
  h.render();
  return h;
}
const previewOf = (h, state = 'OFF_CLOCK') => ({ timesheet: h.fresh, basedOnRevision: 4, basedOnWatermark: 41, resultingState: state });
async function reviewed(h) {
  h.click('Add missing clock-out'); h.type('Clock-out time', '5:00 PM'); h.click('Preview correction');
  await h.resolve(0, previewOf(h));
}
test('5/12/17/19. add a missing clock-out: preview first, review before/after and resulting state; no commit without preview', async () => {
  const h = panel();
  assert.match(h.text(), /What needs correcting/); assert.equal(h.button('Save correction'), undefined, 'no commit control before preview');
  h.click('Add missing clock-out');
  assert.equal(h.field('Clock-out date').props.value, '2026-03-03'); assert.match(h.field('Clock-out time').props.hint, /America\/Los_Angeles/);
  h.type('Clock-out time', '5:00 PM'); h.click('Preview correction');
  assert.equal(h.calls[0].kind, 'preview'); assert.deepEqual(h.calls[0].args.slice(0, 3), [B, 'riley', { operations: [{ op: 'INSERT', type: 'CLOCK_OUT', occurredAt: '2026-03-04T01:00:00.000Z', after: 'in1' }], weekStart: '2026-03-02' }]);
  await h.resolve(0, previewOf(h));
  const text = h.text();
  assert.match(text, /Review correction/); assert.match(text, /Add clock out · Tue, Mar 3, 5:00 PM/);
  assert.match(text, /Worked: 100h 00m → 8h 00m/); assert.match(text, /Open shift: yes → no/); assert.match(text, /will be: Off the clock/);
  assert.match(text, /This correction changes more than one day/, '20. multi-day impact surfaced');
  assert.equal(h.calls.filter(c => c.kind === 'commit').length, 0);
});
test('13/14. a reason is required and whitespace-only reasons are rejected; explicit confirmation precedes the commit', async () => {
  const h = panel(); await reviewed(h);
  assert.equal(h.button('Save correction').props.disabled, true);
  h.type('Reason for this correction', '    '); assert.equal(h.button('Save correction').props.disabled, true);
  assert.equal(h.field('Reason for this correction').props.maxLength, 500); assert.equal(h.field('Reason for this correction').props.value, '    ', 'never prefilled');
  h.type('Reason for this correction', '  Employee forgot to clock out  ');
  h.click('Save correction'); assert.equal(h.calls.length, 1, 'confirmation step first');
  assert.match(h.text(), /Save this correction to Riley’s time history\?/);
  h.click('Keep reviewing'); assert.equal(h.calls.length, 1);
  h.click('Save correction'); h.click('Yes, save correction');
  assert.equal(h.calls[1].kind, 'commit');
  assert.deepEqual(h.calls[1].args.slice(0, 4), [B, 'riley', 'account', { operations: [{ op: 'INSERT', type: 'CLOCK_OUT', occurredAt: '2026-03-04T01:00:00.000Z', after: 'in1' }], reason: 'Employee forgot to clock out', expectedRevision: 4, expectedWatermark: 41, weekStart: '2026-03-02' }]);
});
test('15/16/24/28. success hands the server timesheet back (replay counts as success); double taps send one commit', async () => {
  const h = panel(); await reviewed(h);
  h.type('Reason for this correction', 'Forgot to clock out'); h.click('Save correction');
  const yes = h.button('Yes, save correction'); yes.props.onPress(); yes.props.onPress(); h.render();
  assert.equal(h.calls.filter(c => c.kind === 'commit').length, 1);
  await h.resolve(1, { timesheet: h.fresh, id: 'c1', revision: 5, replayed: true });
  assert.deepEqual(h.events.map(e => e[0]), ['committed']); assert.equal(h.events[0][1], h.fresh); assert.equal(h.events[0][2], true);
});
test('21-23. TIME_CORRECTION_STALE discards the preview, refreshes, and requires a new preview and confirmation', async () => {
  const h = panel(); await reviewed(h);
  h.type('Reason for this correction', 'Forgot to clock out'); h.click('Save correction'); h.click('Yes, save correction');
  await h.reject(1, new ApiError(409, 'TIME_CORRECTION_STALE'));
  assert.deepEqual(h.events, [['stale']]); assert.match(h.text(), /Time history changed since this correction was reviewed/);
  assert.equal(h.button('Save correction'), undefined); assert.equal(h.button('Yes, save correction'), undefined); assert.ok(h.button('Preview correction'));
  assert.equal(h.field('Clock-out time').props.value, '5:00 PM', 'draft kept for a fresh preview');
  h.click('Preview correction'); assert.equal(h.calls[2].kind, 'preview');
  await h.resolve(2, previewOf(h)); assert.equal(h.field('Reason for this correction').props.value, '', 'reason re-entered for the new review');
  h.type('Reason for this correction', 'Forgot to clock out'); h.click('Save correction'); h.click('Yes, save correction');
  assert.notEqual(h.calls[3].args[4], h.calls[1].args[4], 'a new intent gets a new key');
});
test('25/26. an uncertain commit keeps the same key and exact request for the retry', async () => {
  const h = panel(); await reviewed(h);
  h.type('Reason for this correction', 'Forgot to clock out'); h.click('Save correction'); h.click('Yes, save correction');
  await h.reject(1, new ApiError(0, 'NETWORK_ERROR'));
  assert.match(h.text(), /didn’t confirm whether this correction was saved/); assert.doesNotMatch(h.text(), /failed/i);
  assert.equal(h.button('Close').props.disabled, true, 'the pending intent cannot be abandoned by accident');
  h.click('Retry saving');
  assert.deepEqual(h.calls[2].args, h.calls[1].args, 'same key and same payload');
  await h.reject(2, new ApiError(503, 'TIME_UNAVAILABLE')); h.click('Retry saving');
  assert.equal(h.calls[3].args[4], h.calls[1].args[4]);
  await h.resolve(3, { timesheet: h.fresh, id: 'c1', revision: 5, replayed: true });
  assert.equal(h.events[0][0], 'committed');
  // Discarding instead: refresh and require a new review.
  const d = panel(); await reviewed(d); d.type('Reason for this correction', 'x'); d.click('Save correction'); d.click('Yes, save correction');
  await d.reject(1, new ApiError(0, 'NETWORK_ERROR')); d.click('Discard and refresh');
  assert.deepEqual(d.events, [['stale']]); assert.match(d.text(), /If the correction was saved, it now appears/); assert.equal(d.button('Retry saving'), undefined);
});
test('27. editing the proposal after preview invalidates the preview and its commit intent', async () => {
  const h = panel(); await reviewed(h);
  h.click('Change correction'); assert.equal(h.button('Save correction'), undefined);
  h.type('Clock-out time', '5:15 PM'); h.click('Preview correction');
  assert.equal(h.calls[1].kind, 'preview'); assert.equal(h.calls[1].args[2].operations[0].occurredAt, '2026-03-04T01:15:00.000Z');
  // A late answer to a superseded preview is ignored.
  const s = panel(); s.click('Add missing clock-out'); s.type('Clock-out time', '5:00 PM'); s.click('Preview correction');
  s.type('Clock-out time', '6:00 PM'); assert.equal(s.calls[0].args[3].aborted, true);
  await s.resolve(0, previewOf(s)); assert.doesNotMatch(s.text(), /Review correction/);
});
test('29-35. server rejections show actionable guidance only; authority loss is handed to the screen', async () => {
  for (const [reason, pattern] of [['INVALID_TRANSITION', /impossible sequence/], ['OUT_OF_ORDER', /stay in order/], ['FUTURE_EVENT', /future/], ['TARGET_NOT_FOUND', /no longer in this timesheet/], ['TARGET_VOIDED', /already removed/], ['ANCHOR_NOT_FOUND', /surrounding time record/]]) {
    const h = panel(); h.click('Add missing clock-out'); h.type('Clock-out time', '5:00 PM'); h.click('Preview correction');
    await h.reject(0, new ApiError(422, 'TIME_CORRECTION_INVALID', 'SQLSTATE Z0001 detail', reason));
    assert.match(h.text(), pattern); assert.doesNotMatch(h.text(), /SQLSTATE|Z0001|detail/); assert.equal(h.button('Save correction'), undefined);
  }
  const a = panel(); a.click('Add missing clock-out'); a.type('Clock-out time', '5:00 PM'); a.click('Preview correction');
  await a.reject(0, new ApiError(403, 'ROLE_FORBIDDEN')); assert.deepEqual(a.events, [['authority', 'ROLE_FORBIDDEN']]);
});
test('6-11. other human actions build the expected previews', async () => {
  const bs = { id: 'bs', shiftId: 'in1', seq: 2, type: 'BREAK_START', breakType: 'PAID', occurredAt: '2026-03-03T19:00:00Z', origin: 'original', corrected: false, correctionRevision: null };
  const be = { ...bs, id: 'be', seq: 3, type: 'BREAK_END', occurredAt: '2026-03-03T19:10:00Z' };
  const base = sheet({ events: [sheet().events[0], bs, be] });
  const run = async (steps) => { const h = panel({ base }); steps(h); return h.calls[0]?.args[2]?.operations; };
  assert.deepEqual((await run(h => { h.click('Add missing clock-in and clock-out'); h.type('Clock-in time', '6:00 AM'); h.type('Clock-out time', '8:00 AM'); h.click('Preview correction'); })).map(o => o.type), ['CLOCK_IN', 'CLOCK_OUT']);
  assert.deepEqual((await run(h => { h.click('Add a missed break'); h.click('Meal break'); h.type('Break start time', '12:00 PM'); h.type('Break end time', '12:30 PM'); h.click('Preview correction'); })).map(o => [o.type, o.breakType]), [['BREAK_START', 'MEAL'], ['BREAK_END', 'MEAL']]);
  assert.deepEqual(await run(h => { h.click('Correct an entry’s time'); h.click('Clock in · Tue, Mar 3, 9:00 AM'); h.type('Correct time', '8:45 AM'); h.click('Preview correction'); }), [{ op: 'REPLACE', target: 'in1', occurredAt: '2026-03-03T16:45:00.000Z' }]);
  assert.deepEqual((await run(h => { h.click('Change a break between paid and meal'); h.click('Paid break started · Tue, Mar 3, 11:00 AM'); h.click('Preview correction'); })).map(o => o.breakType), ['MEAL', 'MEAL']);
  const removal = panel({ base }); removal.click('Remove a mistaken entry'); removal.click('Paid break started · Tue, Mar 3, 11:00 AM');
  assert.match(removal.text(), /original entry stays in ZUDE’s time history/); assert.doesNotMatch(removal.text(), /delet/i);
  removal.click('Remove the whole break instead'); removal.click('Preview correction');
  assert.deepEqual(removal.calls[0].args[2].operations, [{ op: 'VOID', target: 'bs' }, { op: 'VOID', target: 'be' }]);
  await removal.resolve(0, previewOf(removal, 'WORKING'));
  assert.match(removal.text(), /Removed entries are not deleted/);
});
test('39/40. responses arriving after the panel is gone (Lock, identity, business change) are ignored', async () => {
  const h = panel(); h.click('Add missing clock-out'); h.type('Clock-out time', '5:00 PM'); h.click('Preview correction');
  h.unmount(); assert.equal(h.calls[0].args[3].aborted, true);
  const c = panel(); await reviewed(c); c.type('Reason for this correction', 'x'); c.click('Save correction'); c.click('Yes, save correction');
  c.unmount(); await c.resolve(1, { timesheet: c.fresh, id: 'c1', revision: 5, replayed: false });
  assert.deepEqual(c.events, [], 'no committed callback repopulates state after identity change');
});

// ---- Timesheets integration ------------------------------------------------------------------
function screen(over = {}, data = sheet()) {
  const slots = [], pending = [], calls = [];
  let cursor = 0, dirty = false, tree;
  const context = { business: { id: B, name: 'Salon', role: 'owner' }, userId: 'account', managementRole: 'manager', sharedMode: true, identity: { employee: { id: 'mgr' }, expiresAt: 'x' }, ...over };
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => v === b[i]);
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], v => { const next = typeof v === 'function' ? v(slots[i]) : v; if (!Object.is(next, slots[i])) { slots[i] = next; dirty = true; } }]; },
    useRef(initial) { const i = cursor++; return slots[i] ?? (slots[i] = { current: initial }); },
    useCallback(fn, deps) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { fn, deps }; return slots[i].fn; },
    useEffect(fn, deps) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) { const prev = slots[i]; slots[i] = { deps, cleanup: prev?.cleanup }; pending.push(() => { slots[i].cleanup?.(); slots[i].cleanup = fn(); }); } },
  };
  const native = { View: 'View', Text: 'Text', StyleSheet: { create: s => s }, AppState: { addEventListener: () => ({ remove() {} }) } };
  const api = { getTimesheetDirectory: () => new Promise(r => calls.push({ kind: 'directory', resolve: r })), getTimesheet: () => new Promise(r => calls.push({ kind: 'sheet', resolve: r })),
    timesheetMessage: () => 'safe' };
  const Screen = load('features/timesheets/TimesheetsScreen.tsx', {
    react, 'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }, 'react-native': native,
    'expo-router': { useFocusEffect(fn) { react.useEffect(() => fn(), [fn]); } },
    '../../components/ui': { Badge: 'Badge', Button: 'Button', styles: {} }, '../../components/records': { RecordRow: 'RecordRow', recordStyles: {} },
    '../../components/workspace': { Feedback: 'Feedback', MasterDetail: 'MasterDetail', PaneTitle: 'PaneTitle', WorkspaceHeader: 'WorkspaceHeader', workspaceStyles: {} },
    '../../lib/api': { ZudeApiError: ApiError }, '../../lib/timesheets-api': api, '../business/BusinessContext': { useBusiness: () => context }, '../identity/EmployeeIdentityContext': { useEmployeeIdentity: () => context },
    '../time/useTimeResource': load('features/time/useTimeResource.ts', { react, 'react-native': native, '../../lib/api': { ZudeApiError: ApiError } }),
    '../time/state': realState, '../../theme/tokens': load('theme/tokens.ts'), '../appointments/controls': { Notice: 'Notice' },
    './CorrectionPanel': { CorrectionPanel: 'CorrectionPanel' }, './correction': correction,
  }).TimesheetsScreen;
  function nodes(n) { if (!n || typeof n !== 'object') return []; if (Array.isArray(n)) return n.flatMap(nodes); return [n, ...['children', 'action', 'master', 'detail'].flatMap(k => nodes(n.props?.[k]))]; }
  const h = { context, calls,
    render() { let n = 0; do { assert.ok(n++ < 15); dirty = false; cursor = 0; tree = Screen(); while (pending.length) pending.shift()(); } while (dirty); return tree; },
    nodes() { return nodes(tree); }, button(label) { return h.nodes().find(n => n.type === 'Button' && n.props.label === label); },
    panel() { return h.nodes().find(n => n.type === 'CorrectionPanel'); },
    click(label) { const n = h.button(label) || h.nodes().find(n => n.type === 'RecordRow' && n.props.label === label); assert.ok(n, label); n.props.onPress(); h.render(); },
    async open() { h.calls[0].resolve({ businessId: B, employees: [data.employee] }); await new Promise(r => setImmediate(r)); h.render(); h.click(`View timesheet for ${data.employee.name}`); h.calls[1].resolve(data); await new Promise(r => setImmediate(r)); h.render(); h.click('View Tue, Mar 3'); },
    text() { return h.nodes().map(n => n.type === 'Text' ? [].concat(n.props.children).filter(v => typeof v === 'string').join('') : n.type === 'Badge' ? n.props.label : n.type === 'Notice' ? n.props.message : '').join('\n'); },
  };
  h.render(); return h;
}
test('1/2/4. correction entry point appears only for permitted targets (mirrors server hierarchy)', async () => {
  const m = screen(); await m.open(); assert.ok(m.button('Correct time'), 'manager → regular employee');
  const o = screen({ managementRole: 'owner' }, sheet({ employee: { id: 'mia', name: 'Mia', role: 'manager', isActive: true } })); await o.open(); assert.ok(o.button('Correct time'), 'owner → manager');
  const blocked = screen({}, sheet({ employee: { id: 'mia', name: 'Mia', role: 'manager', isActive: true } })); await blocked.open();
  assert.equal(blocked.button('Correct time'), undefined, 'manager gets no control for a manager');
  assert.equal(m.panel(), undefined, 'nothing opens until chosen'); m.click('Correct time');
  const p = m.panel(); assert.ok(p); assert.equal(p.props.sheet.employee.id, 'riley'); assert.equal(p.props.day.date, '2026-03-03');
});
test('3. employee PIN / staff / locked route never shows correction controls or loads data', () => {
  for (const over of [{ managementRole: 'staff' }, { identity: null }, { userId: null }]) {
    const h = screen(over); assert.equal(h.calls.length, 0); assert.equal(h.button('Correct time'), undefined); assert.equal(h.panel(), undefined);
  }
  for (const file of ['features/time/TimeClockScreen.tsx', 'features/time/MyTimeScreen.tsx', 'features/time/ClockInLanding.tsx']) {
    assert.doesNotMatch(fs.readFileSync(root + file, 'utf8'), /CorrectionPanel|previewTimeCorrection|commitTimeCorrection/, file);
  }
  const nav = load('navigation/items.ts');
  assert.ok(!nav.navigationGroups.flatMap(g => g.items).some(i => /correction/i.test(i.label) && i.state === 'AVAILABLE_NATIVE'), 'no standalone Corrections destination');
});
test('15. a committed result replaces the Timesheet and confirms success; the panel closes', async () => {
  const h = screen(); await h.open(); h.click('Correct time');
  const fresh = sheet({ totals: { ...zero, workedMs: 8 * H, hasOpenShift: false } });
  h.panel().props.onCommitted(fresh, false); h.render();
  assert.equal(h.panel(), undefined); assert.match(h.text(), /Correction saved/); assert.match(h.text(), /8h 00m worked/);
  assert.equal(h.calls.filter(c => c.kind === 'sheet').length, 1, 'no optimistic or extra read — the server result is used');
});
test('36-38. Lock, business change and PIN identity change remove the panel (and its draft) immediately', async () => {
  for (const change of [c => { c.identity = null; }, c => { c.business = { id: 'business-b', name: 'Other', role: 'owner' }; }, c => { c.identity = { employee: { id: 'other' }, expiresAt: 'y' }; }, c => { c.managementRole = 'staff'; }]) {
    const h = screen(); await h.open(); h.click('Correct time'); assert.ok(h.panel());
    change(h.context); h.render();
    assert.equal(h.panel(), undefined); assert.equal(h.button('Correct time'), undefined);
  }
});
test('41-43. corrected entries are labelled in text; ordinary entries stay uncluttered', async () => {
  const base = sheet();
  base.events = [{ ...base.events[0], corrected: true, correctionRevision: 2 },
    { id: 'out', shiftId: 'in1', seq: 2, type: 'CLOCK_OUT', breakType: null, occurredAt: '2026-03-04T01:00:00Z', origin: 'inserted', corrected: false, correctionRevision: 3 },
    { id: 'in2', shiftId: 'in2', seq: 3, type: 'CLOCK_IN', breakType: null, occurredAt: '2026-03-04T02:00:00Z', origin: 'original', corrected: false, correctionRevision: null }];
  base.days[1].shifts.push({ ...base.days[1].shifts[0], id: 'in2', clockInAt: '2026-03-04T02:00:00Z' });
  const h = screen({}, base); await h.open();
  const badges = h.nodes().filter(n => n.type === 'Badge').map(n => n.props.label);
  assert.deepEqual(badges.filter(l => /correct/i.test(l)), ['Corrected', 'Added by correction'], 'exactly the corrected two');
  assert.doesNotMatch(h.text(), /delet/i);
});
