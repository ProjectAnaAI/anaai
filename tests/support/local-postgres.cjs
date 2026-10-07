// Real PostgreSQL + PostgREST harness for the M06 release gate. LOCAL ONLY:
// targets the disposable Supabase stack built by scripts/local-db-bootstrap.sh
// and refuses anything that is not provably that stack. Synthetic data only;
// credentials come from `supabase status` at runtime and are never printed.
// `pg` is not a project dependency: point ZUDE_PG_MODULE at an installed copy.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..', '..');
const uuid = () => crypto.randomUUID();
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function loadPg() {
  try { return require(process.env.ZUDE_PG_MODULE || 'pg'); } catch { return null; }
}
const projectId = () => fs.readFileSync(path.join(ROOT, 'supabase/config.toml'), 'utf8').match(/^project_id\s*=\s*"([^"]+)"/m)?.[1];
const container = () => `supabase_db_${projectId()}`;
function dockerPsql(sql) {
  return execFileSync('docker', ['exec', container(), 'psql', '-X', '-Atq', '-U', 'postgres', '-d', 'postgres', '-c', sql], { encoding: 'utf8' }).trim();
}

// Proves every endpoint is the local stack, then wires the server env to it.
async function connectLocal() {
  const pg = loadPg();
  assert.ok(pg, 'The real-PostgreSQL gate needs ZUDE_PG_MODULE (an installed `pg` module)');
  const status = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  const api = new URL(status.API_URL), db = new URL(status.DB_URL);
  assert.ok(LOCAL_HOSTS.has(api.hostname) && api.port === '54321', 'API must be the local stack');
  assert.ok(LOCAL_HOSTS.has(db.hostname) && db.port === '54322', 'Database must be local 127.0.0.1:54322');
  for (const value of [status.API_URL, status.DB_URL]) assert.ok(!/supabase\.(co|com)/.test(value), 'Hosted endpoints are forbidden');
  const connection = { host: '127.0.0.1', port: 54322, user: 'postgres', password: decodeURIComponent(db.password), database: 'postgres' };
  const probe = new pg.Client(connection);
  await probe.connect();
  // Same cluster as the bootstrapped container (not merely "something on 54322").
  const tcp = (await probe.query('select system_identifier::text id from pg_control_system()')).rows[0].id;
  assert.equal(tcp, dockerPsql('select system_identifier from pg_control_system()'), 'TCP endpoint is not the local container');
  const versions = (await probe.query('select count(*)::int n, max(version) v from supabase_migrations.schema_migrations')).rows[0];
  assert.equal(versions.v, '202610060004', 'Run scripts/local-db-bootstrap.sh first');
  const serverVersion = (await probe.query('show server_version')).rows[0].server_version;
  await probe.end();
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: status.API_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY: status.ANON_KEY, SUPABASE_SECRET_KEY: status.SERVICE_ROLE_KEY,
  });
  return { pg, connection, api: status.API_URL, anonKey: status.ANON_KEY, serviceKey: status.SERVICE_ROLE_KEY, serverVersion, migrations: versions.n };
}

// Real server modules (no stubs), executed in a vm with the local env.
function loader() {
  const cache = {};
  function load(file) {
    file = path.resolve(ROOT, file);
    if (cache[file]) return cache[file];
    const exports = {}; cache[file] = exports;
    const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    vm.runInNewContext(source, { exports, module: { exports }, process: { env: process.env }, console, Request, Response, Headers, URL, URLSearchParams, Date, Intl, Buffer, TextEncoder, TextDecoder, setTimeout, clearTimeout,
      require(name) {
        if (name.startsWith('@/')) return load(path.join(ROOT, name.slice(2)) + '.ts');
        if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name) + '.ts');
        return require(name);
      } }, { filename: file });
    return exports;
  }
  return load;
}

// Deterministic interleaving between independent PostgREST requests: hooks run
// after a matching response is received and before it is returned to the caller.
function fetchHooks() {
  const original = globalThis.fetch, hooks = [], frozen = new Map();
  let paused = false;
  globalThis.fetch = async (input, init) => {
    let response = await original(input, init);
    const url = String(input instanceof Request ? input.url : input);
    // Negative controls only: replay the first body seen for a frozen route.
    for (const [match, entry] of frozen) if (url.includes(match)) {
      if (entry.body === undefined) { entry.body = await response.text(); entry.status = response.status; entry.headers = [...response.headers]; }
      else await response.arrayBuffer();
      response = new Response(entry.body, { status: entry.status, headers: entry.headers });
    }
    if (!paused) for (const hook of [...hooks]) if (url.includes(hook.match) && hook.remaining > 0) { hook.remaining--; await hook.run(url); }
    return response;
  };
  return {
    after(match, run, times = 1) { const hook = { match, run, remaining: times }; hooks.push(hook); return hook; },
    // Requests made by a hook's own mutation (e.g. a real clock action) never trigger hooks.
    async quietly(fn) { paused = true; try { return await fn(); } finally { paused = false; } },
    freeze(match) { frozen.set(match, {}); },
    clear() { hooks.length = 0; frozen.clear(); },
    restore() { globalThis.fetch = original; },
  };
}

function token() {
  const id = uuid(), value = `${id}.${crypto.randomBytes(32).toString('base64url')}`, salt = crypto.randomBytes(16).toString('base64');
  return { id, value, salt, hash: crypto.createHash('sha256').update(salt).update('\0').update(value).digest('base64') };
}

async function harness() {
  const local = await connectLocal();
  const { pg, connection } = local;
  const clients = [];
  const connect = async () => { const c = new pg.Client(connection); await c.connect(); clients.push(c); return c; };
  const admin = await connect();
  const hooks = fetchHooks();
  const close = async () => { hooks.restore(); await Promise.all(clients.map(c => c.end().catch(() => {}))); };
  const deadlocksAtStart = Number((await admin.query('select deadlocks from pg_stat_database where datname = current_database()')).rows[0].deadlocks);

  async function authUser(label) {
    const email = `m06-${label}-${uuid()}@zude.test`, password = crypto.randomBytes(18).toString('base64url');
    const created = await fetch(`${local.api}/auth/v1/admin/users`, { method: 'POST', headers: { apikey: local.serviceKey, Authorization: `Bearer ${local.serviceKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, email_confirm: true }) });
    assert.equal(created.status, 200, 'local auth user creation');
    const user = await created.json();
    const signIn = await fetch(`${local.api}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: local.anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    assert.equal(signIn.status, 200, 'local auth sign-in');
    return { id: user.id, accessToken: (await signIn.json()).access_token };
  }

  // A synthetic tenant: owner + manager accounts, a registered iPad, employees.
  async function tenant(name = 'Synthetic', timezone = 'UTC') {
    const business = (await admin.query('insert into public.businesses(name, timezone) values ($1, $2) returning id', [`${name} ${uuid().slice(0, 8)}`, timezone])).rows[0].id;
    const owner = await authUser('owner'), manager = await authUser('manager');
    await admin.query("insert into public.business_members(business_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'manager')", [business, owner.id, manager.id]);
    const device = token();
    await admin.query("insert into public.zude_devices(id, business_id, name, credential_hash, credential_salt, updated_at) values ($1, $2, 'Synthetic iPad', $3, $4, now() - interval '1 hour')", [device.id, business, device.hash, device.salt]);
    async function employee({ role = 'employee', name = 'Employee', active = true } = {}) {
      return (await admin.query("insert into public.employees(business_id, display_name, role, is_active, pin_hash, pin_salt, updated_at) values ($1, $2, $3, $4, 'synthetic-hash', 'synthetic-salt', now() - interval '2 hours') returning id", [business, name, role, active])).rows[0].id;
    }
    // A PIN session at the device's current generation.
    async function session(employeeId) {
      const s = token();
      await admin.query("insert into public.employee_sessions(id, business_id, device_id, employee_id, token_hash, token_salt, created_at, expires_at) values ($1, $2, $3, $4, $5, $6, (select updated_at from public.zude_devices where id = $3), now() + interval '4 hours')", [s.id, business, device.id, employeeId, s.hash, s.salt]);
      return { id: s.id, value: s.value };
    }
    // A new successful PIN entry: the device generation advances (invalidating
    // earlier sessions on this iPad) and the new session belongs to it.
    async function pinLogin(employeeId) {
      await admin.query('update public.zude_devices set updated_at = clock_timestamp() where id = $1', [device.id]);
      return session(employeeId);
    }
    async function event(employeeId, type, at, breakType = null) {
      return (await admin.query('insert into public.employee_time_events(business_id, employee_id, device_id, event_type, break_type, occurred_at, request_id) values ($1, $2, $3, $4, $5, $6, $7) returning id, seq', [business, employeeId, device.id, type, breakType, new Date(at).toISOString(), uuid()])).rows[0];
    }
    return { business, owner, manager, device: { id: device.id, value: device.value }, employee, session, pinLogin, event };
  }

  // Polls (no sleeps-as-synchronization) until `count` backends running a
  // statement matching `pattern` are lock-waiting on `holderPid`, directly or
  // through the wait-for chain (later waiters on one row queue behind the first).
  async function blockedBy(holderPid, pattern, count = 1, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const n = Number((await admin.query(`with recursive chain(pid) as (
          select $2::int
          union
          select a.pid from pg_stat_activity a join chain c on c.pid = any(pg_blocking_pids(a.pid)) where a.wait_event_type = 'Lock')
        select count(*) n from pg_stat_activity a where a.pid in (select pid from chain) and a.pid <> $2 and a.query ilike $1`, [`%${pattern}%`, holderPid])).rows[0].n);
      if (n >= count) return n;
      if (Date.now() > deadline) {
        const live = (await admin.query(`select pid, state, wait_event_type, wait_event, pg_blocking_pids(pid) blockers, left(query, 60) q from pg_stat_activity where datname = current_database() and state <> 'idle' and pid <> pg_backend_pid()`)).rows;
        throw new Error(`timed out waiting for ${count} blocked ${pattern} (saw ${n}); holder ${holderPid}; live ${JSON.stringify(live)}`);
      }
      await new Promise(r => setImmediate(r));
    }
  }
  // An open transaction on its own connection.
  async function hold(sql = null, params = []) {
    const c = await connect();
    const pid = (await c.query('select pg_backend_pid() pid')).rows[0].pid;
    await c.query('begin');
    if (sql) await c.query(sql, params);
    return { client: c, pid, query: (q, p) => c.query(q, p), commit: () => c.query('commit'), rollback: () => c.query('rollback') };
  }
  // Direct service_role RPC on an independent connection/transaction.
  async function serviceCall(client, sql, params) {
    await client.query('begin'); await client.query('set local role service_role');
    try { const r = await client.query(sql, params); await client.query('commit'); return r.rows[0]; }
    catch (error) { await client.query('rollback'); throw error; }
  }
  const correctionSql = 'select public.m06_correct_employee_time($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,true,null,null) as r';
  async function ledgerVersion(business, employee) {
    const r = (await admin.query("select coalesce((select max(revision) from public.employee_time_corrections where business_id=$1 and employee_id=$2),0)::int revision, coalesce((select max(seq) from public.employee_time_events where business_id=$1 and employee_id=$2),0)::bigint watermark", [business, employee])).rows[0];
    return { revision: r.revision, watermark: Number(r.watermark) };
  }
  // Owner-account correction committed on its own connection (a second server).
  async function commitCorrection(client, tenantInfo, employee, operations, reason = 'Concurrent correction') {
    const v = await ledgerVersion(tenantInfo.business, employee);
    return (await serviceCall(client, correctionSql, [tenantInfo.business, employee, tenantInfo.owner.id, 'account', 'owner', null, null, null, JSON.stringify(operations), reason, uuid(), v.revision, v.watermark])).r;
  }
  const effective = async (employee) => (await admin.query('select id, seq, event_type, break_type, occurred_at from public.employee_time_effective_events where employee_id = $1 order by seq', [employee])).rows;
  const originals = async (employee) => (await admin.query('select id, seq, event_type, break_type, occurred_at, request_id from public.employee_time_events where employee_id = $1 order by seq', [employee])).rows;

  // Structural invariants for a tenant after any race.
  async function invariants(business) {
    const employees = (await admin.query('select id from public.employees where business_id = $1', [business])).rows.map(r => r.id);
    for (const id of employees) {
      const fold = (await admin.query('select ids, vals, voided from public.m06_time_fold($1, $2)', [business, id])).rows[0];
      const live = (fold.ids ?? []).filter(x => !(fold.voided ?? []).includes(x));
      const rows = await effective(id);
      assert.deepEqual(rows.map(r => r.id), live, 'effective projection = fold of immutable history');
      for (const r of rows) {
        const v = fold.vals[r.id];
        assert.equal(r.event_type, v.event_type); assert.equal(r.break_type, v.break_type);
        assert.equal(r.occurred_at.getTime(), Date.parse(v.occurred_at));
      }
    }
    const q = async (sql) => (await admin.query(sql, [business])).rows;
    assert.deepEqual(await q(`select c.id from public.employee_time_corrections c where c.business_id = $1 and not exists (select 1 from public.employee_time_correction_entries e where e.correction_id = c.id)`), [], 'no correction without entries');
    assert.deepEqual(await q(`select c.id from public.employee_time_corrections c where c.business_id = $1 and (select count(*) from public.employee_management_actions a where a.correction_id = c.id and a.action = 'time.corrected') <> 1`), [], 'exactly one audit per correction');
    assert.deepEqual(await q(`select a.id from public.employee_management_actions a where a.business_id = $1 and a.action = 'time.corrected' and not exists (select 1 from public.employee_time_corrections c where c.id = a.correction_id)`), [], 'no correction audit without correction');
    assert.deepEqual(await q(`select i.id from public.employee_time_issues i where i.business_id = $1 and (i.status = 'resolved') <> exists (select 1 from public.employee_time_issue_resolutions r where r.issue_id = i.id)`), [], 'issue status matches resolution');
    assert.deepEqual(await q(`select r.id from public.employee_time_issue_resolutions r where r.business_id = $1 and not exists (select 1 from public.employee_management_actions a where a.id = r.audit_id and a.action = 'time.issue_resolved' and a.issue_id = r.issue_id)`), [], 'every resolution audited');
    assert.deepEqual(await q(`select a.id from public.employee_management_actions a where a.business_id = $1 and a.action = 'time.issue_resolved' and not exists (select 1 from public.employee_time_issue_resolutions r where r.audit_id = a.id)`), [], 'no resolution audit without resolution');
  }
  async function deadlocks() {
    return Number((await admin.query('select deadlocks from pg_stat_database where datname = current_database()')).rows[0].deadlocks) - deadlocksAtStart;
  }
  return { ...local, admin, connect, close, hooks, load: loader(), tenant, authUser, blockedBy, hold, serviceCall, commitCorrection, ledgerVersion, effective, originals, invariants, deadlocks, correctionSql };
}
module.exports = { harness, loadPg, uuid };
