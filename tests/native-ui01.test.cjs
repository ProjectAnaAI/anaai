const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { screen, load } = require('./support/native-management.cjs');
const tokens = load('theme/tokens.ts');
const navigation = load('navigation/items.ts');
const instant = '2026-10-07T16:00:00Z';
function employee(id, state, name = id) {
  const shift = state === 'OFF_CLOCK' ? null : { id: `shift-${id}`, clockInAt: instant, elapsedMs: 3600000, workedMs: 3000000, paidBreakMs: 0, mealBreakMs: 600000,
    break: state.includes('BREAK') ? { type: state === 'ON_PAID_BREAK' ? 'PAID' : 'MEAL', startedAt: instant, durationMs: 600000, intendedMinutes: 15 } : null };
  return { employee: { id, name, isActive: true }, state, stateStartedAt: instant, shift, inactiveOpenShift: false };
}
const fixture = ['WORKING', 'WORKING', 'ON_PAID_BREAK', 'ON_MEAL_BREAK', 'OFF_CLOCK', 'OFF_CLOCK'].map((state, i) => employee(String(i), state, ['Sherlyn', 'Brandy', 'Maria', 'Nina', 'Leo', 'Anika'][i]));
function today({ rows = fixture, issues = [], cursor = null, rosterError = false, issueError = false } = {}) {
  const calls = [];
  const h = screen('features/management/ManagerTodayScreen.tsx', ({ react, native, jsx, context }) => {
    context.business.timezone = 'America/Los_Angeles'; context.identity.employee.name = 'Manager';
    const rn = { ...native, Pressable: 'Pressable', useWindowDimensions: () => ({ width: 1024, height: 768, fontScale: 1 }) };
    const kit = load('components/operations.tsx', { react, 'react-native': rn, 'react/jsx-runtime': jsx, './workspace': { Brand: 'OriginalBrand' }, '../theme/tokens': tokens });
    return { 'react-native': rn, 'expo-router': { router: { replace: route => calls.push(route) } }, '../../components/operations': kit, '../../theme/tokens': tokens,
      '../identity/EmployeeIdentityContext': { useEmployeeIdentity: () => context },
      '../../lib/working-api': { getWorking: async (businessId, signal) => { calls.push({ source: 'working', businessId, signal }); if (rosterError) throw Error('secret error'); return { businessId, timezone: context.business.timezone, snapshotAt: instant, employees: rows }; } },
      '../../lib/time-issues-api': { getIssues: async (businessId, status, requestCursor, signal) => { calls.push({ source: 'issues', businessId, status, cursor: requestCursor, signal }); if (issueError) throw Error('secret error'); return { businessId, issues, nextCursor: cursor }; } },
    };
  }, 'ManagerTodayScreen');
  h.routes = calls; return h;
}
function click(h, label) { const n = h.nodes().find(n => n.type === 'Pressable' && n.props.accessibilityLabel === label); assert.ok(n, label); n.props.onPress(); h.render(); }
test('UI01 manager and employee tabs route to existing workflows, audit stays secondary', () => {
  assert.equal(JSON.stringify(navigation.primaryTabs('manager')), '[{"label":"Today","route":"/"},{"label":"Attention","route":"/time-issues"},{"label":"People","route":"/team"},{"label":"Time","route":"/timesheets"},{"label":"Reports","route":"/reports"}]');
  assert.equal(JSON.stringify(navigation.primaryTabs('owner')), JSON.stringify(navigation.managerTabs));
  assert.equal(JSON.stringify(navigation.primaryTabs('staff')), '[{"label":"Clock","route":"/time-clock"},{"label":"My Time","route":"/my-time"},{"label":"Report Issue","route":"/report-issue"}]');
  assert.ok(!navigation.managerTabs.some(t => t.route === '/audit'));
  for (const tab of [...navigation.managerTabs, ...navigation.employeeTabs]) assert.ok(fs.existsSync(`apps/zude-mobile/src/app/${tab.route === '/' ? 'index' : tab.route.slice(1)}.tsx`));
});
test('UI01 branding remains available outside the header; employee report entry reuses existing form', () => {
  const brand = fs.readFileSync('apps/zude-mobile/src/components/workspace.tsx', 'utf8');
  assert.match(brand, /assets\/brand\/zu-logo\.png/); assert.match(brand, /resizeMode="contain"/);
  assert.doesNotMatch(fs.readFileSync('apps/zude-mobile/src/components/operations.tsx', 'utf8'), /<Brand \/>/);
  assert.match(fs.readFileSync('apps/zude-mobile/src/app/report-issue.tsx', 'utf8'), /<MyTimeScreen initiallyReporting \/>/);
  assert.ok(tokens.design.control.minimum >= 44 && tokens.design.control.primary >= 44 && tokens.design.control.navigation >= 44);
});
test('UI01 renders supplied working, paid break, meal break and off states; summaries filter without recomputation', async () => {
  const h = today(); await h.flush();
  for (const text of ['Working', 'Paid break', 'Meal break', 'Off', 'Clocked in', 'Break since', 'elapsed', 'on break', 'Sherlyn', 'Anika']) assert.ok(h.text().includes(text), text);
  assert.ok(h.nodes().some(n => n.props?.accessibilityLabel === '2 Working'));
  click(h, '2 Working'); assert.ok(h.text().includes('Sherlyn')); assert.ok(!h.text().includes('Anika'));
  click(h, 'Show all'); assert.ok(h.text().includes('Anika'));
  assert.equal(h.routes.filter(c => c.source === 'working').length, 1);
  assert.equal(h.routes.find(c => c.source === 'issues').status, 'open');
  click(h, 'Sherlyn, Working. View time'); assert.equal(h.routes.at(-1), '/timesheets'); h.dispose();
});
test('UI01 calm state requires both successful current resources', async () => {
  const h = today(); assert.ok(!h.text().includes('Everything looks good')); await h.flush();
  assert.ok(h.text().includes('Everything looks good')); assert.ok(h.text().includes('No time issues need your attention.'));
  click(h, 'Refresh Today'); assert.ok(!h.text().includes('Everything looks good')); await h.flush(); h.dispose();
  for (const options of [{ rosterError: true }, { issueError: true }]) { const h = today(options); await h.flush(); assert.ok(!h.text().includes('Everything looks good')); assert.ok(!h.text().includes('secret error')); h.dispose(); }
});
test('UI01 evidence from existing reports and inactive open shifts leads to existing review; no invented judgment', async () => {
  const row = { ...employee('x', 'WORKING', 'Inactive person'), inactiveOpenShift: true };
  const h = today({ rows: [...fixture, row], issues: [{ id: 'issue', employee_id: '0', employee_name: 'Sherlyn', note: 'Forgot to clock out' }] }); await h.flush();
  for (const text of ['Reported time issue', 'Forgot to clock out', 'shift still open']) assert.ok(h.text().includes(text));
  assert.ok(!h.text().includes('Everything looks good'));
  for (const text of ['Unusually late', 'Suspicious shift', 'Needs correction']) assert.ok(!h.text().includes(text));
  click(h, 'Review reported issue'); assert.equal(h.routes.at(-1), '/time-issues'); click(h, 'Review time'); assert.equal(h.routes.at(-1), '/timesheets'); h.dispose();
});
test('UI01 issue continuation is explicitly bounded and cannot imply calm', async () => {
  const h = today({ cursor: 'next-page' }); await h.flush(); assert.ok(!h.text().includes('Everything looks good')); assert.ok(h.text().includes('More reports are available')); h.dispose();
});
test('UI01 long names remain intact with shrinkable layout and wrap rather than fixed row heights', async () => {
  const name = 'Sherlyn Alexandria Montgomery Fernández with a very long employee name';
  const h = today({ rows: [employee('long', 'WORKING', name)] }); await h.flush(); assert.ok(h.text().includes(name));
  const row = h.nodes().find(n => n.type === 'Pressable' && n.props.accessibilityLabel.startsWith(name)); assert.ok(row);
  const styles = row.props.style({ pressed: false }); assert.ok(styles.some(s => s?.minHeight >= 44)); assert.ok(!styles.some(s => s?.height)); h.dispose();
});
test('UI01 sensitive Today content clears on lock, background, blur and tenant switch; late data cannot repopulate', async () => {
  const h = today(); await h.flush(); assert.ok(h.text().includes('Sherlyn'));
  h.background('background'); assert.ok(!h.text().includes('Sherlyn')); h.background('active'); await h.flush();
  h.focus(false); assert.ok(!h.text().includes('Sherlyn')); h.focus(true); await h.flush();
  h.context.business.id = 'other'; h.render(); assert.ok(!h.text().includes('Sherlyn')); await h.flush();
  h.context.identity = null; h.context.managementRole = 'staff'; h.render(); assert.ok(!h.text().includes('Sherlyn')); await h.flush(); assert.ok(!h.text().includes('Sherlyn')); h.dispose();
});
function shell(role = 'manager') {
  let locked = false;
  const routes = [];
  const h = screen('navigation/AppShell.tsx', ({ react, native, jsx, context }) => {
    context.managementRole = role; context.identity.employee.name = 'Manager Name'; context.identity.permissions = role === 'staff' ? [] : ['team:manage-employees']; context.lock = async () => {}; context.recordEmployeeActivity = () => true;
    const rn = { ...native, Pressable: 'Pressable', Modal: 'Modal' };
    const kit = load('components/operations.tsx', { react, 'react-native': rn, 'react/jsx-runtime': jsx, './workspace': { Brand: 'OriginalBrand' }, '../theme/tokens': tokens });
    const sidebar = load('navigation/Sidebar.tsx', { react, 'react-native': rn, 'react/jsx-runtime': jsx, '../components/ui': { Icon: 'Icon', styles: {} }, '../components/workspace': { Brand: 'OriginalBrand' }, '../theme/tokens': tokens, './items': navigation, '../features/identity/EmployeeIdentityContext': { useEmployeeIdentity: () => context } });
    const originalSidebar = { Sidebar: props => jsx.jsx('View', { testID: 'original-sidebar', children: jsx.jsx(sidebar.Sidebar, props) }) };
    return { 'react-native': rn, 'expo-router': { Navigator: 'Navigator', Slot: 'Slot', usePathname: () => '/', router: { replace: value => routes.push(value) } },
      'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' }, 'expo-status-bar': { StatusBar: 'StatusBar' },
      '../components/ui': { IconButton: 'IconButton' }, '../components/operations': kit,
      '../features/time/ShiftAccessContext': { useShiftAccess: () => ({ managed: false, allowed: true, target: null }) }, '../features/time/TimeClockScreen': { TimeClockScreen: 'GuardedTimeClock' }, '../components/workspace': { Feedback: 'Feedback' }, '../features/time/state': { timeMessage: () => 'Clock unavailable' },
      '../features/business/BusinessContext': { useBusiness: () => context }, '../features/identity/EmployeeIdentityContext': { useEmployeeIdentity: () => context },
      '../theme/tokens': tokens, './handoff': { appointmentHandoff: () => ({ start: () => 'token', customer() {} }) }, './items': navigation,
      './WorkspaceContext': { WorkspaceContext: { Provider: 'Provider' } }, './Sidebar': originalSidebar,
    };
  }, 'AppShell');
  h.routes = routes;
  h.lockNavigation = () => { if (!locked) { h.nodes().find(n => n.type === 'Provider').props.value.setNavigationLocked(true); locked = true; h.render(); } };
  return h;
}
test('UI01 actual shell navigates manager tabs, preserves handoff and honors navigation lock', () => {
  const h = shell();
  assert.equal(h.nodes().filter(n => n.type === 'Pressable' && n.props.accessibilityRole === 'tab').length, 5);
  for (const tab of navigation.managerTabs) { click(h, tab.label); assert.equal(h.routes.at(-1), tab.route); }
  h.nodes().find(n => n.type === 'Provider').props.value.startAppointment({ id: 'customer' });
  assert.equal(h.routes.at(-1).pathname, '/appointments'); assert.equal(h.routes.at(-1).params.customer, 'token');
  click(h, 'Manager Name · Open account menu');
  assert.ok(h.nodes().find(n => n.type === 'Modal').props.visible);
  assert.ok(h.nodes().some(n => n.props?.testID === 'original-sidebar'));
  assert.ok(h.nodes().some(n => n.type === 'Pressable' && n.props.accessibilityLabel === 'Audit History'));
  h.lockNavigation();
  for (const tab of navigation.managerTabs) assert.equal(h.nodes().find(n => n.type === 'Pressable' && n.props.accessibilityLabel === tab.label).props.disabled, true);
  const count = h.routes.length;
  h.nodes().find(n => n.type === 'Provider').props.value.startAppointment({ id: 'customer' }); assert.equal(h.routes.length, count);
  h.dispose();
});
test('UI01 actual shell follows effective PIN role rather than account business role', () => {
  const h = shell('staff'); h.context.business.role = 'owner'; h.render();
  assert.equal(h.nodes().filter(n => n.type === 'Pressable' && n.props.accessibilityRole === 'tab').length, 3);
  for (const tab of navigation.employeeTabs) { click(h, tab.label); assert.equal(h.routes.at(-1), tab.route); }
  assert.ok(!h.nodes().some(n => n.type === 'Pressable' && n.props.accessibilityLabel === 'Reports'));
  h.context.managementRole = 'owner'; h.render(); assert.ok(h.nodes().some(n => n.type === 'Pressable' && n.props.accessibilityLabel === 'Reports')); h.dispose();
});
test('manager and employee shared headers show only the dynamic business name with approved styling', () => {
  for (const role of ['manager', 'staff']) {
    const h = shell(role);
    h.context.business.name = 'Om Beauty Salon'; h.render();
    const business = h.nodes().find(n => n.type === 'Text' && n.props.children === 'Om Beauty Salon');
    assert.ok(business);
    assert.equal(business.props.style.color, tokens.design.color.textPrimary);
    assert.equal(business.props.style.fontSize, tokens.design.type.section);
    assert.equal(business.props.style.fontWeight, '600');
    const header = h.nodes().find(n => n.type === 'View' && n.props.style?.minHeight === 76);
    assert.ok(header); assert.equal(header.props.children[0].props.children, 'Om Beauty Salon');
    assert.equal(header.props.style.paddingHorizontal, tokens.design.space.xl);
    assert.ok(!h.nodes().some(n => n.type === 'OriginalBrand' || n.type === 'Image'));
    h.context.business.name = 'Another Business'; h.render();
    assert.ok(h.text().includes('Another Business')); assert.ok(!h.text().includes('Om Beauty Salon'));
    assert.ok(h.nodes().some(n => n.props?.accessibilityLabel === 'Manager Name · Open account menu'));
    assert.ok(h.nodes().some(n => n.props?.accessibilityLabel === 'Switch User'));
    h.dispose();
  }
});
test('UI01 controls expose pressed, selected, keyboard focus and disabled states', () => {
  const h = shell();
  let tab = h.nodes().find(n => n.type === 'Pressable' && n.props.accessibilityLabel === 'Today');
  assert.equal(tab.props.accessibilityState.selected, true);
  assert.ok(tab.props.style({ pressed: true }).some(s => s?.backgroundColor === tokens.design.color.surfaceSubtle));
  tab.props.onFocus(); h.render(); tab = h.nodes().find(n => n.type === 'Pressable' && n.props.accessibilityLabel === 'Today');
  assert.ok(tab.props.style({ pressed: false }).some(s => s?.borderColor === tokens.design.color.focus));
  h.lockNavigation(); assert.ok(h.nodes().find(n => n.type === 'Pressable' && n.props.accessibilityLabel === 'Today').props.accessibilityState.disabled); h.dispose();
});
