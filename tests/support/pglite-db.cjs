// Real PostgreSQL (PGlite, WASM) for M04/M05/M06 SQL tests. Never a hosted
// database. PGlite is not a project dependency: point ZUDE_PGLITE_MODULE at an
// installed copy (…/@electric-sql/pglite/dist/index.cjs) or install it
// locally; otherwise the SQL suites are skipped and say so.
const fs = require('node:fs');
const path = require('node:path');

function loadPGlite() {
  try { return require(process.env.ZUDE_PGLITE_MODULE || '@electric-sql/pglite'); } catch { return null; }
}
const migrations = path.join(__dirname, '..', '..', 'supabase', 'migrations');
// Minimal stand-ins for the Supabase objects the migrations reference, with
// Supabase's default grants (and service_role's BYPASSRLS) (every new public table/function is granted to
// anon, authenticated and service_role) so the migrations' revokes are
// exercised for real.
const BOOT = `
  create role anon; create role authenticated; create role service_role bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  create schema auth; create table auth.users (id uuid primary key);
  create table public.businesses (id uuid primary key, name text not null, timezone text not null default 'UTC');
  create table public.business_members (business_id uuid not null references public.businesses(id) on delete cascade, user_id uuid not null, role text not null);
`;
// PostgREST-shaped values: ISO timestamps (microseconds kept), int8 as number,
// dates as YYYY-MM-DD.
const iso = (text) => text.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00');
async function openDatabase(lib, { m06 = true } = {}) {
  const db = new lib.PGlite({ parsers: { 1184: iso, 20: Number, 1082: (text) => text } });
  await db.exec(`set timezone = 'UTC';` + BOOT);
  await db.exec(fs.readFileSync(path.join(migrations, '202609290001_m04_team_device_identity.sql'), 'utf8'));
  await db.exec(fs.readFileSync(path.join(migrations, '202610010001_m05_time_clock.sql'), 'utf8'));
  if (m06) await db.exec(fs.readFileSync(path.join(migrations, '202610020001_m06_management_authority_audit.sql'), 'utf8'));
  if (m06) await db.exec(fs.readFileSync(path.join(migrations, '202610050001_m06_time_corrections.sql'), 'utf8'));
  if (m06) await db.exec(fs.readFileSync(path.join(migrations, '202610050002_m06_ledger_read_versions.sql'), 'utf8'));
  await db.exec(fs.readFileSync(path.join(migrations, '202610060001_m05_employee_generation.sql'), 'utf8'));
  if (m06) await db.exec(fs.readFileSync(path.join(migrations, '202610060002_m06_issue_resolutions.sql'), 'utf8'));
  if (m06) await db.exec(fs.readFileSync(path.join(migrations, '202610060003_m06_audit_history.sql'), 'utf8'));
  if (m06) await db.exec(fs.readFileSync(path.join(migrations, '202610060004_m06_time_reports.sql'), 'utf8'));
  return db;
}
// Runs one statement as a role (default service_role), like the server's
// service client. Each call is its own transaction.
async function as(db, role, sql, params = []) {
  return db.transaction(async (tx) => {
    if (role) await tx.exec(`set local role ${role}`);
    return tx.query(sql, params);
  });
}
const failure = (error) => ({ data: null, error: { code: error.code, message: error.message, details: error.detail ?? null } });
const ident = (name) => { if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error('Unsafe identifier ' + name); return `"${name}"`; };
const columns = (fields) => fields.trim() === '*' ? '*' : fields.split(',').map((field) => ident(field.trim())).join(', ');

// The subset of the supabase-js query builder the server handlers use,
// translated to parameterized SQL and run as service_role.
function serviceClient(db, role = 'service_role') {
  return {
    from(table) {
      let op = 'select', fields = '*', values = null, single = null, limit = null, offset = 0, exactCount = false;
      const where = [], params = [], orders = [];
      const param = (value) => { params.push(value); return '$' + params.length; };
      const q = {
        select(value = '*', options = {}) { fields = value; exactCount = options.count === 'exact'; return q; },
        insert(value) { op = 'insert'; values = value; return q; },
        update(value) { op = 'update'; values = value; return q; },
        eq(key, value) { where.push(`${ident(key)} = ${param(value)}`); return q; },
        lt(key, value) { where.push(`${ident(key)} < ${param(value)}`); return q; },
        lte(key, value) { where.push(`${ident(key)} <= ${param(value)}`); return q; },
        gt(key, value) { where.push(`${ident(key)} > ${param(value)}`); return q; },
        gte(key, value) { where.push(`${ident(key)} >= ${param(value)}`); return q; },
        is(key, value) { if (value !== null) throw new Error('is() supports null only'); where.push(`${ident(key)} is null`); return q; },
        order(key, options = {}) { orders.push(`${ident(key)} ${options.ascending === false ? 'desc' : 'asc'}`); return q; },
        limit(value) { limit = value; return q; },
        range(from, to) { offset = from; limit = to - from + 1; return q; },
        maybeSingle() { single = 'maybe'; return q; },
        single() { single = 'one'; return q; },
        then(resolve, reject) { return run().then(resolve, reject); },
      };
      async function run() {
        const filter = where.length ? ` where ${where.join(' and ')}` : '';
        let sql;
        if (op === 'insert') {
          const keys = Object.keys(values);
          sql = `insert into public.${ident(table)} (${keys.map(ident).join(', ')}) values (${keys.map((key) => param(values[key])).join(', ')}) returning ${columns(fields)}`;
        } else if (op === 'update') {
          const sets = Object.keys(values).map((key) => `${ident(key)} = ${param(values[key])}`);
          sql = `update public.${ident(table)} set ${sets.join(', ')}${filter} returning ${columns(fields)}`;
        } else {
          sql = `select ${columns(fields)}${exactCount ? ', count(*) over()::integer as __count' : ''} from public.${ident(table)}${filter}${orders.length ? ' order by ' + orders.join(', ') : ''}${limit === null ? '' : ` limit ${Number(limit)} offset ${Number(offset)}`}`;
        }
        let rows;
        try { rows = (await as(db, role, sql, params)).rows; } catch (error) { return failure(error); }
        const count = exactCount ? (rows[0]?.__count ?? 0) : undefined;
        if (exactCount) rows = rows.map(row => { const clean = { ...row }; delete clean.__count; return clean; });
        if (!single) return { data: rows, error: null, ...(exactCount ? { count } : {}) };
        if (rows.length > 1 || (single === 'one' && rows.length === 0)) return { data: null, error: { code: 'PGRST116', message: 'Not a single row' } };
        return { data: rows[0] ?? null, error: null };
      }
      return q;
    },
    async rpc(name, args) {
      const keys = Object.keys(args);
      try {
        const result = await as(db, role, `select public.${ident(name)}(${keys.map((key, index) => `${ident(key)} => $${index + 1}`).join(', ')}) as result`, keys.map((key) => args[key]));
        return { data: result.rows[0].result, error: null };
      } catch (error) { return failure(error); }
    },
  };
}
module.exports = { loadPGlite, openDatabase, serviceClient, as };
