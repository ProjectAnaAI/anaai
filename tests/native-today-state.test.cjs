const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const base = 'apps/zude-mobile/src/features/today/';

// Minimal deterministic hook lifecycle driver: state and effects execute the
// real hook, while requests, wall clock and AppState are controlled by the test.
function harness() {
  const states = [], effects = [], requests = [];
  let cursor = 0, effectCursor = 0, active, tick, now = '2026-09-28T02:00:00Z';
  let context = { userId: 'user', business: { id: 'a', timezone: 'America/Los_Angeles' } };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } }
  function load(file, imports) {
    const exports = {};
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, {
      exports, Date: Clock, Intl, AbortController,
      setInterval(fn) { tick = fn; return 1; }, clearInterval() { tick = undefined; },
      require(name) { if (Object.hasOwn(imports, name)) return imports[name]; throw Error(name); },
    });
    return exports;
  }
  const data = load(base + 'todayData.ts', {});
  const { useTodayAppointments } = load(base + 'useTodayAppointments.ts', {
    react: {
      useState(initial) {
        const i = cursor++;
        if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial;
        return [states[i], next => { states[i] = typeof next === 'function' ? next(states[i]) : next; }];
      },
      useEffect(fn, deps) {
        const i = effectCursor++, old = effects[i];
        if (!old || deps.some((dep, j) => !Object.is(dep, old.deps[j]))) effects[i] = { fn, deps, cleanup: old?.cleanup, pending: true };
      },
    },
    'react-native': { AppState: { addEventListener(event, fn) { active = fn; return { remove() { active = undefined; } }; } } },
    '../../lib/today-api': { getTodayAppointments(businessId, date, signal) {
      return new Promise((resolve, reject) => requests.push({ businessId, date, signal, resolve, reject }));
    } },
    '../business/BusinessContext': { useBusiness: () => context },
    './todayData': data,
  });
  return {
    requests,
    context(value) { context = value; },
    time(value) { now = value; },
    active() { active('active'); }, tick() { tick(); },
    render() {
      cursor = 0; effectCursor = 0;
      const result = useTodayAppointments();
      for (const effect of effects) if (effect.pending) {
        effect.cleanup?.(); effect.cleanup = effect.fn(); effect.pending = false;
      }
      return result;
    },
    unmount() { for (const effect of effects) effect.cleanup?.(); },
  };
}
const row = { id: 'one', customer_name: 'Customer', service: 'Original service', appointment_time: '09:00:00', duration_minutes: 45, status: 'Confirmed' };
const flush = () => new Promise(resolve => setImmediate(resolve));

test('Today uses business-local day and preserves appointment duration snapshot', async () => {
  const h = harness(); assert.equal(h.render().status, 'loading');
  assert.equal(h.requests[0].date, '2026-09-27');
  assert.equal(h.requests[0].businessId, 'a');
  h.requests[0].resolve([row]); await flush();
  const result = h.render(); assert.equal(result.status, 'success');
  assert.equal(result.appointments[0].duration, 45); assert.equal(result.appointments[0].start, 540);
});

test('tenant switch hides prior data immediately and aborts old request', async () => {
  const h = harness(); h.render(); h.requests[0].resolve([row]); await flush();
  assert.equal(h.render().appointments.length, 1);
  h.context({ userId: 'user', business: { id: 'b', timezone: 'Pacific/Auckland' } });
  const result = h.render(); assert.equal(result.status, 'loading'); assert.equal(result.appointments.length, 0);
  assert.equal(h.requests[0].signal.aborted, true);
  assert.equal(h.requests[1].businessId, 'b'); assert.equal(h.requests[1].date, '2026-09-28');
});

test('late response from old tenant cannot replace the selected tenant', async () => {
  const h = harness(); h.render();
  h.context({ userId: 'user', business: { id: 'b', timezone: 'UTC' } }); h.render();
  h.requests[1].resolve([{ ...row, id: 'new' }]); await flush();
  h.requests[0].resolve([{ ...row, id: 'old' }]); await flush();
  assert.equal(h.render().appointments[0].id, 'new');
});

test('error and retry preserve real-data states without fixtures', async () => {
  const h = harness(); h.render(); h.requests[0].reject(Error('network')); await flush();
  const failure = h.render(); assert.equal(failure.status, 'error'); assert.equal(failure.appointments.length, 0);
  failure.retry(); assert.equal(h.render().status, 'loading');
  h.requests[1].resolve([]); await flush(); assert.equal(h.render().status, 'success');
});

test('foreground refresh and local midnight both trigger a new scoped request', async () => {
  const h = harness(); h.render(); h.active(); h.render(); assert.equal(h.requests.length, 2);
  h.time('2026-09-28T07:00:01Z'); h.tick(); h.render();
  assert.equal(h.requests.at(-1).date, '2026-09-28');
  assert.equal(h.requests[1].signal.aborted, true);
});

test('invalid timezone fails closed and does not request a guessed date', () => {
  const h = harness(); h.context({ userId: 'user', business: { id: 'a', timezone: 'Invalid/Zone' } });
  assert.equal(h.render().status, 'error'); assert.equal(h.requests.length, 0);
});

test('unmount cancels outstanding request', () => {
  const h = harness(); h.render(); h.unmount(); assert.equal(h.requests[0].signal.aborted, true);
});
