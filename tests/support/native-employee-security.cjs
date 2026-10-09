const { load } = require('./native-management.cjs');
function controlledClock() {
  let now = Date.parse('2026-10-08T16:00:00Z'), id = 0;
  const timers = new Map(), history = new Map();
  class ClockDate extends Date { constructor(value) { super(value === undefined ? now : value); } static now() { return now; } }
  const clock = {
    Date: ClockDate, now: () => now, timers, history,
    schedule(fn, delay) { const key = ++id; timers.set(key, { fn, at: now + delay }); history.set(key, fn); return key; },
    cancel(key) { timers.delete(key); },
    advance(ms, run = true) {
      const target = now + ms;
      if (run) for (;;) {
        const next = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = Math.max(now, next[1].at); timers.delete(next[0]); next[1].fn();
      }
      now = target;
    },
  };
  return clock;
}
function identityHarness({ shared = true, platform = 'ios', role = 'employee', lockFailure = false, delayPin = false, sessionLifetimeMs = 3600000 } = {}) {
  const clock = controlledClock(), requests = [], states = [], effects = [], layouts = [], listeners = new Set(), web = new Map();
  let cursor = 0, ec = 0, lc = 0, context, boundary, mounted = true, signedOut = 0, issued = 0, finishPin;
  const business = { id: 'b', name: 'Om Beauty Salon', timezone: 'America/Los_Angeles', role: 'owner' };
  const device = shared ? { businessId: 'b', credential: 'synthetic-device' } : null;
  const serverTime = { A: { state: 'WORKING', breaks: [], events: ['CLOCK_IN'] }, B: { state: 'ON_PAID_BREAK', breaks: ['open-paid-break'], events: ['CLOCK_IN', 'START_PAID_BREAK'] } };
  let employee = 'A';
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    createContext: () => ({ Provider: 'Provider' }), useContext: () => context,
    useState(initial) { const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; },
    useRef(initial) { const i = cursor++; return states[i] ?? (states[i] = { current: initial }); },
    useEffect(fn, deps) { const i = ec++, old = effects[i]; if (!old || !same(deps, old.deps)) effects[i] = { fn, deps, pending: true, cleanup: old?.cleanup }; },
    useLayoutEffect(fn, deps) { const i = lc++, old = layouts[i]; if (!old || !same(deps, old.deps)) layouts[i] = { fn, deps, pending: true, cleanup: old?.cleanup }; },
  };
  react.useCallback = (fn, deps) => { const memo = react.useRef(null); if (!memo.current || deps.some((v, i) => !Object.is(v, memo.current.deps[i]))) memo.current = { fn, deps }; return memo.current.fn; };
  const jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
  const native = { View: 'View', Text: 'Text', ScrollView: 'ScrollView', Platform: { OS: platform }, AppState: { currentState: 'active', addEventListener(_, fn) { listeners.add(fn); return { remove: () => listeners.delete(fn) }; } } };
  class ApiError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
  const operational = load('lib/operational-identity.ts', { './api': { ZudeApiError: ApiError } });
  const globals = { Date: clock.Date, setTimeout: clock.schedule, clearTimeout: clock.cancel,
    window: { addEventListener(name, fn) { web.set(name, fn); }, removeEventListener(name, fn) { if (web.get(name) === fn) web.delete(name); } } };
  const imports = {
    react, 'react/jsx-runtime': jsx, 'react-native': native,
    '../business/BusinessContext': { useBusiness: () => ({ business, userId: 'account' }) },
    '../../lib/api': { ZudeApiError: ApiError },
    '../../lib/account-proof': { currentAccountProof: () => null, accountRecentlyProven: () => false, onAccountProofChange: () => () => {} },
    '../../lib/account-session': { signOutAccount: async () => { signedOut++; } },
    '../../lib/operational-identity': operational,
    './EmployeeActivityContext': { EmployeeActivityContext: { Provider: 'ActivityProvider' } },
    './employee-inactivity': load('features/identity/employee-inactivity.ts', {}, globals),
    './device-vault': { readDevice: async () => device, readSharedMode: async () => shared, saveDevice: async () => {}, markSharedMode: async () => {}, clearSharedMode: async () => {}, forgetDevice: async () => {} },
    '../../lib/employee-identity-api': { registerDevice: async () => {}, deviceCredentialRejected: () => false, isDeviceRejectionCode: code => code === 'DEVICE_REVOKED',
      identityRequest: async (path, d, body) => {
        requests.push({ path, body });
        if (path === '/api/device/pin') {
          const result = { success: true, session: `session-${++issued}`, employee: { id: employee, name: `Employee ${employee}`, businessId: 'b', role }, permissions: role === 'manager' ? ['team:manage-employees'] : [], expiresAt: new clock.Date(clock.now() + sessionLifetimeMs).toISOString() };
          return delayPin ? new Promise(resolve => { finishPin = () => resolve(result); }) : result;
        }
        if (path === '/api/employee-session/lock') { if (lockFailure) throw Error('offline'); return { success: true }; }
        throw Error('Unexpected mutation: ' + path);
      },
    },
  };
  const provider = load('features/identity/EmployeeIdentityContext.tsx', imports, globals);
  const gates = load('features/identity/DeviceIdentityScreen.tsx', {
    './AuthorityDiagnostic': { AuthorityDiagnostic: 'AuthorityDiagnostic' },
    react, 'react/jsx-runtime': jsx, 'react-native': native, './EmployeeIdentityContext': provider,
    '../../components/ui': { Button: 'Button', styles: {} }, '../../components/workspace': { Field: 'Field', WorkspaceHeader: 'Header', workspaceStyles: {} }, '../../theme/tokens': load('theme/tokens.ts'),
  }, { __DEV__: false });
  function flushEffects(list) { for (const e of list) if (e.pending) e.cleanup?.(); for (const e of list) if (e.pending) { e.pending = false; e.cleanup = e.fn(); } }
  const h = {
    clock, requests, business, serverTime, operational, web, listeners,
    get context() { return context; }, get boundary() { return boundary; }, get signedOut() { return signedOut; },
    render() { cursor = ec = lc = 0; const node = provider.EmployeeIdentityProvider({ children: 'WORKSPACE' }); context = node.props.value; boundary = node.props.children.props.children; flushEffects(layouts); flushEffects(effects); return h; },
    gate() { return gates.EmployeeIdentityGate({ children: 'WORKSPACE' }); },
    async ready() { h.render(); await new Promise(r => setImmediate(r)); return h.render(); },
    async unlock(name = 'A') { employee = name; context.setPin('1234'); h.render(); const promise = context.unlock(); if (delayPin) return { promise }; await promise; return h.render(); },
    finishPin() { finishPin(); },
    rejectSession(session) { operational.reportIdentityRejection(new ApiError(401, 'IDENTITY_UNAUTHORIZED'), { credential: 'synthetic-device', session }); },
    lifecycle(state) { native.AppState.currentState = state; for (const fn of [...listeners]) fn(state); h.render(); },
    unmount() { if (!mounted) return; mounted = false; for (const e of effects) e.cleanup?.(); for (const e of layouts) e.cleanup?.(); },
  };
  return h;
}
module.exports = { controlledClock, identityHarness };
