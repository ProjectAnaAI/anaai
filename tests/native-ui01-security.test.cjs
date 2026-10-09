const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { load, screen } = require('./support/native-management.cjs');
const { controlledClock, identityHarness } = require('./support/native-employee-security.cjs');
const tokens = load('theme/tokens.ts'), nav = load('navigation/items.ts');
const policy = load('features/identity/employee-inactivity.ts');
const flush = () => new Promise(r => setImmediate(r));
function controller() {
  const clock = controlledClock(); let current = true, locks = 0;
  const c = policy.employeeInactivity({ now: clock.now, schedule: clock.schedule, cancel: clock.cancel, isCurrent: () => current, onLock: () => locks++ });
  return { c, clock, get locks() { return locks; }, replace() { current = false; } };
}
test('security policy is exactly 300000ms; no lock before deadline, one lock at deadline', () => {
  assert.equal(policy.EMPLOYEE_INACTIVITY_LOCK_MS, 300000);
  const h = controller(); h.clock.advance(299999); assert.equal(h.locks, 0);
  h.clock.advance(1); assert.equal(h.locks, 1); assert.equal(h.c.activity(), false); assert.equal(h.locks, 1); assert.equal(h.clock.timers.size, 0);
});
test('meaningful activity resets deadline with exactly one timer; stale cancelled callbacks do nothing', () => {
  const h = controller(); const old = [...h.clock.history.values()][0];
  h.clock.advance(299000); assert.equal(h.c.activity(), true); old(); assert.equal(h.locks, 0);
  for (let i = 0; i < 100; i++) h.c.activity(); assert.equal(h.clock.timers.size, 1);
  h.clock.advance(299999); assert.equal(h.locks, 0); h.clock.advance(1); assert.equal(h.locks, 1);
});
test('suspended timers cannot extend inactivity on resume or on late activity', () => {
  for (const operation of ['check', 'activity']) {
    const h = controller(); h.clock.advance(420000, false); assert.equal(h.c[operation](), false); assert.equal(h.locks, 1); assert.equal(h.clock.timers.size, 0);
  }
});
test('early timer cannot lock early; disposal and replaced identity make queued callbacks inert', () => {
  const h = controller(); const callback = [...h.clock.history.values()][0];
  h.clock.advance(1000, false); h.clock.timers.clear(); callback(); assert.equal(h.locks, 0); assert.equal(h.clock.timers.size, 1);
  h.c.dispose(); h.clock.advance(400000, false); for (const cb of h.clock.history.values()) cb(); assert.equal(h.locks, 0); assert.equal(h.clock.timers.size, 0);
  const other = controller(); other.replace(); other.clock.advance(300000); assert.equal(other.locks, 0);
});
test('real provider inactivity locks into existing PIN gate without time/break mutation or account logout', async () => {
  const h = identityHarness(); await h.ready(); await h.unlock(); const before = JSON.stringify(h.serverTime);
  assert.equal(h.gate(), 'WORKSPACE'); h.clock.advance(299999); h.render(); assert.ok(h.context.identity);
  h.clock.advance(1); assert.equal(h.operational.operationalIdentity('b').mode, 'locked'); await flush(); h.render();
  assert.equal(h.context.identity, null); assert.notEqual(h.gate(), 'WORKSPACE'); assert.equal(h.gate().type.name, 'DeviceIdentityScreen');
  assert.deepEqual(h.requests.map(r => r.path), ['/api/device/pin', '/api/employee-session/lock']);
  assert.equal(JSON.stringify(h.serverTime), before); assert.equal(h.signedOut, 0); assert.equal(h.business.id, 'b');
  await h.unlock(); assert.equal(h.serverTime.A.state, 'WORKING'); assert.equal(h.gate(), 'WORKSPACE'); h.unmount();
});
test('provider capture resets one idle timer without claiming normal gestures', async () => {
  const h = identityHarness(); await h.ready(); await h.unlock(); h.clock.advance(240000);
  assert.equal(h.boundary.props.onStartShouldSetResponderCapture(), false);
  for (let i = 0; i < 100; i++) assert.equal(h.boundary.props.onMoveShouldSetResponderCapture(), false);
  assert.equal(h.clock.timers.size, 2, 'one idle timer plus existing session-expiry timer');
  h.clock.advance(299999); h.render(); assert.ok(h.context.identity); h.clock.advance(1); await flush(); h.render(); assert.equal(h.context.identity, null); h.unmount();
});
test('real provider preserves immediate background lock and cannot revive identity on resume', async () => {
  const h = identityHarness(); await h.ready(); await h.unlock(); h.clock.advance(2000);
  h.lifecycle('inactive'); assert.equal(h.operational.operationalIdentity('b').mode, 'locked'); assert.equal(h.context.identity, null);
  h.clock.advance(420000, false); h.lifecycle('active'); await flush(); h.render(); assert.equal(h.context.identity, null);
  assert.equal(h.requests.filter(r => r.path.endsWith('/lock')).length, 1); h.unmount();
});
test('resume deadline check locks even if no background event was delivered; late touch cannot reset it', async () => {
  for (const mode of ['resume', 'touch']) {
    const h = identityHarness(); await h.ready(); await h.unlock(); h.clock.advance(300000, false);
    if (mode === 'resume') h.lifecycle('active'); else assert.equal(h.boundary.props.onStartShouldSetResponderCapture(), true);
    assert.equal(h.operational.operationalIdentity('b').mode, 'locked'); await flush(); h.render(); assert.equal(h.context.identity, null); h.unmount();
  }
});
test('account-only managers have no idle timer; shared manager PIN identity retains shared-device protection', async () => {
  const account = identityHarness({ shared: false }); await account.ready(); account.clock.advance(3600000); account.lifecycle('active');
  assert.equal(account.context.managementRole, 'owner'); assert.equal(account.gate(), 'WORKSPACE'); assert.equal(account.clock.timers.size, 0); assert.equal(account.requests.length, 0); account.unmount();
  const pin = identityHarness({ role: 'manager' }); await pin.ready(); await pin.unlock(); assert.equal(pin.context.managementRole, 'manager');
  pin.clock.advance(300000); await flush(); pin.render(); assert.equal(pin.context.identity, null); pin.unmount();
});
test('employee A stale idle callback never locks B; old in-flight rejection does not disable B idle policy', async () => {
  const h = identityHarness(); await h.ready(); await h.unlock('A'); const idle = [...h.clock.history.values()][0];
  await h.context.lock(); h.render(); await h.unlock('B'); const lockCount = h.requests.filter(r => r.path.endsWith('/lock')).length;
  idle(); assert.equal(h.context.identity.employee.id, 'B'); assert.equal(h.requests.filter(r => r.path.endsWith('/lock')).length, lockCount);
  h.rejectSession('session-1'); h.render(); assert.equal(h.context.identity.employee.id, 'B');
  h.clock.advance(300000); await flush(); h.render(); assert.equal(h.context.identity, null); assert.equal(h.serverTime.B.state, 'ON_PAID_BREAK'); h.unmount();
});
test('provider cleanup disposes idle timers and web listeners without revoking employee identity', async () => {
  const h = identityHarness({ platform: 'web' }); await h.ready(); await h.unlock(); assert.equal(h.web.size, 3);
  const callbacks = [...h.clock.history.values()]; h.unmount(); assert.equal(h.web.size, 0); assert.equal(h.listeners.size, 0); assert.equal(h.clock.timers.size, 0);
  h.clock.advance(400000, false); callbacks.forEach(callback => callback()); assert.equal(h.requests.filter(r => r.path.endsWith('/lock')).length, 0);
});
test('web keyboard/pointer/wheel reset the shared deadline; expired web input is blocked before child action', async () => {
  const h = identityHarness({ platform: 'web' }); await h.ready(); await h.unlock(); h.clock.advance(299000);
  let prevented = 0, stopped = 0; const event = { preventDefault() { prevented++; }, stopPropagation() { stopped++; } };
  for (const fn of h.web.values()) fn(event); assert.equal(prevented, 0);
  h.clock.advance(300000, false); h.web.get('keydown')(event); assert.equal(prevented, 1); assert.equal(stopped, 1);
  assert.equal(h.operational.operationalIdentity('b').mode, 'locked'); await flush(); h.render(); assert.equal(h.context.identity, null); h.unmount();
});
test('failed inactivity revocation stays locally locked and prevents another unlock', async () => {
  const h = identityHarness({ lockFailure: true }); await h.ready(); await h.unlock(); h.clock.advance(300000); await flush(); h.render();
  assert.equal(h.context.identity, null); assert.ok(h.context.needsLock); assert.equal(h.operational.operationalIdentity('b').mode, 'locked');
  await h.unlock('B'); assert.equal(h.context.identity, null); assert.equal(h.requests.filter(r => r.path === '/api/device/pin').length, 1); h.unmount();
});
test('late PIN success after backgrounding still cannot restore employee authority', async () => {
  const h = identityHarness({ delayPin: true }); await h.ready(); const { promise } = await h.unlock(); h.lifecycle('background'); h.finishPin(); await promise; h.render();
  assert.equal(h.context.identity, null); assert.equal(h.operational.operationalIdentity('b').mode, 'locked'); assert.equal(h.clock.timers.size, 0); h.unmount();
});

function shellHarness({ role = 'manager', pathname = '/', identitySource } = {}) {
  let route = pathname; const replacements = [], locks = []; let contextRef;
  const h = screen('navigation/AppShell.tsx', ({ react, native, jsx, context }) => {
    contextRef = context; context.managementRole = role; context.business.role = 'owner'; context.sharedMode = true;
    context.identity = { employee: { id: 'A', name: 'Ayut Alexandra Montgomery Fernández' }, permissions: role === 'staff' ? [] : ['team:manage-employees'] };
    context.lock = async () => { locks.push('existing-lock'); }; context.recordEmployeeActivity = () => true;
    const rn = { ...native, Modal: 'Modal', Pressable: 'Pressable' };
    const kit = load('components/operations.tsx', { react, 'react-native': rn, 'react/jsx-runtime': jsx, './workspace': { Brand: 'OriginalBrand' }, '../theme/tokens': tokens });
    const sidebar = load('navigation/Sidebar.tsx', { react, 'react-native': rn, 'react/jsx-runtime': jsx, '../components/ui': { Icon: 'Icon', styles: {} }, '../components/workspace': { Brand: 'OriginalBrand' }, '../theme/tokens': tokens, './items': nav, '../features/identity/EmployeeIdentityContext': { useEmployeeIdentity: () => identitySource?.context ?? context } });
    const originalSidebar = { Sidebar: props => jsx.jsx('View', { testID: 'original-sidebar', children: jsx.jsx(sidebar.Sidebar, props) }) };
    return { 'react-native': rn, 'expo-router': { Navigator: 'Navigator', Slot: 'Slot', usePathname: () => route, router: { replace(value) { replacements.push(value); route = typeof value === 'string' ? value : value.pathname; } } },
      'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' }, 'expo-status-bar': { StatusBar: 'StatusBar' }, '../components/operations': kit,
      '../features/time/ShiftAccessContext': { useShiftAccess: () => context.shiftAccess ?? ({ managed: false, allowed: true, target: null }) }, '../features/time/TimeClockScreen': { TimeClockScreen: 'GuardedTimeClock' }, '../components/workspace': { Feedback: 'Feedback' }, '../features/time/state': { timeMessage: () => 'Clock unavailable' },
      '../features/business/BusinessContext': { useBusiness: () => context }, '../features/identity/EmployeeIdentityContext': { useEmployeeIdentity: () => identitySource?.context ?? context },
      '../theme/tokens': tokens, './handoff': { appointmentHandoff: () => ({ start: () => 'token', customer() {} }) }, './items': nav, './Sidebar': originalSidebar, './WorkspaceContext': { WorkspaceContext: { Provider: 'Provider' } },
    };
  }, 'AppShell');
  h.replacements = replacements; h.locks = locks; h.currentRoute = () => route;
  h.press = label => { const node = h.nodes().find(n => n.type === 'Pressable' && n.props.accessibilityLabel === label); assert.ok(node, label); node.props.onPress(); h.render(); };
  const descendants = node => Array.isArray(node) ? node.flatMap(descendants) : node && typeof node === 'object' ? [node, ...descendants(node.props?.children)] : [];
  h.menuNodes = () => descendants(h.nodes().find(node => node.props?.testID === 'original-sidebar'));
  h.pressMenu = label => {
    assert.ok(h.nodes().find(node => node.type === 'Modal').props.visible, 'menu must be open');
    const node = h.menuNodes().find(node => node.type === 'Pressable' && node.props.accessibilityLabel === label);
    assert.ok(node, label); assert.ok(!node.props.disabled, 'authorized functional item');
    node.props.onPress(); h.render();
  };
  h.contextRef = contextRef; return h;
}
test('manager header visibly indicates a menu and announces expanded state; open/close/dismiss never navigate', () => {
  for (const pathname of ['/', '/reports']) {
    const h = shellHarness({ pathname }); const label = 'Ayut Alexandra Montgomery Fernández · Open account menu';
    assert.ok(h.text().includes('▾')); assert.equal(h.nodes().find(n => n.props?.accessibilityLabel === label).props.accessibilityState.expanded, false);
    h.press(label); assert.equal(h.replacements.length, 0); assert.equal(h.nodes().find(n => n.props?.accessibilityLabel === label).props.accessibilityState.expanded, true);
    assert.equal(h.nodes().find(n => n.props?.accessibilityLabel === label).props['aria-expanded'], true);
    assert.ok(h.nodes().some(n => n.type === 'Text' && n.props?.accessibilityRole === 'header' && n.props.children === 'Menu'));
    h.press('Close menu'); assert.equal(h.currentRoute(), pathname); assert.equal(h.replacements.length, 0);
    h.press(label); h.press('Dismiss account menu'); assert.equal(h.currentRoute(), pathname); assert.equal(h.replacements.length, 0); h.dispose();
  }
});
test('manager default/legacy route boundary returns to Today; valid manager routes are preserved', () => {
  for (const pathname of ['/unknown']) {
    const h = shellHarness({ pathname }); assert.equal(h.currentRoute(), '/'); assert.ok(h.nodes().some(n => n.props?.testID === 'original-sidebar')); h.dispose();
  }
  for (const pathname of ['/', '/time-issues', '/team', '/timesheets', '/reports', '/audit', '/time-clock', '/appointments', '/appointments-today', '/customers', '/services', '/my-time', '/working']) {
    const h = shellHarness({ pathname }); assert.equal(h.currentRoute(), pathname); assert.equal(h.replacements.length, 0); h.dispose();
  }
  assert.ok(fs.readFileSync('apps/zude-mobile/src/app/index.tsx', 'utf8').includes('<TodayScreen />'));
  for (const name of ['customers', 'appointments', 'services', 'my-time']) assert.ok(fs.existsSync(`apps/zude-mobile/src/app/${name}.tsx`));
});
test('full original menu uses existing role and PIN permissions; unavailable entries retain disabled state', () => {
  const h = shellHarness(); h.press('Ayut Alexandra Montgomery Fernández · Open account menu');
  assert.ok(h.nodes().some(n => n.props?.accessibilityLabel === 'Audit History'));
  for (const label of ['Registered Devices']) assert.ok(!h.nodes().some(n => n.props?.accessibilityLabel === label), label);
  h.contextRef.identity.permissions.push('devices:manage'); h.render(); assert.ok(h.nodes().some(n => n.props?.accessibilityLabel === 'Registered Devices'));
  h.contextRef.managementRole = 'staff'; h.contextRef.identity.permissions = []; h.render(); assert.ok(!h.nodes().some(n => n.props?.accessibilityLabel === 'Audit History'));
  h.dispose();
});
test('Switch User in rendered shell invokes real identity lock only, returns to PIN, and preserves ongoing break/time/account', async () => {
  const identity = identityHarness(); await identity.ready(); await identity.unlock('B'); const before = JSON.stringify(identity.serverTime);
  const h = shellHarness({ role: 'staff', pathname: '/time-clock', identitySource: identity });
  assert.ok(h.nodes().some(n => n.props?.accessibilityLabel === 'Switch User')); h.press('Switch User'); h.press('Switch User');
  assert.equal(identity.operational.operationalIdentity('b').mode, 'locked'); await flush(); identity.render(); assert.equal(identity.context.identity, null); assert.notEqual(identity.gate(), 'WORKSPACE');
  assert.equal(identity.requests.filter(r => r.path.endsWith('/lock')).length, 1);
  assert.deepEqual(identity.requests.map(r => r.path), ['/api/device/pin', '/api/employee-session/lock']);
  assert.equal(JSON.stringify(identity.serverTime), before); assert.equal(identity.signedOut, 0); assert.equal(identity.business.id, 'b'); h.dispose(); identity.unmount();
});
test('manager/employee tabs remain isolated and Switch User/name controls retain generous flexible targets', () => {
  const h = shellHarness(); const tabs = () => h.nodes().filter(n => n.props?.accessibilityRole === 'tab').map(n => n.props.accessibilityLabel);
  assert.deepEqual(tabs(), ['Today', 'Attention', 'People', 'Time', 'Reports']);
  for (const label of ['Switch User', 'Ayut Alexandra Montgomery Fernández · Open account menu']) {
    const button = h.nodes().find(n => n.props?.accessibilityLabel === label); assert.ok(button.props.style({ pressed: false }).some(s => s?.minHeight >= 44));
    assert.ok(button.props.style({ pressed: true }).some(s => s?.backgroundColor === tokens.design.color.surfaceSubtle));
    button.props.onFocus(); h.render(); assert.ok(h.nodes().find(n => n.props?.accessibilityLabel === label).props.style({ pressed: false }).some(s => s?.borderColor === tokens.design.color.focus));
  }
  h.contextRef.managementRole = 'staff'; h.render(); assert.deepEqual(tabs(), ['Clock', 'My Time', 'Report Issue']); h.dispose();
});
test('original production logo bytes stay unchanged', () => {
  const hash = crypto.createHash('sha256').update(fs.readFileSync('apps/zude-mobile/assets/brand/zu-logo.png')).digest('hex');
  assert.equal(hash, '6031dd98c7d53447b7761eddeeede3e926ee3213028784417d280e042da7ea7e');
});
test('shared Field reports native keyboard edits/key presses/submit to the same deadline and blocks expired edits', async () => {
  const identity = identityHarness(); await identity.ready(); await identity.unlock();
  let edits = 0, keys = 0, submissions = 0;
  const kit = load('components/workspace.tsx', {
    react: { useState: () => [false, () => {}] }, 'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    'react-native': { View: 'View', TextInput: 'TextInput', StyleSheet: { create: value => value } },
    '../features/identity/EmployeeActivityContext': { useEmployeeActivity: () => identity.context.recordEmployeeActivity },
    '../theme/tokens': tokens, '../theme/layout': {}, './ui': { styles: {} },
  });
  const field = kit.Field({ label: 'Note', onChangeText: () => edits++, onKeyPress: () => keys++, onSubmitEditing: () => submissions++ });
  const input = field.props.children.find(n => n && n.type === 'TextInput');
  identity.clock.advance(299000); input.props.onChangeText('Meaningful text'); input.props.onKeyPress({}); input.props.onSubmitEditing({});
  assert.equal(edits, 1); assert.equal(keys, 1); assert.equal(submissions, 1); assert.equal(identity.clock.timers.size, 2);
  identity.clock.advance(299999); identity.render(); assert.ok(identity.context.identity);
  identity.clock.advance(1, false); input.props.onChangeText('Too late'); assert.equal(edits, 1);
  assert.equal(identity.operational.operationalIdentity('b').mode, 'locked'); await flush(); identity.render(); assert.equal(identity.context.identity, null); identity.unmount();
});
test('a stale activity/input reporter from employee A cannot extend or lock B or forward after A locks', async () => {
  const h = identityHarness(); await h.ready(); await h.unlock('A'); const reportA = h.context.recordEmployeeActivity;
  await h.context.lock(); assert.equal(reportA(), false); h.render(); await h.unlock('B');
  h.clock.advance(299999); assert.equal(reportA(), false); assert.equal(h.context.identity.employee.id, 'B');
  h.clock.advance(1); await flush(); h.render(); assert.equal(h.context.identity, null); h.unmount();
});
test('timeout during an in-flight read removes authority immediately; late completion cannot reopen the identity gate', async () => {
  const h = identityHarness(); await h.ready(); await h.unlock(); let finish, headers;
  const pending = h.operational.operationalRequest('b', value => { headers = value; return new Promise(resolve => { finish = resolve; }); });
  assert.equal(headers['x-zude-employee-session'], 'session-1');
  h.clock.advance(300000); assert.equal(h.operational.operationalIdentity('b').mode, 'locked');
  let sent = false; await assert.rejects(h.operational.operationalRequest('b', async () => { sent = true; }), /IDENTITY_REQUIRED/); assert.equal(sent, false);
  finish({ state: 'WORKING' }); await pending; await flush(); h.render(); assert.equal(h.context.identity, null); assert.notEqual(h.gate(), 'WORKSPACE');
  assert.deepEqual(h.requests.map(r => r.path), ['/api/device/pin', '/api/employee-session/lock']); h.unmount();
});

test('Operations menu explicitly opens existing Appointments and appointment Today without resetting primary Today', () => {
  const h = shellHarness();
  assert.equal(h.currentRoute(), '/');
  h.press('Ayut Alexandra Montgomery Fernández · Open account menu');
  assert.equal(h.replacements.length, 0);
  assert.ok(h.text().includes('Operations'));
  h.press('Appointments');
  assert.equal(h.currentRoute(), '/appointments');
  assert.equal(h.replacements.length, 1, 'no subsequent default redirect');
  assert.ok(h.nodes().some(n => n.type === 'Slot'));
  h.press('Ayut Alexandra Montgomery Fernández · Open account menu');
  h.press('Close menu');
  assert.equal(h.currentRoute(), '/appointments');
  h.press('Ayut Alexandra Montgomery Fernández · Open account menu');
  h.pressMenu('Today');
  assert.equal(h.currentRoute(), '/appointments-today');
  assert.match(fs.readFileSync('apps/zude-mobile/src/app/appointments-today.tsx', 'utf8'), /TodayScreen as default.*features\/today\/TodayScreen/);
  assert.match(fs.readFileSync('apps/zude-mobile/src/app/appointments.tsx', 'utf8'), /AppointmentsScreen as default/);
  h.press('Today'); assert.equal(h.currentRoute(), '/'); h.dispose();
});
test('existing appointment member access is preserved for staff without granting management destinations', () => {
  for (const role of ['owner', 'manager', 'staff']) {
    for (const route of ['/appointments', '/appointments-today']) {
      assert.equal(nav.shellDestination(role, route, []), route);
      assert.ok(nav.visibleNavigation(role, []).flatMap(group => group.items).some(item => item.route === route));
    }
  }
  for (const pathname of ['/audit', '/devices', '/reports', '/team']) {
    const h = shellHarness({ role: 'staff', pathname }); assert.equal(h.currentRoute(), '/appointments-today'); h.dispose();
  }
  assert.equal(nav.shellDestination('manager', '/devices', []), '/');
  assert.equal(nav.shellDestination('manager', '/audit', []), '/');
  assert.equal(nav.shellDestination('manager', '/devices', null), '/devices');
  const h = shellHarness({ role: 'staff', pathname: '/appointments' });
  h.press('Ayut Alexandra Montgomery Fernández · Open account menu');
  assert.ok(h.nodes().some(n => n.props?.accessibilityLabel === 'Appointments'));
  assert.ok(!h.nodes().some(n => n.props?.accessibilityLabel === 'Audit History')); h.dispose();
});
test('queued expiry callback from employee A never revokes B, while current expiry still locks into PIN', async () => {
  const h = identityHarness({ sessionLifetimeMs: 120000 }); await h.ready(); await h.unlock('A');
  const expiryA = [...h.clock.history.values()][1]; assert.ok(expiryA);
  await h.context.lock(); h.render(); await h.unlock('B');
  const before = h.requests.filter(r => r.path.endsWith('/lock')).length;
  expiryA(); await flush(); h.render();
  assert.equal(h.context.identity.employee.id, 'B');
  assert.equal(h.requests.filter(r => r.path.endsWith('/lock')).length, before);
  h.clock.advance(119999); assert.equal(h.context.identity.employee.id, 'B');
  h.clock.advance(1); await flush(); h.render();
  assert.equal(h.context.identity, null); assert.notEqual(h.gate(), 'WORKSPACE');
  assert.equal(h.requests.filter(r => r.path.endsWith('/lock')).length, before + 1);
  assert.equal(h.serverTime.B.state, 'ON_PAID_BREAK'); assert.equal(h.signedOut, 0); h.unmount();
});
test('stable lock dependencies retain one lifecycle subscription across PIN, activity and identity replacement', async () => {
  const h = identityHarness({ platform: 'web' }); await h.ready();
  const listener = [...h.listeners][0], keyboard = h.web.get('keydown');
  await h.unlock('A'); h.context.setName('typing'); h.render();
  h.boundary.props.onStartShouldSetResponderCapture(); h.render();
  assert.equal(h.listeners.size, 1); assert.equal([...h.listeners][0], listener);
  assert.equal(h.web.get('keydown'), keyboard);
  await h.context.lock(); h.render(); await h.unlock('B');
  assert.equal([...h.listeners][0], listener); assert.equal(h.web.get('keydown'), keyboard);
  h.lifecycle('background'); await flush(); h.render();
  assert.equal(h.context.identity, null); assert.equal(h.serverTime.B.state, 'ON_PAID_BREAK'); h.unmount();
});

test('restored catalog retains every checkpoint section/item/permission/capability in original order', () => {
  const { execFileSync } = require('node:child_process');
  const ts = require('typescript'), vm = require('node:vm');
  const source = execFileSync('git', ['show', 'd570568:apps/zude-mobile/src/navigation/items.ts'], { encoding: 'utf8' });
  const checkpoint = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports: checkpoint });
  const original = JSON.parse(JSON.stringify(checkpoint.navigationGroups));
  original[0].items.find(item => item.label === 'Today').route = '/appointments-today';
  const restored = JSON.parse(JSON.stringify(nav.navigationGroups)).map(group => ({ ...group, items: group.items.filter(item => item.label !== "Today's Appointments") }));
  assert.deepEqual(restored, original, 'no original entries, role rules, capability states or routes removed');
  assert.equal(new Set(nav.navigationGroups.flatMap(group => group.items).map(item => item.label)).size, nav.navigationGroups.flatMap(group => group.items).length);
});
test('expanded original Sidebar renders every authorized section/item, disabled capabilities and selected route', () => {
  const h = shellHarness({ pathname: '/reports' }); h.contextRef.identity.permissions.push('devices:manage'); h.render();
  h.press('Ayut Alexandra Montgomery Fernández · Open account menu');
  const menu = h.menuNodes();
  for (const group of nav.visibleNavigation('manager', ['team:manage-employees', 'devices:manage'])) {
    assert.ok(menu.some(node => node.type === 'Text' && node.props.children === group.title), group.title);
    for (const item of group.items) {
      const unavailable = item.state !== 'AVAILABLE_NATIVE';
      const button = menu.find(node => node.type === 'Pressable' && node.props.accessibilityLabel === item.label + (unavailable ? ', unavailable on this device' : ''));
      assert.ok(button, item.label); assert.equal(button.props.disabled, unavailable);
      assert.ok(button.props.style({ pressed: false }).some(style => style?.minHeight >= 44));
      if (unavailable) { const count = h.replacements.length; button.props.onPress(); assert.equal(h.replacements.length, count); }
    }
  }
  assert.equal(menu.find(node => node.props?.accessibilityLabel === 'Reports').props.accessibilityState.selected, true);
  assert.ok(menu.some(node => node.type === 'ScrollView')); assert.ok(!menu.some(node => node.type === 'OriginalBrand'), 'drawer does not display a logo');
  h.press('Close menu'); assert.equal(h.currentRoute(), '/reports'); assert.equal(h.replacements.length, 0); h.dispose();
});
test('every authorized original native destination navigates from the menu without default-route hijack', () => {
  for (const role of ['owner', 'manager', 'staff']) {
    const permissions = role === 'staff' ? [] : ['team:manage-employees', 'devices:manage'];
    const h = shellHarness({ role }); h.contextRef.identity.permissions = permissions; h.render();
    for (const item of nav.visibleNavigation(role, permissions).flatMap(group => group.items).filter(item => item.state === 'AVAILABLE_NATIVE' && item.label !== 'Lock')) {
      h.press('Ayut Alexandra Montgomery Fernández · Open account menu');
      const before = h.replacements.length;
      h.pressMenu(item.label);
      assert.equal(h.currentRoute(), item.route, `${role}: ${item.label}`);
      assert.equal(h.replacements.length, before + 1, 'one intentional navigation, no redirect afterward');
      assert.equal(h.nodes().find(node => node.type === 'Modal').props.visible, false);
      assert.ok(h.nodes().some(node => node.type === 'Slot'));
    }
    h.dispose();
  }
});
test('route admission uses original catalog permissions and rejects employee manager/fake destinations', () => {
  for (const role of ['owner', 'manager', 'staff']) for (const permissions of [null, [], ['team:manage-employees'], ['devices:manage'], ['team:manage-employees', 'devices:manage']]) {
    for (const item of nav.navigationGroups.flatMap(group => group.items).filter(item => item.state === 'AVAILABLE_NATIVE')) {
      const visible = nav.visibleNavigation(role, permissions).flatMap(group => group.items).some(candidate => candidate.route === item.route);
      assert.equal(nav.shellDestination(role, item.route, permissions), visible ? item.route : role === 'staff' ? '/appointments-today' : '/', `${role}: ${item.label}`);
    }
  }
  for (const route of ['/settings', '/analytics', '/corrections', '/ai', '/unknown']) assert.equal(nav.shellDestination('manager', route, null), '/');
  assert.equal(nav.shellDestination('staff', '/report-issue', []), '/report-issue');
  const h = shellHarness({ role: 'staff', pathname: '/reports' }); h.press('Ayut Alexandra Montgomery Fernández · Open account menu');
  for (const label of ['Who’s Working', 'Team', 'Timesheets', 'Reported Issues', 'Audit History', 'Reports', 'Registered Devices']) assert.ok(!h.menuNodes().some(node => node.props?.accessibilityLabel === label));
  assert.equal(h.currentRoute(), '/appointments-today'); h.dispose();
});
test('original System Lock uses the existing secure identity path without navigating or changing time', async () => {
  const identity = identityHarness(); await identity.ready(); await identity.unlock('B'); const before = JSON.stringify(identity.serverTime);
  const h = shellHarness({ role: 'staff', pathname: '/my-time', identitySource: identity });
  h.press('Employee B · Open account menu'); const routeCount = h.replacements.length;
  h.pressMenu('Lock');
  assert.equal(identity.operational.operationalIdentity('b').mode, 'locked'); await flush(); identity.render();
  assert.equal(identity.context.identity, null); assert.notEqual(identity.gate(), 'WORKSPACE');
  assert.equal(h.replacements.length, routeCount); assert.equal(JSON.stringify(identity.serverTime), before); assert.equal(identity.signedOut, 0);
  assert.deepEqual(identity.requests.map(request => request.path), ['/api/device/pin', '/api/employee-session/lock']); h.dispose(); identity.unmount();
});

test('staff cold root lands on appointment Today and the menu selects only that destination', () => {
  const h = shellHarness({ role: 'staff', pathname: '/' });
  assert.equal(h.currentRoute(), '/appointments-today');
  assert.equal(nav.activeNavigationLabel('/appointments-today'), 'Today');
  assert.equal(nav.activeNavigationLabel('/'), '', 'workforce Today is not Operations Today');
  assert.equal(nav.navigationGroups[0].items.filter(item => item.route === '/appointments-today').length, 1);
  h.dispose();
});

test('mandatory shift gate withholds operational Slots and blocks bottom/sidebar/handoff while keeping identity controls', () => {
  for (const role of ['staff', 'manager', 'owner']) {
    for (const pathname of ['/appointments', '/reports', '/appointments-today', '/customers', '/my-time', '/']) {
      const h = shellHarness({ role, pathname });
      h.contextRef.shiftAccess = { managed: true, allowed: false, loading: false, target: '/time-clock', refresh() {} };
      h.render(); h.render();
      assert.equal(h.currentRoute(), '/time-clock'); assert.ok(!h.nodes().some(n => n.type === 'Slot'));
      assert.ok(h.nodes().some(n => n.type === 'GuardedTimeClock'));
      for (const tab of h.nodes().filter(n => n.props?.accessibilityRole === 'tab')) {
        assert.equal(tab.props.disabled, true);
        const before = h.replacements.length; tab.props.onPress(); h.render();
        assert.equal(h.currentRoute(), '/time-clock');
        if (tab.props.accessibilityLabel !== 'Clock') assert.equal(h.replacements.length, before);
      }
      const identityLabel = 'Ayut Alexandra Montgomery Fernández · Open account menu';
      h.press(identityLabel);
      for (const button of h.menuNodes().filter(n => n.type === 'Pressable')) {
        if (button.props.accessibilityLabel === 'Time Clock' || button.props.accessibilityLabel === 'Lock') assert.equal(button.props.disabled, false);
        else { assert.equal(button.props.disabled, true); const before = h.replacements.length; button.props.onPress(); h.render(); assert.equal(h.replacements.length, before); }
      }
      assert.equal(h.nodes().find(n => n.props?.accessibilityLabel === 'Switch User').props.disabled, false);
      const provider = h.nodes().find(n => n.type === 'Provider'); const before = h.replacements.length;
      provider.props.value.startAppointment({ id: 'customer' }); h.render(); assert.equal(h.replacements.length, before);
      h.dispose();
    }
  }
});
test('a gate failure withholds an already mounted operational page and retains retry/lock controls', () => {
  const h = shellHarness({ pathname: '/reports' }); assert.ok(h.nodes().some(n => n.type === 'Slot'));
  let retried = false; h.contextRef.shiftAccess = { managed: true, allowed: false, target: null, error: Error('private error'), refresh() { retried = true; } };
  h.render(); assert.ok(!h.nodes().some(n => n.type === 'Slot'));
  const feedback = h.nodes().find(n => n.type === 'Feedback'); assert.equal(feedback.props.kind, 'error');
  feedback.props.retry(); assert.equal(retried, true); assert.ok(h.nodes().some(n => n.props?.accessibilityLabel === 'Lock'));
  h.dispose();
});
