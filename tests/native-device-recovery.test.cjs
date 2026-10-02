// M04 native device-credential recovery. Real device vault, identity API
// module and identity context/screen over mocked SecureStore and fetch.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const root = 'apps/zude-mobile/src/';
const CREDENTIAL = '11111111-1111-4111-8111-111111111111.' + 'S'.repeat(43);
const SESSION = '22222222-2222-4222-8222-222222222222.' + 'T'.repeat(43);
const KEY = 'zude.registered-device.v1';
// Like the server, every registration issues a new random credential.
let issued = 0;
const freshCredential = () => `33333333-3333-4333-8333-${String(++issued).padStart(12, '0')}.` + 'R'.repeat(43);
class ApiError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
function compile(file, imports, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(root + file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { exports, JSON, Date, ...globals, require(name) { if (Object.hasOwn(imports, name)) return typeof imports[name] === 'function' && imports[name].lazy ? imports[name]() : imports[name]; throw Error('Unexpected import ' + name); } });
  return exports;
}
// SecureStore double. `fail` selects which operations throw; `stuck` makes a
// delete appear to succeed while the value remains.
function secureStore({ raw = null, fail = {}, stuck = false, marker = false } = {}) {
  const store = new Map(raw === null ? [] : [[KEY, raw]]), calls = [];
  if (marker) store.set('zude.shared-device.v1', '1');
  return { store, calls, fail, module: {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 42,
    async getItemAsync(key) { calls.push(['get', key]); if (fail.get > 0) { fail.get--; throw Error('keychain-private'); } return store.get(key) ?? null; },
    async setItemAsync(key, value, options) { calls.push(['set', key, options]); if (fail.set) throw Error('keychain-private'); store.set(key, value); },
    async deleteItemAsync(key) { calls.push(['delete', key]); if (fail.delete) throw Error('keychain-private'); if (!stuck) store.delete(key); },
  } };
}
function vaultModule(platform, secure) { return compile('features/identity/device-vault.ts', { 'react-native': { Platform: { OS: platform } }, 'expo-secure-store': secure.module }); }
function apiModule(fetch) { return compile('lib/employee-identity-api.ts', { './api': { ZudeApiError: ApiError, apiUrl: p => 'https://zude.test' + p, apiWrite: async () => ({ success: true, credential: freshCredential(), device: { id: 'd', business_id: 'business' } }) } }, { fetch }); }

// Full harness: stored device + configurable PIN/lock responses.
function harness({ platform = 'ios', stored = { businessId: 'business', credential: CREDENTIAL }, raw, fail, stuck, role = 'owner', business = 'business', proven = true, permissions = [], marker = false, pinResponse, lockResponse } = {}) {
  const secure = secureStore({ raw: raw !== undefined ? raw : stored ? JSON.stringify(stored) : null, fail, stuck, marker });
  const requests = [], logs = [];
  let resolvePin = null, pinNext = pinResponse || (() => ({ status: 201, body: { success: true, session: SESSION, expiresAt: new Date(Date.now() + 3600000).toISOString(), employee: { id: 'e', businessId: business, name: 'Employee', role: 'employee' }, permissions } }));
  const fetch = async (url, options) => {
    const path = new URL(url).pathname, body = JSON.parse(options.body);
    requests.push({ path, body, authorization: options.headers.Authorization });
    const respond = path === '/api/device/pin' ? pinNext : lockResponse || (() => ({ status: 200, body: { success: true } }));
    const result = await respond(body);
    if (result === 'network') throw Error('socket hang up private-provider-body');
    return { ok: result.status < 400, status: result.status, json: async () => result.body };
  };
  const api = apiModule(fetch), vault = vaultModule(platform, secure);
  const states = [], effects = [];
  let cursor = 0, ec = 0, background, context;
  const react = {
    createContext: () => ({ Provider: 'Provider' }), useContext: () => context,
    useState(initial) { const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], v => { states[i] = typeof v === 'function' ? v(states[i]) : v; }]; },
    useRef(initial) { const i = cursor++; if (!(i in states)) states[i] = { current: initial }; return states[i]; },
    useEffect(fn, deps) { const i = ec++, old = effects[i]; if (!old || deps.some((v, j) => v !== old.deps[j])) effects[i] = { fn, deps, pending: true, cleanup: old?.cleanup }; },
  };
  const jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
  const console = { log: (...a) => logs.push(a), warn: (...a) => logs.push(a), error: (...a) => logs.push(a), info: (...a) => logs.push(a) };
  const contextExports = {};
  const shared = { react, 'react/jsx-runtime': jsx, 'react-native': { AppState: { addEventListener(_, fn) { background = fn; return { remove() {} }; } }, Platform: { OS: platform }, ScrollView: 'ScrollView', Text: 'Text', View: 'View' } };
  const proofModule = compile('lib/account-proof.ts', {}, { Date });
  if (proven) proofModule.recordAccountSignIn('account');
  const operational = compile('lib/operational-identity.ts', { './api': { ZudeApiError: ApiError } });
  let signedOut = 0;
  const contextImports = { ...shared, '../../lib/account-proof': proofModule, '../../lib/account-session': { signOutAccount: async () => { signedOut++; proofModule.clearAccountProof(); } }, '../../lib/operational-identity': operational, '../business/BusinessContext': { useBusiness: () => ({ business: { id: business, name: 'Business', role }, userId: 'account' }) }, '../../lib/employee-identity-api': api, '../../lib/api': { ZudeApiError: ApiError }, './device-vault': vault };
  const screenImports = { ...shared, '../../components/ui': { Button: 'Button', styles: {} }, '../../components/workspace': { Field: 'Field', WorkspaceHeader: 'Header', workspaceStyles: {} }, '../../theme/tokens': { theme: { space: { xl: 24, lg: 16, sm: 8 } } }, './EmployeeIdentityContext': contextExports };
  Object.assign(contextExports, compile('features/identity/EmployeeIdentityContext.tsx', contextImports, { setTimeout: () => 1, clearTimeout() {}, console }));
  const screen = compile('features/identity/DeviceIdentityScreen.tsx', screenImports, { console });
  function nodes(n) { if (!n || typeof n !== 'object') return []; if (Array.isArray(n)) return n.flatMap(nodes); return [n, ...nodes(n.props?.children)]; }
  let tree, gate;
  const h = {
    secure, requests, logs, vault, api, proofModule, operational, get signedOut() { return signedOut; },
    get context() { return context; }, get gate() { return gate; },
    render() {
      cursor = 0; ec = 0;
      context = contextExports.EmployeeIdentityProvider({ children: null }).props.value;
      tree = screen.DeviceIdentityScreen(); gate = screen.EmployeeIdentityGate({ children: 'WORKSPACE' });
      for (const e of effects) if (e.pending) { e.cleanup?.(); e.cleanup = e.fn(); e.pending = false; }
      return tree;
    },
    async settle() { for (let i = 0; i < 6; i++) { await flush(); h.render(); } },
    button(label) { return nodes(tree).find(n => n.type === 'Button' && n.props.label === label); },
    click(label) { const n = h.button(label); assert.ok(n, 'Button ' + label); assert.ok(!n.props.disabled, 'Enabled ' + label); n.props.onPress(); h.render(); },
    async enterPin(digits = '1234') { for (const d of digits) h.click(d); h.click('Unlock'); await h.settle(); },
    async forget() { h.click('Forget This Device'); h.click('Yes, Forget This Device'); await h.settle(); },
    text() { return JSON.stringify(tree); },
    background() { background('background'); },
    pinLater() { pinNext = () => new Promise(r => { resolvePin = r; }); },
    finishPin(result) { resolvePin(result); },
    stored() { return h.secure.store.get(KEY) ?? null; },
  };
  return h;
}
const flush = () => new Promise(r => setImmediate(r));
async function opened(options) { const h = harness(options); h.render(); await h.settle(); return h; }

// ---- 1-3: vault ----------------------------------------------------------------------
test('1. native vault deletes the credential from SecureStore and verifies it is gone', async () => {
  const secure = secureStore(); const vault = vaultModule('ios', secure);
  await vault.saveDevice({ businessId: 'business', credential: CREDENTIAL }); assert.ok(secure.store.has(KEY));
  await vault.forgetDevice();
  assert.equal(secure.store.has(KEY), false); assert.equal(await vault.readDevice(), null);
  assert.ok(secure.calls.some(c => c[0] === 'delete' && c[1] === KEY));
  const deleteIndex = secure.calls.findIndex(c => c[0] === 'delete'); assert.equal(secure.calls[deleteIndex + 1][0], 'get', 'deletion is verified by a read-back');
});
test('2. web preview forget clears only the volatile in-memory credential', async () => {
  const secure = secureStore(); const vault = vaultModule('web', secure);
  await vault.saveDevice({ businessId: 'business', credential: CREDENTIAL }); assert.equal((await vault.readDevice()).businessId, 'business');
  await vault.forgetDevice(); assert.equal(await vault.readDevice(), null); assert.equal(secure.calls.length, 0);
});
test('3a. secure deletion failure fails closed at the vault', async () => {
  const raw = JSON.stringify({ businessId: 'b', credential: CREDENTIAL });
  const cases = [secureStore({ raw, fail: { delete: true } }), secureStore({ raw, stuck: true }), secureStore({ raw })];
  // Third case: the delete resolves but the verifying read-back throws.
  cases[2].module.getItemAsync = async () => { throw Error('keychain-private'); };
  for (const secure of cases) await assert.rejects(vaultModule('ios', secure).forgetDevice(), e => e.name === 'DeviceVaultError' && !e.message.includes('keychain-private'));
});
test('3b. deletion failure keeps the device registered and never claims it was forgotten', async () => {
  const h = await opened({ fail: { delete: true } });
  assert.ok(h.button('Unlock'), 'PIN screen'); await h.forget();
  assert.ok(h.stored(), 'credential remains'); assert.ok(h.context.device, 'device still registered in state');
  assert.match(h.context.message, /was not forgotten/); assert.doesNotMatch(h.context.message, /was forgotten on this iPad/);
  assert.notEqual(h.gate, 'WORKSPACE', 'still gated'); assert.ok(h.button('Forget This Device'), 'retry is available');
});

// ---- 4-9: authoritative rejection vs. everything else ---------------------------------
for (const code of ['DEVICE_REVOKED', 'DEVICE_INVALID']) test(`4/5. ${code} clears the local credential and returns to registration`, async () => {
  const h = await opened({ pinResponse: () => ({ status: 401, body: { success: false, code, error: 'private-provider-body' } }) });
  await h.enterPin();
  assert.equal(h.stored(), null); assert.equal(h.context.device, null);
  assert.ok(h.text().includes('Register this shared ZUDE device')); assert.match(h.context.message, /no longer valid/);
  assert.ok(!h.text().includes('private-provider-body'));
});
test('4b. DEVICE_REVOKED during Lock also clears the credential', async () => {
  const h = await opened({ lockResponse: () => ({ status: 401, body: { success: false, code: 'DEVICE_REVOKED' } }) });
  await h.enterPin(); assert.ok(h.context.identity);
  h.click('Lock'); await h.settle();
  assert.equal(h.stored(), null); assert.equal(h.context.identity, null); assert.ok(h.text().includes('Register this shared ZUDE device'));
});
const kept = [
  ['6. wrong PIN', () => ({ status: 401, body: { success: false, code: 'PIN_INVALID' } }), /Unable to unlock with that PIN/],
  ['7. PIN lockout', () => ({ status: 429, body: { success: false, code: 'PIN_LOCKED' } }), /temporarily locked/],
  ['7b. PIN busy', () => ({ status: 429, body: { success: false, code: 'PIN_RETRY' } }), /busy/],
  ['8. network failure', () => 'network', /Unable to reach ZUDE/],
  ['9a. 500', () => ({ status: 500, body: { success: false } }), /unavailable/],
  ['9b. 503', () => ({ status: 503, body: { success: false, code: 'SERVICE_UNAVAILABLE' } }), /unavailable/],
  ['9c. 503 carrying a device code', () => ({ status: 503, body: { success: false, code: 'DEVICE_REVOKED' } }), /no longer valid|unavailable/],
  ['9d. session/identity 401', () => ({ status: 401, body: { success: false, code: 'IDENTITY_UNAUTHORIZED' } }), /session ended/],
  ['9e. 401 without a code', () => ({ status: 401, body: { success: false } }), /session ended/],
];
for (const [name, response, message] of kept) test(`${name} does NOT clear the device credential`, async () => {
  const h = await opened({ pinResponse: response });
  const before = h.stored(); await h.enterPin();
  assert.equal(h.stored(), before); assert.ok(h.context.device); assert.ok(h.button('Unlock'), 'still on PIN entry');
  assert.ok(!h.secure.calls.some(c => c[0] === 'delete')); assert.match(h.context.message, message);
  assert.ok(!h.context.message.includes('private-provider-body'));
});
test('server codes are preserved; device rejection needs an explicit 401 code', async () => {
  const api = apiModule(async () => ({ ok: false, status: 401, json: async () => ({ success: false, code: 'DEVICE_REVOKED' }) }));
  await assert.rejects(api.identityRequest('/api/device/pin', { businessId: 'b', credential: CREDENTIAL }, { pin: '1234' }), e => e.code === 'DEVICE_REVOKED' && e.status === 401 && api.deviceCredentialRejected(e));
  assert.equal(api.deviceCredentialRejected(new ApiError(503, 'DEVICE_REVOKED', 'x')), false);
  assert.equal(api.deviceCredentialRejected(new ApiError(401, 'PIN_INVALID', 'x')), false);
  assert.equal(api.deviceCredentialRejected(new ApiError(401, 'IDENTITY_UNAUTHORIZED', 'x')), false);
  assert.equal(api.deviceCredentialRejected(new Error('DEVICE_REVOKED')), false);
  const junk = apiModule(async () => ({ ok: false, status: 401, json: async () => ({ success: false, code: 'device revoked; drop table' }) }));
  await assert.rejects(junk.identityRequest('/api/device/pin', { businessId: 'b', credential: CREDENTIAL }, { pin: '1234' }), e => e.code === 'IDENTITY_UNAUTHORIZED');
});

// ---- 10-13: wrong business and manual forget -----------------------------------------
test('10. wrong-business device exposes a recovery path instead of PIN entry', async () => {
  const h = await opened({ stored: { businessId: 'business-a', credential: CREDENTIAL }, business: 'business-b' });
  assert.notEqual(h.gate, 'WORKSPACE'); assert.ok(h.text().includes('Registered to another ZUDE workspace'));
  assert.equal(h.button('Unlock'), undefined, 'not trapped behind PIN'); assert.ok(h.button('Forget This Device'));
  await h.forget();
  assert.equal(h.stored(), null); assert.ok(h.text().includes('Register this shared ZUDE device'));
  assert.ok(!h.requests.some(r => r.path === '/api/device/pin'), 'never authenticates against the other business');
});
test('10b. staff accounts see wrong-business guidance but cannot forget', async () => {
  const h = await opened({ stored: { businessId: 'business-a', credential: CREDENTIAL }, business: 'business-b', role: 'staff' });
  assert.ok(h.text().includes('Registered to another ZUDE workspace')); assert.equal(h.button('Forget This Device'), undefined);
});
test('11. forget clears the active employee identity and ends its session', async () => {
  const h = await opened(); await h.enterPin(); assert.ok(h.context.identity);
  await h.forget();
  assert.equal(h.context.identity, null); assert.equal(h.stored(), null);
  const lock = h.requests.find(r => r.path === '/api/employee-session/lock'); assert.ok(lock, 'best-effort session revoke'); assert.equal(lock.body.session, SESSION);
});
test('11b. forget still completes when the session revoke cannot reach the server', async () => {
  const h = await opened({ lockResponse: () => 'network' }); await h.enterPin(); await h.forget();
  assert.equal(h.context.identity, null); assert.equal(h.stored(), null); assert.ok(h.text().includes('Register this shared ZUDE device'));
});
test('12. forget returns to registration and never re-opens the account workspace', async () => {
  const h = await opened(); await h.forget();
  assert.ok(h.text().includes('Register this shared ZUDE device')); assert.ok(h.button('Register device'));
  assert.notEqual(h.gate, 'WORKSPACE', 'a forgotten shared device stays gated');
  assert.equal(h.button('Continue Without Registering'), undefined, 'no bypass into the account workspace');
  assert.ok(h.secure.store.has('zude.shared-device.v1'), 'shared-device marker persists');
});
test('12b. re-registration after forget stores a new credential and re-gates PIN', async () => {
  const h = await opened(); await h.forget();
  h.context.setName('Front desk'); h.render(); h.click('Register device'); await h.settle();
  assert.ok(h.stored()); assert.ok(h.button('Unlock')); assert.notEqual(h.gate, 'WORKSPACE');
});
test('13. forget does not claim or attempt server revocation', async () => {
  const h = await opened(); h.click('Forget This Device');
  assert.match(h.text(), /does not revoke the device on the server/);
  h.click('Yes, Forget This Device'); await h.settle();
  assert.match(h.context.message, /not revoked on the server/);
  assert.ok(!h.requests.some(r => r.path.startsWith('/api/devices')), 'no server revoke call');
});
test('13b. forget requires explicit confirmation', async () => {
  const h = await opened(); h.click('Forget This Device'); h.click('Keep Device Registration'); await h.settle();
  assert.ok(h.stored()); assert.ok(h.button('Unlock'));
});

// ---- 14-16: corrupt storage -----------------------------------------------------------
for (const [name, raw] of [['non-JSON', 'not-json{'], ['null JSON', 'null'], ['wrong types', JSON.stringify({ businessId: 7, credential: CREDENTIAL })], ['missing credential', JSON.stringify({ businessId: 'business' })], ['whitespace credential', JSON.stringify({ businessId: 'business', credential: 'a b' })]]) test(`14/15. malformed stored value (${name}) is removed and settles to registration`, async () => {
  const h = await opened({ raw });
  assert.equal(h.context.vault, 'ready'); assert.equal(h.context.device, null); assert.equal(h.stored(), null);
  assert.ok(h.secure.calls.some(c => c[0] === 'delete')); assert.ok(h.text().includes('Register this shared ZUDE device'));
});
test('14b. malformed value that cannot be deleted fails closed without hanging', async () => {
  const h = await opened({ raw: 'not-json{', fail: { delete: true } });
  assert.equal(h.context.vault, 'unavailable'); assert.notEqual(h.gate, 'WORKSPACE'); assert.ok(h.button('Retry Secure Storage'));
});
test('16. SecureStore read failure settles into explicit retry state and recovers', async () => {
  const h = await opened({ fail: { get: 1 } });
  assert.equal(h.context.vault, 'unavailable'); assert.notEqual(h.gate, 'WORKSPACE', 'fails closed');
  assert.ok(!h.text().includes('Opening secure device storage')); assert.ok(h.text().includes('Secure device storage is unavailable'));
  assert.ok(!h.secure.calls.some(c => c[0] === 'set'), 'no downgrade write');
  h.click('Retry Secure Storage'); await h.settle();
  assert.equal(h.context.vault, 'ready'); assert.ok(h.button('Unlock'), 'registered device recovered after retry');
});

// ---- 17: late PIN after forget ---------------------------------------------------------
test('17. late PIN success after forget cannot restore identity and is revoked', async () => {
  const h = await opened(); h.pinLater();
  for (const d of '1234') h.click(d); h.click('Unlock'); await flush();
  // The UI disables Forget while busy; call the handler directly to prove the generation guard.
  h.context.forget(); await h.settle();
  h.finishPin({ status: 201, body: { success: true, session: SESSION, expiresAt: new Date(Date.now() + 3600000).toISOString(), employee: { id: 'e', businessId: 'business', name: 'Employee', role: 'employee' }, permissions: [] } });
  await h.settle();
  assert.equal(h.context.identity, null); assert.equal(h.stored(), null);
  const lock = h.requests.find(r => r.path === '/api/employee-session/lock' && r.body.session === SESSION); assert.ok(lock, 'late session revoked');
});
test('17b. late device rejection after forget + re-registration never deletes the new credential', async () => {
  const h = await opened(); h.pinLater();
  for (const d of '1234') h.click(d); h.click('Unlock'); await flush();
  h.context.forget(); await h.settle();
  h.context.setName('New iPad'); h.render(); h.context.register(); await h.settle();
  const fresh = h.stored(); assert.ok(fresh);
  h.finishPin({ status: 401, body: { success: false, code: 'DEVICE_REVOKED' } }); await h.settle();
  assert.equal(h.stored(), fresh, 'stale rejection is ignored');
});

// ---- 18 + preserved semantics --------------------------------------------------------------
test('18. device, session and PIN secrets never appear in logs or rendered UI', async () => {
  const h = await opened(); await h.enterPin('1234');
  const surfaces = [h.text(), JSON.stringify(h.logs), h.context.message, JSON.stringify(h.context.identity)];
  h.click('Forget This Device'); h.click('Yes, Forget This Device'); await h.settle(); surfaces.push(h.text(), h.context.message);
  for (const secret of [CREDENTIAL, SESSION, 'S'.repeat(43), 'T'.repeat(43)]) assert.ok(surfaces.every(s => !String(s).includes(secret)), 'secret leaked');
  assert.equal(h.context.pin, '', 'entered PIN is cleared'); assert.equal(h.logs.length, 0);
  assert.equal(h.requests[0].body.pin, '1234', 'PIN only in the request body');
});
test('identity sources never use AsyncStorage/localStorage or log', () => {
  for (const file of ['features/identity/device-vault.ts', 'features/identity/EmployeeIdentityContext.tsx', 'features/identity/DeviceIdentityScreen.tsx', 'lib/employee-identity-api.ts']) {
    // Code only: comments that forbid these APIs are allowed to name them.
    const source = fs.readFileSync(root + file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(source, /async-storage|AsyncStorage|localStorage|sessionStorage|console\./, file);
  }
});
test('backgrounding locks identity but keeps device registration', async () => {
  const h = await opened(); await h.enterPin(); h.background(); await h.settle();
  assert.equal(h.context.identity, null); assert.ok(h.stored()); assert.ok(h.button('Unlock'));
  assert.ok(!h.secure.calls.some(c => c[0] === 'delete')); assert.ok(h.requests.every(r => !r.path.includes('clock')));
});

// ---- Shared-device mode: no path from a locked shared iPad to the account workspace ----
const MARKER = 'zude.shared-device.v1';
test('S1. without a recent account sign-in, a locked shared device offers no Forget and refuses it', async () => {
  const h = await opened({ proven: false });
  assert.ok(h.button('Unlock')); assert.equal(h.button('Forget This Device'), undefined);
  await h.context.forget(); await h.settle();
  assert.ok(h.stored(), 'credential kept'); assert.match(h.context.message, /must sign in again/);
  assert.notEqual(h.gate, 'WORKSPACE');
});
test('S2. a PIN-unlocked employee with devices:manage may forget without account step-up', async () => {
  const h = await opened({ proven: false, permissions: ['team:manage-employees', 'devices:manage'] });
  await h.enterPin(); assert.ok(h.button('Forget This Device'));
  await h.forget(); assert.equal(h.stored(), null); assert.notEqual(h.gate, 'WORKSPACE');
});
test('S3. a plain employee PIN cannot forget the device', async () => {
  const h = await opened({ proven: false, permissions: [] });
  await h.enterPin(); assert.equal(h.button('Forget This Device'), undefined);
  await h.context.forget(); await h.settle(); assert.ok(h.stored());
});
test('S4. an expired account step-up is refused when the action runs', async () => {
  const h = await opened({ proven: false });
  h.proofModule.recordAccountSignIn('account', Date.now() - 11 * 60 * 1000); await h.settle();
  await h.context.forget(); await h.settle();
  assert.ok(h.stored()); assert.match(h.context.message, /must sign in again/);
});
test('S5. restarting after the credential is gone keeps the shared-device gate', async () => {
  const h = await opened({ stored: null, marker: true, proven: false });
  assert.notEqual(h.gate, 'WORKSPACE'); assert.ok(h.text().includes('Register this shared ZUDE device'));
  assert.equal(h.button('Register device'), undefined, 're-registration needs step-up');
  assert.equal(h.button('Stop Shared-Device Use'), undefined); assert.ok(h.button('Sign Out of ZUDE'));
  await h.context.register(); await h.settle(); assert.equal(h.stored(), null, 'refused at action time');
});
test('S6. leaving shared-device mode needs step-up and verified marker removal', async () => {
  const denied = await opened({ stored: null, marker: true, proven: false });
  await denied.context.leaveSharedMode(); await denied.settle();
  assert.ok(denied.secure.store.has(MARKER)); assert.notEqual(denied.gate, 'WORKSPACE');
  const h = await opened({ stored: null, marker: true, proven: true });
  h.click('Stop Shared-Device Use'); await h.settle();
  assert.equal(h.secure.store.has(MARKER), false); assert.equal(h.gate, 'WORKSPACE');
  const stuck = await opened({ stored: null, marker: true, proven: true, fail: { delete: true } });
  stuck.click('Stop Shared-Device Use'); await stuck.settle();
  assert.ok(stuck.secure.store.has(MARKER)); assert.notEqual(stuck.gate, 'WORKSPACE'); assert.match(stuck.context.message, /still a shared device/);
});
test('S7. Sign Out is confirmed, keeps the registration and the shared-device marker', async () => {
  const h = await opened({ proven: false });
  h.click('Sign Out of ZUDE'); assert.equal(h.signedOut, 0); h.click('Yes, Sign Out'); await h.settle();
  assert.equal(h.signedOut, 1); assert.ok(h.stored()); assert.ok(h.secure.store.has(MARKER));
});
test('S8. first registration in account mode needs no step-up and enters shared-device mode', async () => {
  const h = await opened({ stored: null, proven: false });
  assert.equal(h.gate, 'WORKSPACE', 'unregistered installation is account mode (setup)');
  assert.ok(h.text().includes('Register this ZUDE device')); assert.match(h.text(), /Add employees in Team first/);
  h.context.setName('Front desk'); h.render(); h.click('Register device'); await h.settle();
  assert.ok(h.stored()); assert.ok(h.secure.store.has(MARKER)); assert.notEqual(h.gate, 'WORKSPACE'); assert.ok(h.button('Unlock'));
  const markIndex = h.secure.calls.findIndex(c => c[0] === 'set' && c[1] === MARKER), saveIndex = h.secure.calls.findIndex(c => c[0] === 'set' && c[1] === KEY);
  assert.ok(markIndex >= 0 && markIndex < saveIndex, 'marker recorded before the credential');
});
test('S9. published operational identity: account → locked → employee → locked', async () => {
  const account = await opened({ stored: null, proven: false });
  assert.equal(account.operational.operationalIdentity('business').mode, 'account');
  const h = await opened(); assert.equal(h.operational.operationalIdentity('business').mode, 'locked');
  await h.enterPin(); const id = h.operational.operationalIdentity('business');
  assert.equal(id.mode, 'employee'); assert.equal(id.credential, CREDENTIAL); assert.equal(id.session, SESSION);
  assert.equal(h.operational.operationalIdentity('other-business').mode, 'locked', 'another business fails closed');
  h.click('Lock'); await h.settle(); assert.equal(h.operational.operationalIdentity('business').mode, 'locked');
});
test('S10. a locked shared device refuses management requests before sending', async () => {
  const h = await opened(); let sent = false;
  await assert.rejects(h.operational.operationalRequest('business', async () => { sent = true; }), e => e.code === 'IDENTITY_REQUIRED');
  assert.equal(sent, false);
});
test('S11. management request IDENTITY_UNAUTHORIZED locks the current session but keeps the device', async () => {
  const h = await opened(); await h.enterPin(); let headers;
  await assert.rejects(h.operational.operationalRequest('business', async (sent) => { headers = sent; throw new ApiError(401, 'IDENTITY_UNAUTHORIZED', 'x'); }));
  assert.deepEqual(JSON.parse(JSON.stringify(headers)), { 'x-zude-device': CREDENTIAL, 'x-zude-employee-session': SESSION });
  await h.settle(); assert.equal(h.context.identity, null); assert.ok(h.stored()); assert.ok(h.button('Unlock'));
});
test('S12. management request DEVICE_REVOKED runs secure recovery to registration', async () => {
  const h = await opened(); await h.enterPin();
  await assert.rejects(h.operational.operationalRequest('business', async () => { throw new ApiError(401, 'DEVICE_REVOKED', 'x'); }));
  await h.settle(); assert.equal(h.stored(), null); assert.equal(h.context.identity, null);
  assert.ok(h.text().includes('Register this shared ZUDE device')); assert.notEqual(h.gate, 'WORKSPACE');
});
for (const [code, status] of [['ROLE_FORBIDDEN', 403], ['EMPLOYEE_FORBIDDEN', 403], ['SERVICE_UNAVAILABLE', 503], ['DEVICE_REVOKED', 503], ['UNAUTHORIZED', 401]]) test(`S13. management ${status} ${code} neither locks nor forgets`, async () => {
  const h = await opened(); await h.enterPin();
  await assert.rejects(h.operational.operationalRequest('business', async () => { throw new ApiError(status, code, 'x'); }));
  await h.settle(); assert.ok(h.context.identity); assert.ok(h.stored());
});
test('S14. a stale management rejection for an old credential never deletes a new registration', async () => {
  const h = await opened(); await h.enterPin(); let rejectOld;
  const old = h.operational.operationalRequest('business', () => new Promise((_, reject) => { rejectOld = reject; }));
  await h.forget(); h.context.setName('Replacement'); h.render(); h.click('Register device'); await h.settle();
  const fresh = h.stored(); assert.ok(fresh);
  rejectOld(new ApiError(401, 'DEVICE_REVOKED', 'x')); await assert.rejects(old); await h.settle();
  assert.equal(h.stored(), fresh);
});
