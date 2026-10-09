// Native M05 Time Clock + My Time: device-authenticated API wrapper,
// presentation rules, navigation, and the rendered screens.
const { test } = require('node:test');
const strict = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const assert = Object.assign((...a) => strict(...a), strict, { deepEqual: (a, b, m) => strict.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), m) });
const root = 'apps/zude-mobile/src/';
function load(file, imports = {}, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(root + file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { exports, URL, URLSearchParams, AbortController, JSON, Intl, Date, ...globals, require(name) { if (Object.hasOwn(imports, name)) return imports[name]; throw Error('Unexpected import ' + name); } });
  return exports;
}
const B = 'business-a';
const KEY = '7d1c3f0e-1111-4111-8111-111111111111';
const view = (over = {}) => ({ success: true, businessId: B, timezone: 'America/New_York', serverNow: '2026-09-30T16:00:00.000Z', employee: { id: 'e1', name: 'Avery Employee', role: 'employee' },
  state: 'OFF_CLOCK', shift: null, today: { date: '2026-09-30', workedMs: 0, paidBreakMs: 0, mealBreakMs: 0 }, ...over });

// ---- API wrapper ------------------------------------------------------------------------
function transport(respond, identity = { mode: 'employee', credential: 'DEVICE-CREDENTIAL', session: 'EMPLOYEE-SESSION' }) {
  const calls = [];
  const api = load('lib/api.ts', { './supabase': { supabase: { auth: { async getSession() { throw Error('account session must not be used'); } } } } }, {
    __DEV__: false, process: { env: { EXPO_PUBLIC_ZUDE_API_URL: 'https://zude.invalid' } },
    async fetch(url, init) { const u = new URL(url); calls.push({ url: u, init, body: init.body ? JSON.parse(init.body) : undefined }); const { status = 200, body } = respond(u, init); return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); },
  });
  const operational = load('lib/operational-identity.ts', { './api': api });
  operational.publishOperationalIdentity(B, identity);
  const rejections = []; operational.onOperationalRejection(r => rejections.push(r));
  const time = load('lib/time-clock-api.ts', { './api': api, './operational-identity': operational }, { fetch: (...a) => api.__fetch(...a) });
  return { calls, rejections, time, api, operational };
}
// time-clock-api calls the global fetch; route it through the recording one.
function wired(respond, identity) {
  const calls = [];
  const h = transport(respond, identity);
  const time = load('lib/time-clock-api.ts', { './api': h.api, './operational-identity': h.operational }, {
    async fetch(url, init) { const u = new URL(url); calls.push({ url: u, init, body: init.body ? JSON.parse(init.body) : undefined }); const { status = 200, body } = respond(u, init); return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); },
  });
  return { ...h, calls, time };
}
test('time requests carry ONLY the device credential + employee session; no account token, business or employee ID', async () => {
  const h = wired(() => ({ body: view() }));
  await h.time.getTimeClock(B);
  await h.time.recordTimeAction(B, 'break-start', KEY, 'MEAL');
  await h.time.recordTimeAction(B, 'clock-out', KEY);
  const [get, start, out] = h.calls;
  assert.equal(get.url.pathname, '/api/time-clock'); assert.equal(get.url.search, ''); assert.equal(get.init.method, 'GET');
  for (const c of h.calls) {
    assert.equal(c.init.headers.Authorization, 'ZudeDevice DEVICE-CREDENTIAL'); assert.equal(c.init.headers['x-zude-employee-session'], 'EMPLOYEE-SESSION');
    assert.equal(c.init.headers['x-anaai-business-id'], undefined); assert.equal(c.init.headers['x-zude-device'], undefined);
  }
  assert.equal(start.url.pathname, '/api/time-clock/break-start'); assert.deepEqual(start.body, { breakType: 'MEAL' }); assert.equal(start.init.headers['Idempotency-Key'], KEY);
  assert.equal(out.url.pathname, '/api/time-clock/clock-out'); assert.deepEqual(out.body, {}, 'no timestamp, duration or identity in the body');
});
test('account mode and a locked shared device send nothing', async () => {
  for (const identity of [{ mode: 'account' }, { mode: 'locked' }]) {
    const h = wired(() => ({ body: view() }), identity);
    await assert.rejects(h.time.recordTimeAction(B, 'clock-in', KEY), e => e.code === 'IDENTITY_REQUIRED');
    await assert.rejects(h.time.getMyTime(B), e => e.code === 'IDENTITY_REQUIRED');
    assert.equal(h.calls.length, 0);
  }
  const other = wired(() => ({ body: view() }));
  await assert.rejects(other.time.getTimeClock('business-b'), e => e.code === 'IDENTITY_REQUIRED', 'another business is locked');
});
test('only coded 401 identity failures reach M04 recovery; time-clock errors do not', async () => {
  for (const [status, code, reported] of [[401, 'DEVICE_REVOKED', true], [401, 'DEVICE_INVALID', true], [401, 'IDENTITY_UNAUTHORIZED', true],
    [409, 'TIME_INVALID_TRANSITION', false], [503, 'TIME_UNAVAILABLE', false], [503, 'DEVICE_REVOKED', false], [401, undefined, false], [400, 'INVALID_REQUEST', false]]) {
    const h = wired(() => ({ status, body: { success: false, ...(code ? { code } : {}), error: 'private-provider-detail' } }));
    await assert.rejects(h.time.recordTimeAction(B, 'clock-in', KEY), e => e.code === (code ?? 'REQUEST_FAILED') && !e.message.includes('private'));
    assert.equal(h.rejections.length, reported ? 1 : 0, `${status} ${code}`);
    if (reported) assert.deepEqual(h.rejections[0], { code, credential: 'DEVICE-CREDENTIAL', session: 'EMPLOYEE-SESSION' });
  }
});
test('responses for another business or malformed totals are refused', async () => {
  for (const body of [view({ businessId: 'business-b' }), view({ state: 'ON_LUNCH' }), view({ today: { workedMs: -1, paidBreakMs: 0, mealBreakMs: 0 } })]) {
    await assert.rejects(wired(() => ({ body })).time.getTimeClock(B), e => e.code === 'INVALID_RESPONSE');
  }
  const net = wired(() => { throw Error('offline'); });
  await assert.rejects(net.time.recordTimeAction(B, 'clock-in', KEY), e => e.code === 'NETWORK_ERROR' && e.status === 0);
});

// ---- Presentation rules ---------------------------------------------------------------------
class ApiError extends Error { constructor(status, code) { super('private-provider-detail'); this.status = status; this.code = code; } }
const state = load('features/time/state.ts', { '../../lib/api': { ZudeApiError: ApiError } });
test('break options say Paid Break 10 minutes / paid and Meal Break 30 minutes / unpaid', () => {
  assert.deepEqual(state.BREAK_OPTIONS, [{ type: 'PAID', label: 'Paid Break', minutes: 10, detail: 'Paid time continues' }, { type: 'MEAL', label: 'Meal Break', minutes: 30, detail: 'Unpaid' }]);
  assert.deepEqual(['OFF_CLOCK', 'WORKING', 'ON_PAID_BREAK', 'ON_MEAL_BREAK'].map(s => state.actionsFor(s)),
    [['clock-in'], ['break-start', 'clock-out'], ['break-end', 'clock-out'], ['break-end', 'clock-out']]);
  assert.equal(state.formatDuration(7.5 * 3600_000), '7h 30m'); assert.equal(state.formatDuration(45 * 60_000), '45m'); assert.equal(state.formatDuration(-5), '0m');
  assert.equal(state.formatTime('2026-09-30T13:05:00Z', 'America/New_York'), '9:05 AM');
  assert.equal(state.formatDay('2026-09-28'), 'Mon, Sep 28');
  assert.equal(state.overIntended(14 * 60_000, 10), 4 * 60_000);
});
test('request keys are reused only to retry the same action after an unknown outcome', () => {
  let n = 0; const fresh = () => 'k' + ++n;
  const first = state.requestKeyFor(null, 'clock-in:', fresh);
  assert.equal(state.requestKeyFor(first, 'clock-in:', fresh).key, first.key);
  assert.notEqual(state.requestKeyFor(first, 'break-start:PAID', fresh).key, first.key);
  assert.equal(state.outcomeUnknown(new ApiError(0, 'NETWORK_ERROR')), true); assert.equal(state.outcomeUnknown(new ApiError(503, 'TIME_UNAVAILABLE')), true);
  assert.equal(state.outcomeUnknown(new ApiError(409, 'TIME_INVALID_TRANSITION')), false); assert.equal(state.outcomeUnknown(new ApiError(401, 'IDENTITY_UNAUTHORIZED')), false);
  assert.ok(!state.timeMessage(new ApiError(503, 'X')).includes('private'));
});

// ---- Navigation --------------------------------------------------------------------------
test('Time Clock and My Time are real routes for every role, including an employee PIN with no permissions', () => {
  const nav = load('navigation/items.ts');
  assert.equal(nav.activeNavigationLabel('/time-clock'), 'Time Clock'); assert.equal(nav.activeNavigationLabel('/my-time'), 'My Time');
  for (const [role, perms] of [['staff', null], ['manager', null], ['owner', null], ['owner', []], ['owner', ['team:manage-employees', 'devices:manage']]]) {
    const items = nav.visibleNavigation(role, perms).flatMap(g => g.items);
    assert.equal(items.find(i => i.label === 'Time Clock')?.route, '/time-clock', `${role}`); assert.equal(items.find(i => i.label === 'My Time')?.route, '/my-time');
  }
  assert.match(fs.readFileSync(root + 'app/time-clock.tsx', 'utf8'), /TimeClockScreen as default/);
  assert.match(fs.readFileSync(root + 'app/my-time.tsx', 'utf8'), /MyTimeScreen as default/);
});

// ---- Rendered screens --------------------------------------------------------------------
function screen(file, name, { data, error, sharedMode = true, identity = { employee: { id: 'e1', name: 'Avery Employee' }, expiresAt: 'x' }, fail, pending = false, admission } = {}) {
  const states = [], effects = [], calls = [], timers = [], locks = [];
  let cursor = 0, ec = 0, refreshes = 0, resourceKey, release, replaced, uuids = 0;
  const react = {
    useState(initial) { const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], v => { states[i] = typeof v === 'function' ? v(states[i]) : v; }]; },
    useRef(initial) { const i = cursor++; if (!(i in states)) states[i] = { current: initial }; return states[i]; },
    useLayoutEffect(fn, deps) { const i = ec++, old = effects[i]; if (!old || deps.some((v, j) => v !== old.deps[j])) effects[i] = { fn, deps, pending: true, cleanup: old?.cleanup }; },
    useEffect(fn, deps) { const i = ec++, old = effects[i]; if (!old || deps.some((v, j) => v !== old.deps[j])) effects[i] = { fn, deps, pending: true, cleanup: old?.cleanup }; },
  };
  const api = {
    getTimeClock: async () => data, getMyTime: async () => data,
    async recordTimeAction(...args) { calls.push(['recordTimeAction', ...args]); if (pending) await new Promise(r => { release = r; }); if (fail) { const f = fail; fail = null; throw f; } return view({ state: args[1] === 'clock-out' ? 'OFF_CLOCK' : 'WORKING' }); },
    async reportTimeIssue(...args) { calls.push(['reportTimeIssue', ...args]); if (fail) { const f = fail; fail = null; throw f; } return { id: 'i1' }; },
  };
  const jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'Fragment' };
  const Screen = load(file, {
    react, 'react/jsx-runtime': jsx, 'expo-crypto': { randomUUID: () => 'uuid-' + ++uuids },
    'react-native': { Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', View: 'View', StyleSheet: { create: s => s } },
    '../../components/ui': { Badge: 'Badge', Button: 'Button', styles: {} },
    '../../components/workspace': { Feedback: 'Feedback', Field: 'Field', PaneTitle: 'PaneTitle', SplitWorkspace: 'SplitWorkspace', WorkspaceHeader: 'WorkspaceHeader', workspaceStyles: {} },
    '../../lib/time-clock-api': api, '../../theme/tokens': load('theme/tokens.ts'),
    '../business/BusinessContext': { useBusiness: () => ({ business: { id: B, name: 'Business', role: 'owner' }, userId: 'account' }) },
    '../identity/EmployeeIdentityContext': { useEmployeeIdentity: () => ({ sharedMode, identity, lock: async (notice) => { locks.push(notice); } }) },
    '../appointments/controls': { Notice: 'Notice' },
    './ShiftAccessContext': { useShiftAccess: () => admission ?? ({ managed: false }) },
    './state': state,
    './useTimeResource': { useTimeResource(key, loader) { resourceKey = key; if (key) void loader(new AbortController().signal); return { data: key ? (replaced ?? data) : undefined, error: key ? error : undefined, loading: false, fetchedAt: Date.now(), refresh() { refreshes++; }, replace(v) { replaced = v; } }; } },
  }, { setInterval: (fn, ms) => { timers.push(ms); return timers.length; }, clearInterval() {} });
  function nodes(n) {
    if (!n || typeof n !== 'object') return [];
    if (Array.isArray(n)) return n.flatMap(nodes);
    if (typeof n.type === 'function') return nodes(n.type(n.props));
    return [n, ...['children', 'main', 'rail', 'action'].flatMap(k => nodes(n.props?.[k]))];
  }
  let tree;
  const h = {
    calls, timers, locks, get refreshes() { return refreshes; }, get resourceKey() { return resourceKey; },
    render() { cursor = 0; ec = 0; tree = Screen[name](); for (const e of effects) if (e.pending) { e.cleanup?.(); e.cleanup = e.fn(); e.pending = false; } return tree; },
    all() { return nodes(tree); },
    button(label) { return h.all().find(n => (n.type === 'Button' && n.props.label === label) || (n.type === 'Pressable' && n.props.accessibilityLabel?.startsWith(label + ','))); },
    labels() { return h.all().filter(n => n.type === 'Button').map(n => n.props.label); },
    click(label) { h.render(); const n = h.button(label); assert.ok(n, 'Button ' + label); assert.ok(!n.props.disabled, 'Enabled ' + label); n.props.onPress(); h.render(); },
    // Rendered text: each Text's children joined as React would display them.
    text() { return h.all().map(n => n.type === 'Text' ? [].concat(n.props.children).filter(v => typeof v === 'string' || typeof v === 'number').join('') : JSON.stringify(n.props)).join('\n'); },
    release() { release?.(); },
    replaceIdentity(next) { identity = next; h.render(); },
    unmount() { for (const effect of effects) effect.cleanup?.(); },
  };
  h.render();
  return h;
}
const flush = () => new Promise(r => setImmediate(r));
const working = view({ state: 'WORKING', shift: { id: 's1', clockInAt: '2026-09-30T13:00:00Z', elapsedMs: 3 * 3600_000, workedMs: 3 * 3600_000, paidBreakMs: 0, mealBreakMs: 0, break: null }, today: { date: '2026-09-30', workedMs: 3 * 3600_000, paidBreakMs: 0, mealBreakMs: 0 } });
const TC = ['features/time/TimeClockScreen.tsx', 'TimeClockScreen'];

test('Time Clock shows Clock In when off the clock and Start Break / Clock Out when working', () => {
  const off = screen(...TC, { data: view() });
  assert.ok(off.button('Clock In')); assert.equal(off.button('Clock Out'), undefined); assert.match(off.text(), /does not clock you in/);
  assert.match(off.text(), /Avery Employee/); assert.match(off.text(), /Off the clock/);
  const on = screen(...TC, { data: working });
  assert.ok(on.button('Start Break')); assert.ok(on.button('Clock Out')); assert.equal(on.button('Clock In'), undefined);
  assert.match(on.text(), /9:00 AM/); assert.match(on.text(), /3h 00m/);
  assert.equal(off.timers.length, 0, 'no running display off the clock'); assert.deepEqual(on.timers, [10000]);
});
test('Start Break opens a deliberate choice and starts nothing until one is picked', async () => {
  const h = screen(...TC, { data: working });
  h.click('Start Break'); assert.equal(h.calls.length, 0, 'opening the chooser sends nothing');
  const paid = h.button('Paid Break'), meal = h.button('Meal Break');
  assert.equal(paid.props.accessibilityLabel, 'Paid Break, 10 minutes, Paid time continues');
  assert.equal(meal.props.accessibilityLabel, 'Meal Break, 30 minutes, Unpaid');
  assert.match(h.text(), /10 minutes · Paid time continues/); assert.match(h.text(), /30 minutes · Unpaid/);
  h.click('Cancel'); assert.equal(h.button('Paid Break'), undefined); assert.equal(h.calls.length, 0);
  h.click('Start Break'); h.click('Meal Break'); await flush();
  assert.deepEqual(h.calls[0], ['recordTimeAction', B, 'break-start', 'uuid-1', 'MEAL']);
});
test('on a break: End Break and Clock Out; clock-out confirms and says the break ends too', async () => {
  const onBreak = view({ state: 'ON_MEAL_BREAK', shift: { ...working.shift, break: { type: 'MEAL', intendedMinutes: 30, startedAt: '2026-09-30T16:00:00Z', endedAt: null, open: true, durationMs: 35 * 60_000 } } });
  const h = screen(...TC, { data: onBreak });
  assert.ok(h.button('End Break')); assert.ok(h.button('Clock Out')); assert.equal(h.button('Start Break'), undefined);
  assert.match(h.text(), /Meal Break · 30 minutes intended/); assert.match(h.text(), /5m over the intended 30 minutes/); assert.match(h.text(), /unpaid/);
  h.click('Clock Out'); assert.equal(h.calls.length, 0); assert.match(h.text(), /This also ends your Meal Break/);
  h.click('Yes, Clock Out'); await flush();
  assert.deepEqual(h.calls[0].slice(0, 3), ['recordTimeAction', B, 'clock-out']);
});
test('duplicate taps send one request while a time action is pending', async () => {
  const h = screen(...TC, { data: view(), pending: true });
  const clockIn = h.button('Clock In'); clockIn.props.onPress(); clockIn.props.onPress(); h.render();
  assert.equal(h.calls.length, 1); assert.equal(h.button('Clock In').props.disabled || h.button('Clock In').props.busy, true);
  h.release(); await flush();
});
test('an unknown outcome is retried with the SAME key; a known rejection gets a fresh one', async () => {
  const h = screen(...TC, { data: view(), fail: new ApiError(0, 'NETWORK_ERROR') });
  h.click('Clock In'); await flush(); h.render();
  assert.match(h.text(), /not confirmed/); assert.equal(h.refreshes, 1, 'refreshes authoritative state after a failure');
  h.click('Clock In'); await flush();
  assert.equal(h.calls[0][3], h.calls[1][3], 'same request key for the retry');
  const r = screen(...TC, { data: view(), fail: new ApiError(409, 'TIME_INVALID_TRANSITION') });
  r.click('Clock In'); await flush(); r.render(); r.click('Clock In'); await flush();
  assert.notEqual(r.calls[0][3], r.calls[1][3]); assert.match(screen(...TC, { data: view(), error: new ApiError(409, 'TIME_INVALID_TRANSITION') }).text(), /status changed/);
});
test('account mode explains PIN use and never loads time; loading and error states are real', () => {
  const account = screen(...TC, { data: view(), sharedMode: false });
  assert.equal(account.resourceKey, null); assert.equal(account.button('Clock In'), undefined); assert.match(account.text(), /never clocks time/);
  const loading = screen(...TC, { data: undefined });
  assert.ok(loading.all().some(n => n.type === 'Feedback' && n.props.kind === 'loading'));
  const failed = screen(...TC, { data: undefined, error: new ApiError(503, 'TIME_UNAVAILABLE') });
  assert.ok(failed.all().some(n => n.type === 'Feedback' && n.props.kind === 'error' && n.props.retry));
});

const MT = ['features/time/MyTimeScreen.tsx', 'MyTimeScreen'];
const week = (over = {}) => ({ ...view(), week: { startDate: '2026-09-28', endDate: '2026-10-04', today: '2026-09-30', startsAt: 'a', endsAt: 'b', workedMs: 0, paidBreakMs: 0, mealBreakMs: 0 },
  days: ['2026-09-28', '2026-09-29', '2026-09-30'].map(date => ({ date, startsAt: 'a', endsAt: 'b', workedMs: 0, paidBreakMs: 0, mealBreakMs: 0, shifts: [] })), issues: [], ...over });
test('My Time: This Week only, no week navigation, no employee picker, truthful empty week', () => {
  const h = screen(...MT, { data: week() });
  assert.match(h.text(), /This Week/); assert.match(h.text(), /Mon, Sep 28 – Sun, Oct 4/); assert.match(h.text(), /No time recorded this week yet/);
  const labels = h.labels();
  for (const banned of ['Previous Week', 'Next Week', 'Previous', 'Next', 'Choose Employee']) assert.ok(!labels.includes(banned));
  assert.ok(!h.all().some(n => n.type === 'Button' && n.props.icon && /chevron/.test(n.props.icon)), 'no week arrows');
  const source = fs.readFileSync(root + 'features/time/MyTimeScreen.tsx', 'utf8') + fs.readFileSync(root + 'lib/time-clock-api.ts', 'utf8');
  assert.doesNotMatch(source, /employeeId|weekStart=|\?week|\?date/);
});
test('My Time shows shifts, open state, paid and meal breaks from the server', () => {
  const shift = { id: 's1', clockInAt: '2026-09-30T13:00:00Z', clockOutAt: null, open: true, continuesFromPreviousDay: false, continuesNextDay: false, workedMs: 7.5 * 3600_000, paidBreakMs: 600_000, mealBreakMs: 1_800_000,
    breaks: [{ type: 'PAID', intendedMinutes: 10, startedAt: '2026-09-30T14:00:00Z', endedAt: '2026-09-30T14:10:00Z', open: false, durationMs: 600_000 }, { type: 'MEAL', intendedMinutes: 30, startedAt: '2026-09-30T16:00:00Z', endedAt: '2026-09-30T16:30:00Z', open: false, durationMs: 1_800_000 }] };
  const data = week({ state: 'WORKING', week: { ...week().week, workedMs: 7.5 * 3600_000, paidBreakMs: 600_000, mealBreakMs: 1_800_000 } });
  data.days[2] = { ...data.days[2], workedMs: 7.5 * 3600_000, shifts: [shift] };
  const h = screen(...MT, { data });
  const text = h.text();
  for (const expected of [/7h 30m/, /9:00 AM – In progress/, /Paid Break \(paid\)/, /Meal Break \(unpaid\)/, /shift is in progress/, /Today/, /No time recorded/]) assert.match(text, expected);
  assert.doesNotMatch(text, /\$|wage|rate/i, 'no pay amounts');
});
test('Report a time issue sends only a note and day, never edits time', async () => {
  const h = screen(...MT, { data: week() });
  h.click('Report a time issue');
  h.click('Tue, Sep 29');
  h.render(); h.all().find(n => n.type === 'Field').props.onChangeText('Forgot to clock out'); h.render();
  h.click('Send Report'); await flush(); h.render();
  assert.deepEqual(h.calls[0], ['reportTimeIssue', B, 'uuid-1', { note: 'Forgot to clock out', workDate: '2026-09-29' }]);
  assert.match(h.text(), /Your time records were not changed/); assert.equal(h.refreshes, 1);
});
test('identity code never touches the time clock: PIN unlock, Lock, background and expiry cannot clock in or out', () => {
  for (const file of ['features/identity/EmployeeIdentityContext.tsx', 'features/identity/DeviceIdentityScreen.tsx', 'lib/employee-identity-api.ts', 'lib/account-session.ts']) {
    // Comments describe clock-out callers; only executable identity code is constrained.
    const code = ts.transpileModule(fs.readFileSync(root + file, 'utf8'), { compilerOptions: { removeComments: true } }).outputText;
    assert.doesNotMatch(code, /time-clock|recordTimeAction|clock-out|clock-in/i, file);
  }
});
test('11-13. Clock Out still needs confirmation; a server-confirmed OFF_CLOCK ends only the PIN session', async () => {
  const h = screen(...TC, { data: working });
  h.click('Clock Out'); assert.equal(h.calls.length, 0, 'confirmation required'); assert.equal(h.locks.length, 0);
  h.click('Stay Clocked In'); assert.equal(h.calls.length, 0);
  h.click('Clock Out'); h.click('Yes, Clock Out'); await flush();
  assert.equal(h.calls.length, 1); assert.deepEqual(h.locks, ['You are clocked out. Enter your PIN to continue.']);
  const failed = screen(...TC, { data: working, fail: new ApiError(0, 'NETWORK_ERROR') });
  failed.click('Clock Out'); failed.click('Yes, Clock Out'); await flush();
  assert.equal(failed.locks.length, 0, 'an unconfirmed clock-out keeps the employee here to retry');
  const brk = screen(...TC, { data: working });
  brk.click('Start Break'); brk.click('Paid Break'); await flush();
  assert.equal(brk.locks.length, 0, 'other actions never lock');
  const source = fs.readFileSync(root + 'features/time/TimeClockScreen.tsx', 'utf8');
  assert.doesNotMatch(source, /forget|signOut|leaveSharedMode/, 'never forgets the device or signs the account out');
});

for (const [status, action, message] of [
  ['OFF_CLOCK', 'clock-in', 'Clock in to continue.'],
  ['ON_PAID_BREAK', 'break-end', 'End your paid break to continue.'],
  ['ON_MEAL_BREAK', 'break-end', 'End your meal break to continue.'],
]) test(`managed Time Clock reuses ${action}, shows mandatory guidance, and shares its sole server view`, async () => {
  const completions = [], ticket = { scope: 'current', owner: {} };
  const data = view({ state: status, shift: status === 'OFF_CLOCK' ? null : { ...working.shift, break: { type: status === 'ON_PAID_BREAK' ? 'PAID' : 'MEAL', startedAt: '2026-09-30T13:00:00Z', durationMs: 1000, intendedMinutes: 15 } } });
  const access = { managed: true, allowed: false, data, loading: false, fetchedAt: Date.now(), requiredAction: action,
    beginAction() { return ticket; }, finishAction(...args) { completions.push(args); }, refresh() {} };
  const h = screen(...TC, { data, admission: access });
  assert.equal(h.resourceKey, null, 'no second Time Clock GET/cache'); assert.match(h.text(), new RegExp(message.replace('.', '\\.')));
  assert.equal(h.calls.length, 0, 'rendering/PIN admission writes nothing');
  const label = action === 'clock-in' ? 'Clock In' : 'End Break';
  const press = h.button(label).props.onPress; press(); press(); h.render(); await flush(); h.render();
  assert.equal(h.calls.length, 1, 'repeated presses do not create another action');
  assert.equal(completions.length, 1); assert.equal(completions[0][0], ticket); assert.equal(completions[0][1], action);
  assert.equal(completions[0][2].state, 'WORKING');
  assert.equal(access.allowed, false, 'screen cannot grant admission from a mutation response');
});
test('managed action failure stays on Time Clock with the existing error and no admission grant', async () => {
  const finishes = [], ticket = { scope: 'current', owner: {} }, data = view();
  const access = { managed: true, allowed: false, data, loading: false, fetchedAt: Date.now(), requiredAction: 'clock-in', beginAction: () => ticket, finishAction(...a) { finishes.push(a); }, refresh() {} };
  const h = screen(...TC, { data, admission: access, fail: new ApiError(503, 'TIME_UNAVAILABLE') });
  h.click('Clock In'); await flush(); h.render();
  assert.equal(finishes.length, 1); assert.equal(finishes[0][2], undefined); assert.equal(access.allowed, false);
  assert.ok(h.all().some(n => n.type === 'Notice' && n.props.error)); assert.ok(h.button('Clock In'));
});
test('old Clock Out response cannot lock a newly switched employee', async () => {
  const h = screen(...TC, { data: working, pending: true });
  h.click('Clock Out'); h.click('Yes, Clock Out');
  h.replaceIdentity({ employee: { id: 'employee-b', name: 'Employee B' }, expiresAt: 'new-session' });
  h.release(); await flush(); h.render();
  assert.equal(h.locks.length, 0); assert.equal(h.calls.length, 1);
});
test('an unmounted clock action cannot lock a replacement workspace', async () => {
  const h = screen(...TC, { data: working, pending: true }); h.click('Clock Out'); h.click('Yes, Clock Out');
  h.unmount(); h.release(); await flush(); assert.equal(h.locks.length, 0);
});
