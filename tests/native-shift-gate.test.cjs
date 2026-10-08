// Native M05 post-PIN routing: the ShiftGate decision from authoritative
// time-clock state, and the Clock-In Landing.
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
    { exports, URL, AbortController, JSON, Intl, Date, ...globals, require(name) { if (Object.hasOwn(imports, name)) return imports[name]; throw Error('Unexpected import ' + name); } });
  return exports;
}
class ApiError extends Error { constructor(status, code) { super('private-provider-detail'); this.status = status; this.code = code; } }
const B = 'business-a';
const state = load('features/time/state.ts', { '../../lib/api': { ZudeApiError: ApiError } });
const view = (s, over = {}) => ({ success: true, businessId: B, timezone: 'America/New_York', serverNow: '2026-10-01T13:00:00.000Z', employee: { id: 'e1', name: 'Avery Employee', role: 'employee' },
  state: s, shift: s === 'OFF_CLOCK' ? null : { id: 's', clockInAt: '2026-09-30T23:00:00Z', elapsedMs: 1, workedMs: 1, paidBreakMs: 0, mealBreakMs: 0, break: null }, today: { date: '2026-10-01', workedMs: 0, paidBreakMs: 0, mealBreakMs: 0 }, ...over });
const flush = () => new Promise(r => setImmediate(r));
function hooks() {
  const states = [], effects = [];
  let cursor = 0, ec = 0;
  return {
    react: {
      useState(initial) { const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], v => { states[i] = typeof v === 'function' ? v(states[i]) : v; }]; },
      useRef(initial) { const i = cursor++; if (!(i in states)) states[i] = { current: initial }; return states[i]; },
      useEffect(fn, deps) { const i = ec++, old = effects[i]; if (!old || deps.some((v, j) => v !== old.deps[j])) effects[i] = { fn, deps, pending: true, cleanup: old?.cleanup }; },
    },
    run(render) { cursor = 0; ec = 0; const tree = render(); for (const e of effects) if (e.pending) { e.cleanup?.(); e.cleanup = e.fn(); e.pending = false; } return tree; },
  };
}
const jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'Fragment' };
function nodes(n) { if (!n || typeof n !== 'object') return []; if (Array.isArray(n)) return n.flatMap(nodes); return [n, ...['children'].flatMap(k => nodes(n.props?.[k]))]; }

// ---- ShiftGate ----------------------------------------------------------------------------
function gate({ responses, sharedMode = true, role = 'employee' } = {}) {
  const h = hooks(), routes = [], fetches = [], locks = [], actions = [];
  let identity = { employee: { id: 'e1', name: 'Avery Employee', role }, expiresAt: 'session-1' };
  const queue = [...responses];
  const api = {
    async getTimeClock(business) { fetches.push(business); const next = queue.length > 1 ? queue.shift() : queue[0]; if (next instanceof Error) throw next; return next; },
    async recordTimeAction(...a) { actions.push(a); throw Error('the gate never records time'); },
  };
  const Gate = load('features/time/ShiftGate.tsx', {
    react: h.react, 'react/jsx-runtime': jsx, 'react-native': { StyleSheet: { create: s => s }, View: 'View' },
    'expo-router': { router: { replace: (r) => routes.push(r) } },
    '../../components/ui': { Button: 'Button' }, '../../components/workspace': { Feedback: 'Feedback' },
    '../../lib/api': { ZudeApiError: ApiError }, '../../lib/time-clock-api': api, '../../theme/tokens': load('theme/tokens.ts'),
    '../business/BusinessContext': { useBusiness: () => ({ business: { id: B, name: 'Business', role: 'owner' } }) },
    '../identity/EmployeeIdentityContext': { useEmployeeIdentity: () => ({ sharedMode, identity, managementRole: identity.employee.role === 'employee' ? 'staff' : identity.employee.role, lock: async () => { locks.push(1); } }) },
    '../../navigation/items': load('navigation/items.ts'), './state': state,
  });
  let tree;
  const g = {
    routes, fetches, locks, actions,
    render() { tree = h.run(() => Gate.ShiftGate({ children: 'WORKSPACE' })); return tree; },
    async settle() { for (let i = 0; i < 4; i++) { await flush(); g.render(); } },
    get tree() { return tree; },
    workspace() { return tree === 'WORKSPACE'; },
    landing() { return nodes(tree).find(n => n.type === 'ClockInLanding'); },
    feedback() { return nodes(tree).find(n => n.type === 'Feedback'); },
    // A new PIN session (Lock + PIN, expiry + PIN, or another employee).
    newSession(next = {}) { identity = { employee: { id: next.id ?? 'e1', name: 'Avery Employee', role: next.role ?? role }, expiresAt: next.expiresAt ?? 'session-' + Math.random() }; },
    respond(...next) { queue.splice(0, queue.length, ...next); },
  };
  return g;
}
async function opened(options) { const g = gate(options); g.render(); await g.settle(); return g; }

for (const role of ['employee', 'manager', 'owner']) {
  for (const status of ['OFF_CLOCK', 'WORKING', 'ON_PAID_BREAK', 'ON_MEAL_BREAK']) {
    test(`${role} PIN lands at its role destination with ${status} unchanged`, async () => {
      const authoritative = view(status);
      const before = JSON.stringify(authoritative);
      const g = gate({ role, responses: [authoritative] });
      g.render(); assert.equal(g.workspace(), false);
      await g.settle();
      const route = role === 'employee' ? '/appointments-today' : '/';
      assert.equal(g.workspace(), true); assert.deepEqual(g.routes, [route]);
      g.render(); await g.settle(); assert.deepEqual(g.routes, [route]);
      g.newSession(); g.render(); assert.equal(g.workspace(), false);
      await g.settle(); assert.deepEqual(g.routes, [route, route]);
      assert.equal(g.fetches.length, 2); assert.equal(g.actions.length, 0);
      assert.equal(JSON.stringify(authoritative), before);
    });
  }
}
test('Switch User changes the role landing and cannot reuse the previous admission', async () => {
  const g = await opened({ role: 'manager', responses: [view('WORKING')] });
  g.newSession({ id: 'employee-b', role: 'employee' }); g.render();
  assert.equal(g.workspace(), false); await g.settle();
  assert.deepEqual(g.routes, ['/', '/appointments-today']); assert.equal(g.actions.length, 0);
});
test('a delayed old PIN-session read cannot replace the new employee landing', async () => {
  let release;
  const oldRead = new Promise(resolve => { release = resolve; });
  const g = gate({ role: 'manager', responses: [oldRead, view('ON_MEAL_BREAK')] });
  g.render();
  g.newSession({ id: 'new-employee', role: 'employee' }); g.render(); await g.settle();
  assert.deepEqual(g.routes, ['/appointments-today']);
  release(view('WORKING')); await g.settle();
  assert.deepEqual(g.routes, ['/appointments-today']); assert.equal(g.workspace(), true);
  assert.equal(g.actions.length, 0);
});
test('17. a state-fetch failure shows an error with Retry and never falls through to Today', async () => {
  for (const error of [new ApiError(0, 'NETWORK_ERROR'), new ApiError(503, 'TIME_UNAVAILABLE'), new ApiError(0, 'INVALID_RESPONSE'), new ApiError(401, 'DEVICE_REVOKED')]) {
    const g = await opened({ responses: [error] });
    assert.equal(g.workspace(), false); assert.deepEqual(g.routes, []);
    assert.equal(g.feedback().props.kind, 'error'); assert.ok(!JSON.stringify(g.tree).includes('private-provider-detail'));
    g.respond(view('WORKING')); g.feedback().props.retry(); g.render();
    assert.equal(g.feedback().props.kind, 'loading'); await g.settle();
    assert.equal(g.workspace(), true, 'retry re-decides from the server');
  }
  const g = await opened({ responses: [new ApiError(0, 'NETWORK_ERROR')] });
  nodes(g.tree).find(n => n.type === 'Button' && n.props.label === 'Lock').props.onPress();
  assert.equal(g.locks.length, 1, 'the employee can always lock from the gate');
});
test('account mode (no shared device) is unchanged: workspace, no time request', async () => {
  const g = await opened({ sharedMode: false, responses: [view('OFF_CLOCK')] });
  assert.equal(g.workspace(), true); assert.equal(g.fetches.length, 0); assert.deepEqual(g.routes, []);
});
test('the gate is mounted between PIN identity and the workspace', () => {
  assert.match(fs.readFileSync(root + 'features/auth/AuthGate.tsx', 'utf8'), /<EmployeeIdentityGate><ShiftGate><AppShell \/><\/ShiftGate><\/EmployeeIdentityGate>/);
});

// ---- Clock-In Landing ----------------------------------------------------------------------
const week = (over = {}) => ({ ...view('OFF_CLOCK'), week: { startDate: '2026-09-28', endDate: '2026-10-04', today: '2026-10-01', startsAt: 'a', endsAt: 'b', workedMs: 5.5 * 3600_000, paidBreakMs: 600_000, mealBreakMs: 1_800_000 },
  days: [{ date: '2026-09-28', workedMs: 5.5 * 3600_000, paidBreakMs: 0, mealBreakMs: 0, shifts: [{ id: 's' }] }, { date: '2026-09-29', workedMs: 0, paidBreakMs: 0, mealBreakMs: 0, shifts: [] }, { date: '2026-10-01', workedMs: 0, paidBreakMs: 0, mealBreakMs: 0, shifts: [] }],
  issues: [], ...over });
function landing({ summary = week(), summaryError, fail = [], pending = false, result = 'WORKING' } = {}) {
  const h = hooks(), calls = [], decisions = [], refreshes = [], locks = [], myTime = [];
  let uuids = 0, release;
  const failures = [...fail];
  const api = {
    getMyTime: async (...a) => { myTime.push(a); return summary; },
    async recordTimeAction(...a) { calls.push(a); if (pending) await new Promise(r => { release = r; }); const f = failures.shift(); if (f) throw f; return view(result); },
  };
  const Landing = load('features/time/ClockInLanding.tsx', {
    react: h.react, 'react/jsx-runtime': jsx, 'expo-crypto': { randomUUID: () => 'uuid-' + ++uuids },
    'react-native': { ScrollView: 'ScrollView', StyleSheet: { create: s => s }, Text: 'Text', View: 'View', useWindowDimensions: () => ({ width: 1366, height: 1024, fontScale: 1 }) },
    '../../components/ui': { Badge: 'Badge', Button: 'Button', styles: {} },
    '../../components/operations': { Action: 'Action' },
    '../../components/workspace': { Brand: 'Brand', Feedback: 'Feedback', PaneTitle: 'PaneTitle' },
    '../../lib/api': { ZudeApiError: ApiError }, '../../lib/time-clock-api': api,
    '../../theme/tokens': load('theme/tokens.ts'), '../../theme/layout': { workspaceLayout: () => ({ split: true }) },
    '../business/BusinessContext': { useBusiness: () => ({ business: { id: B, name: 'Business', role: 'owner' } }) },
    '../appointments/controls': { Notice: 'Notice' }, './state': state,
    './useTimeResource': { useTimeResource(key, loader) { void loader(new AbortController().signal); return { data: summaryError ? undefined : summary, error: summaryError, loading: false, fetchedAt: Date.now(), refresh() {}, replace() {} }; } },
  }, { setInterval: () => 1, clearInterval() {} });
  let tree;
  const l = {
    calls, decisions, refreshes, locks, myTime,
    render() { tree = h.run(() => Landing.ClockInLanding({ view: view('OFF_CLOCK'), onDecision: v => decisions.push(v), onRefresh: () => refreshes.push(1), onLock: () => locks.push(1) })); return tree; },
    all() { return nodes(tree); },
    buttons() { return l.all().filter(n => n.type === 'Button').map(n => n.props.label); },
    button(label) { return l.all().find(n => n.type === 'Button' && n.props.label === label); },
    text() { return l.all().map(n => n.type === 'Text' ? [].concat(n.props.children).filter(v => typeof v === 'string' || typeof v === 'number').join('') : '').join('\n'); },
    release() { release?.(); },
  };
  l.render();
  return l;
}
test('landing shows identity, Not clocked in, Clock In, and the real current week only', () => {
  const l = landing();
  assert.match(l.text(), /Avery Employee/); assert.ok(l.all().some(n => n.type === 'Badge' && n.props.label === 'Not clocked in'));
  const expected = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric' }).format(new Date());
  assert.ok(l.text().includes(expected), 'current date in the business timezone: ' + expected);
  assert.match(l.text(), /5h 30m/); assert.match(l.text(), /Monday, Sep 28/); assert.match(l.text(), /Thursday, Oct 1 · Today/);
  assert.equal(l.myTime.length, 1); assert.equal(l.myTime[0][0], B); assert.ok(l.myTime[0][1] instanceof AbortSignal || typeof l.myTime[0][1].aborted === 'boolean', 'only business + abort signal: no employee or week selector');
});
test('20. landing has no week navigation, team, editing, job or workspace controls', () => {
  const l = landing();
  assert.deepEqual(l.buttons(), ['Clock In', 'Lock']);
  assert.ok(!l.all().some(n => n.type === 'Field'), 'nothing editable');
  assert.doesNotMatch(fs.readFileSync(root + 'features/time/ClockInLanding.tsx', 'utf8'), /router|employeeId|Previous|Next Week|job/i);
});
test('3. Clock In hands the server result to the gate; WORKING is never assumed', async () => {
  const l = landing(); l.button('Clock In').props.onPress(); await flush();
  assert.deepEqual(l.calls, [[B, 'clock-in', 'uuid-1']]); assert.equal(l.decisions[0].state, 'WORKING');
});
test('3b. the landing passes the server state through unchanged (it never manufactures WORKING)', async () => {
  for (const result of ['OFF_CLOCK', 'ON_PAID_BREAK', 'WORKING']) {
    const l = landing({ result }); l.button('Clock In').props.onPress(); await flush();
    assert.equal(l.decisions[0].state, result);
  }
});
test('4. duplicate Clock In taps send one request', async () => {
  const l = landing({ pending: true });
  const button = l.button('Clock In'); button.props.onPress(); button.props.onPress(); l.render();
  assert.equal(l.calls.length, 1); assert.equal(l.button('Clock In').props.disabled, true);
  l.release(); await flush();
});
test('5. an uncertain Clock In is retried with the same key; a known rejection reconciles from the server', async () => {
  const l = landing({ fail: [new ApiError(0, 'NETWORK_ERROR')] });
  l.button('Clock In').props.onPress(); await flush(); l.render();
  assert.match(l.text() + JSON.stringify(l.all().filter(n => n.type === 'Notice').map(n => n.props)), /not confirmed/);
  assert.ok(l.button('Check Status')); assert.equal(l.decisions.length, 0, 'not admitted on an unknown outcome');
  l.button('Clock In').props.onPress(); await flush();
  assert.equal(l.calls[0][2], l.calls[1][2], 'same idempotency key'); assert.equal(l.decisions.length, 1);
  const r = landing({ fail: [new ApiError(409, 'TIME_INVALID_TRANSITION')] });
  r.button('Clock In').props.onPress(); await flush(); r.render();
  assert.equal(r.refreshes.length, 1, 'state changed elsewhere: re-decide from the server');
  r.button('Clock In').props.onPress(); await flush();
  assert.notEqual(r.calls[0][2], r.calls[1][2], 'a known rejection gets a fresh key');
});
test('landing week errors are visible and do not block Clock In; Lock leaves without clocking in', async () => {
  const l = landing({ summaryError: new ApiError(503, 'TIME_UNAVAILABLE') });
  assert.ok(l.all().some(n => n.type === 'Feedback' && n.props.kind === 'error' && n.props.retry));
  assert.equal(l.button('Clock In').props.disabled, false);
  l.button('Lock').props.onPress(); assert.equal(l.locks.length, 1); assert.equal(l.calls.length, 0);
});

// ---- 18. M04 recovery through the post-PIN state fetch --------------------------------------
test('18. a DEVICE_REVOKED / DEVICE_INVALID answer to the post-PIN fetch runs M04 recovery; time errors do not', async () => {
  for (const [status, code, reported] of [[401, 'DEVICE_REVOKED', true], [401, 'DEVICE_INVALID', true], [401, 'IDENTITY_UNAUTHORIZED', true], [409, 'TIME_INVALID_TRANSITION', false], [503, 'TIME_UNAVAILABLE', false]]) {
    const api = load('lib/api.ts', { './supabase': { supabase: {} } }, { __DEV__: false, process: { env: { EXPO_PUBLIC_ZUDE_API_URL: 'https://zude.invalid' } } });
    const operational = load('lib/operational-identity.ts', { './api': api });
    operational.publishOperationalIdentity(B, { mode: 'employee', credential: 'DEVICE', session: 'SESSION' });
    const rejections = []; operational.onOperationalRejection(r => rejections.push(r));
    const time = load('lib/time-clock-api.ts', { './api': api, './operational-identity': operational }, { fetch: async () => new Response(JSON.stringify({ success: false, code }), { status }) });
    await assert.rejects(time.getTimeClock(B), e => e.code === code);
    assert.equal(rejections.length, reported ? 1 : 0, code);
  }
});

test('identity-required errors keep the gate closed and show only safe guidance', async () => {
  const g = await opened({ responses: [new ApiError(401, 'IDENTITY_REQUIRED')] });
  assert.equal(g.workspace(), false);
  assert.equal(g.feedback().props.detail, state.timeMessage(new ApiError(401, 'IDENTITY_REQUIRED')));
  assert.doesNotMatch(JSON.stringify(g.tree), /IDENTITY_REQUIRED|HTTP status|Diagnostic code|private-provider-detail/);
});
