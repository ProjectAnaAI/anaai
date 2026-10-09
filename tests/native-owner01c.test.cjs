const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function harness({ accountRole = 'owner', pinRole = 'owner', mode = 'employee', development = true } = {}) {
  const state = { calls: [], current: { mode, credential: 'secret-device', session: 'secret-session' }, wrongBusiness: false, expired: false, rejected: false, changed: false };
  const cache = {};
  class ZudeApiError extends Error {}
  function load(file) {
    if (cache[file]) return cache[file];
    const exports = {};
    cache[file] = exports;
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
      exports, URL, Date, __DEV__: development,
      process: { env: { EXPO_PUBLIC_SUPABASE_URL: 'https://nfmlptigzaqadpyzfnqa.supabase.co' } },
      require(name) {
        if (name === './api') return { ZudeApiError, async apiGet(path, options) {
          state.calls.push({ path, options });
          return { success: true, business: { id: 'business-a', name: 'Synthetic salon', role: accountRole } };
        } };
        if (name === './employee-identity-api') return { async identityRequest(path, device, body) {
          state.calls.push({ path, device, body });
          if (state.rejected) throw new ZudeApiError('Rejected');
          if (state.changed) state.current = { mode: 'locked' };
          return { success: true, employee: { id: 'private-employee-id', name: 'private-employee-name', businessId: state.wrongBusiness ? 'business-b' : 'business-a', role: pinRole },
            expiresAt: state.expired ? '2000-01-01T00:00:00Z' : '2099-01-01T00:00:00Z',
            permissions: pinRole === 'owner' ? ['team:manage-managers'] : pinRole === 'manager' ? ['team:manage-employees'] : [] };
        } };
        if (name === './operational-identity') return {
          ...load('apps/zude-mobile/src/lib/operational-identity.ts'), operationalIdentity: () => state.current,
        };
        throw new Error('Unexpected dependency: ' + name);
      },
    });
    return exports;
  }
  return { state, check: () => load('apps/zude-mobile/src/lib/authority-diagnostic.ts').checkAuthority('business-a', 'account-a', mode !== 'account') };
}

for (const [accountRole, pinRole, expected] of [
  ['owner', 'owner', 'owner'], ['owner', 'manager', 'manager'], ['manager', 'owner', 'manager'], ['owner', 'employee', 'staff'],
]) test(`diagnostic: ${accountRole} account + ${pinRole} PIN = ${expected}`, async () => {
  const h = harness({ accountRole, pinRole });
  const result = await h.check();
  assert.equal(result.accountRole, accountRole);
  assert.equal(result.pinRole, pinRole);
  assert.equal(result.pinStatus, 'Verified');
  assert.equal(result.effectiveRole, expected);
  assert.equal(result.project, 'nfmlptigzaqadpyzfnqa');
  assert.equal(h.state.calls[0].options.expectedUserId, 'account-a');
  assert.deepEqual(h.state.calls.map(c => c.path), ['/api/current-business', '/api/employee-session/validate']);
  for (const value of ['secret-device', 'secret-session', 'private-employee-id', 'private-employee-name', 'business-a', 'account-a']) {
    assert.equal(JSON.stringify(result).includes(value), false);
  }
});
test('missing PIN is explicitly locked, never inherited account authority', async () => {
  const h = harness({ mode: 'locked' });
  const result = await h.check();
  assert.equal(result.pinStatus, 'Missing — shared device locked');
  assert.equal(result.effectiveRole, 'Locked');
  assert.equal(h.state.calls.length, 1);
});
test('account mode identifies missing PIN separately', async () => {
  const h = harness({ mode: 'account' });
  assert.equal((await h.check()).pinStatus, 'Missing — account mode');
});
for (const flag of ['wrongBusiness', 'expired', 'rejected', 'changed']) test(`diagnostic refuses ${flag} PIN session`, async () => {
  const h = harness(); h.state[flag] = true;
  await assert.rejects(h.check());
});
test('production diagnostic refuses before requests', async () => {
  const h = harness({ development: false });
  await assert.rejects(h.check(), /unavailable/);
  assert.equal(h.state.calls.length, 0);
});
test('diagnostic UI is development-only and clears on background/identity change', () => {
  const screen = fs.readFileSync('apps/zude-mobile/src/features/identity/DeviceIdentityScreen.tsx', 'utf8');
  assert.match(screen, /__DEV__ && <AuthorityDiagnostic \/>/);
  const ui = fs.readFileSync('apps/zude-mobile/src/features/identity/AuthorityDiagnostic.tsx', 'utf8');
  assert.match(ui, /AppState.addEventListener\("change"/);
  assert.match(ui, /generation === request.current.generation/);
  assert.match(ui, /\[business.id, userId, identity, device, sharedMode, vault\]/);
  assert.doesNotMatch(ui, /console\.|AsyncStorage|SecureStore|JSON.stringify/);
});

function panelHarness() {
  const states = [], effects = [];
  let cursor = 0, ec = 0, background, complete;
  const context = { identity: {}, device: {}, sharedMode: true, vault: 'ready' };
  const react = {
    useState(initial) { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], v => { states[i] = v; }]; },
    useRef(initial) { const i = cursor++; if (!(i in states)) states[i] = { current: initial }; return states[i]; },
    useMemo(fn, deps) { const i = cursor++; if (!states[i] || deps.some((d, j) => d !== states[i].deps[j])) states[i] = { value: fn(), deps }; return states[i].value; },
    useEffect(fn, deps) { const i = ec++, old = effects[i]; if (!old || deps.some((d, j) => d !== old.deps[j])) effects[i] = { fn, deps, cleanup: old?.cleanup, pending: true }; },
  };
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('apps/zude-mobile/src/features/identity/AuthorityDiagnostic.tsx', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require(name) {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
    if (name === 'react-native') return { Text: 'Text', View: 'View', AppState: { addEventListener(_, fn) { background = fn; return { remove() {} }; } } };
    if (name === '../../components/ui') return { Button: 'Button', styles: {} };
    if (name === '../../lib/authority-diagnostic') return { checkAuthority: () => new Promise(r => { complete = r; }) };
    if (name === '../business/BusinessContext') return { useBusiness: () => ({ business: { id: 'business-a' }, userId: 'account-a' }) };
    if (name === './EmployeeIdentityContext') return { useEmployeeIdentity: () => context };
    throw new Error(name);
  } });
  let tree;
  return {
    context,
    render() { cursor = 0; ec = 0; tree = exports.AuthorityDiagnostic(); for (const e of effects) if (e.pending) { e.cleanup?.(); e.cleanup = e.fn(); e.pending = false; } return JSON.stringify(tree); },
    check() { tree.props.children.find(n => n?.type === 'Button').props.onPress(); },
    finish() { complete({ business: 'Synthetic salon', accountRole: 'owner', pinRole: 'manager', pinStatus: 'Verified', effectiveRole: 'manager', project: 'synthetic-project' }); },
    background() { background('background'); },
  };
}
const flush = () => new Promise(r => setImmediate(r));
test('panel removes verified authority immediately when identity changes or app backgrounds', async () => {
  const h = panelHarness(); h.render(); h.check(); h.finish(); await flush();
  assert.match(h.render(), /Synthetic salon/);
  h.background(); assert.doesNotMatch(h.render(), /Synthetic salon/);
  h.check(); h.finish(); await flush(); assert.match(h.render(), /Synthetic salon/);
  h.context.identity = null; assert.doesNotMatch(h.render(), /Synthetic salon/);
});
for (const event of ['background', 'identity']) test(`panel discards response arriving after ${event} change`, async () => {
  const h = panelHarness(); h.render(); h.check();
  if (event === 'background') h.background(); else { h.context.identity = null; h.render(); }
  h.finish(); await flush(); assert.doesNotMatch(h.render(), /Synthetic salon/);
});
