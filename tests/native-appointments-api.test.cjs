const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const S = '33333333-3333-4333-8333-333333333333';
const C = '44444444-4444-4444-8444-444444444444';
const P = '55555555-5555-4555-8555-555555555555';
const date = '2026-09-28';
function harness(options = {}) {
  const calls = [], queries = [], logs = [];
  let authenticated = false, privileged = 0;
  const tables = {
    business_members: [{ business_id: A, user_id: 'member', role: 'staff' }],
    businesses: [{ id: A, name: 'Business', timezone: 'Pacific/Auckland' }],
    customers: [{ id: C, business_id: A, full_name: 'Phone-less', phone: null, is_active: true }, { id: B, business_id: B, full_name: 'Other tenant', is_active: true }],
    services: [{ id: S, business_id: A, name: 'Service', duration_minutes: 45, is_active: true }, { id: B, business_id: B, name: 'Other', duration_minutes: 30, is_active: true }],
    appointments: [{ id: P, business_id: A, customer_id: C, service_id: S, appointment_date: date, appointment_time: '09:07:00', status: 'Booked', duration_minutes: 30, notes: null }, { id: B, business_id: B, appointment_date: date }],
    ...options.tables,
  };
  const db = {
    auth: { async getUser(token) { authenticated = token === 'valid'; return { data: { user: authenticated ? { id: 'member' } : null }, error: authenticated ? null : {} }; } },
    from(table) {
      assert.ok(authenticated, 'identity must be verified before any domain read');
      const call = { table, filters: [] }; queries.push(call);
      const query = {
        select(fields) { call.fields = fields.split(/,\s*/); return query; },
        eq(k, v) { call.filters.push([k, v]); return query; },
        order() { return query; },
        range(start, end) { call.range = [start, end]; return query; },
        ilike(k, v) { call.search = [k, v]; return query; },
        async execute(single = false) {
          if (options.dbError === table) return { data: null, error: { message: 'private-provider-detail' } };
          let rows = tables[table].filter(r => call.filters.every(([k,v]) => r[k] === v));
          if (call.range) rows = rows.slice(call.range[0], call.range[1] + 1);
          rows = rows.map(row => Object.fromEntries(call.fields.map(k => [k, row[k]])));
          return { data: single ? rows[0] ?? null : rows, error: null };
        },
        maybeSingle() { return query.execute(true); }, then(resolve, reject) { return query.execute().then(resolve, reject); },
      }; return query;
    },
    rpc: (name, args) => rpc('member', name, args),
  };
  async function rpc(role, name, args) {
    calls.push({ role, name, args });
    assert.equal(args.p_business_id, A);
    if (options.rpc) return options.rpc(name, args);
    const free = args.p_appointment_time === '09:00:00' || (name === 'check_reschedule_appointment_business' && args.p_appointment_time === '09:07:00');
    return { data: { code: free ? 'AVAILABLE' : 'SLOT_CONFLICT', available: free, success: free, duration_minutes: 45, service_id: args.p_service_id, date: args.p_appointment_date, time: args.p_appointment_time }, error: null };
  }
  const cache = new Map();
  function load(file) {
    file = path.resolve(file); if (cache.has(file)) return cache.get(file);
    const exports = {}; cache.set(file, exports);
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
      exports, Request, Response, URL,
      console: { error: (...args) => logs.push(args) },
      process: { env: { NEXT_PUBLIC_SUPABASE_URL: 'https://fixture.invalid', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fixture' } },
      require(name) {
        if (name === '@supabase/supabase-js') return { createClient: () => db };
        if (name === '@/lib/appointment-actions') return { isUuid: value => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value) };
        if (name === '@/lib/supabase-server') return { createSupabaseServiceClient() { privileged++; assert.ok(authenticated); return { rpc: (name, args) => rpc('service', name, args) }; } };
        return load(name.startsWith('@/') ? name.slice(2)+'.ts' : path.resolve(path.dirname(file),name+'.ts'));
      },
    }); return exports;
  }
  return { calls, queries, logs, get privileged() { return privileged; }, async call(kind, query = '', token = 'valid', business = A) {
    const headers = { 'x-anaai-business-id': business }; if (token) headers.authorization = `Bearer ${token}`;
    const response = await load('server/handlers/appointment-reads.ts')[kind](new Request(`https://api.invalid/api/test${query}`, { headers }));
    return { status: response.status, body: await response.json(), headers: response.headers };
  } };
}
for (const kind of ['DAY', 'CUSTOMERS', 'SERVICES', 'AVAILABILITY']) {
  for (const token of [null, 'invalid']) test(`${kind}: rejects missing/invalid authentication (${token})`, async () => {
    const h = harness(); assert.equal((await h.call(kind, '', token)).status, 401); assert.equal(h.queries.length, 0); assert.equal(h.privileged, 0);
  });
  test(`${kind}: forged business selection is not authorization`, async () => {
    const h = harness(); assert.equal((await h.call(kind, '', 'valid', B)).status, 403); assert.equal(h.calls.length, 0); assert.equal(h.privileged, 0);
  });
  test(`${kind}: rejects client identity/query overrides`, async () => {
    const h = harness(); assert.equal((await h.call(kind, '?business_id='+B)).status, 400);
  });
}
test('day reads only selected tenant/date and retains duration snapshot', async () => {
  const h = harness(); const r = await h.call('DAY', '?date='+date);
  assert.equal(r.status, 200); assert.equal(r.body.appointments.length, 1); assert.equal(r.body.appointments[0].id, P);
  assert.equal(r.body.appointments[0].duration_minutes, 30); assert.equal(r.headers.get('cache-control'), 'no-store');
});
for (const value of ['2026-02-29','2026-09-31','2026-9-28',`${date}&date=${date}`]) test(`invalid/duplicate date rejected: ${value}`, async () => {
  assert.equal((await harness().call('DAY', '?date='+value)).status, 400);
});
test('customer/service reads exclude other tenants and expose minimal fields', async () => {
  const h = harness(); const c = (await h.call('CUSTOMERS')).body.customers; const s = (await h.call('SERVICES')).body.services;
  assert.deepEqual(c, [{id:C,full_name:'Phone-less',phone:null}]); assert.equal(s.length,1); assert.equal(s[0].id,S);
});
test('customer search escapes LIKE patterns, never interpolates filter syntax', async () => {
  const h = harness(); await h.call('CUSTOMERS','?q='+encodeURIComponent('a%_\\'));
  assert.deepEqual(h.queries.at(-1).search,['full_name','%a\\%\\_\\\\%']);
});
test('new-booking availability uses existing authority for every offered slot', async () => {
  const h = harness(); const r = await h.call('AVAILABILITY',`?date=${date}&serviceId=${S}`);
  assert.equal(r.status,200); assert.deepEqual(r.body.slots,['09:00:00']); assert.equal(r.body.durationMinutes,45);
  assert.equal(h.calls.length,96); assert.ok(h.calls.every(c=>c.name==='voice_check_appointment_availability' && c.role==='service'));
  assert.ok(h.calls.every(c=>!('p_appointment_id' in c.args)));
});
test('reschedule preserves references and invokes authenticated check-only wrapper including non-grid original time', async () => {
  const h = harness(); const r = await h.call('AVAILABILITY',`?date=${date}&serviceId=${S}&appointmentId=${P}`);
  assert.equal(r.status,200); assert.deepEqual(r.body.slots,['09:00:00','09:07:00']); assert.equal(h.privileged,0);
  assert.equal(h.calls.length,97); assert.ok(h.calls.every(c=>c.role==='member' && c.name==='check_reschedule_appointment_business' && c.args.p_appointment_id===P && c.args.p_customer_id===C));
});
for (const suffix of [`&appointmentId=${B}`,`&appointmentId=invalid`]) test(`invalid/cross-tenant appointment never reaches RPC: ${suffix}`, async () => {
  const h = harness(); const r = await h.call('AVAILABILITY',`?date=${date}&serviceId=${S}${suffix}`);
  assert.ok([400,404].includes(r.status)); assert.equal(h.calls.length,0); assert.equal(h.privileged,0);
});
test('cross-tenant service never reaches privileged checker', async () => {
  const h = harness(); assert.equal((await h.call('AVAILABILITY',`?date=${date}&serviceId=${B}`)).body.code,'INVALID_SERVICE'); assert.equal(h.privileged,0);
});
for (const code of ['CLOSED','SLOT_CONFLICT','INVALID_EXISTING_SCHEDULE','INVALID_HOURS','private-detail']) test(`availability fail-closed mapping ${code}`, async () => {
  const h = harness({ rpc: async()=>({data:{code,available:false,success:false}}) });
  const r = await h.call('AVAILABILITY',`?date=${date}&serviceId=${S}`);
  if (['CLOSED','SLOT_CONFLICT'].includes(code)) { assert.equal(r.status,200); assert.deepEqual(r.body.slots,[]); assert.equal(r.body.code,code==='CLOSED'?'CLOSED':'NO_AVAILABILITY'); }
  else { assert.ok(r.status>=400); assert.equal(r.body.slots,undefined); }
  assert.ok(!JSON.stringify(r).includes('private-detail'));
});
test('provider failure returns safe typed error without provider details', async () => {
  const h = harness({dbError:'appointments'}); const r=await h.call('DAY','?date='+date);
  assert.equal(r.status,503); assert.equal(r.body.code,'SERVICE_UNAVAILABLE'); assert.ok(!JSON.stringify([r,h.logs]).includes('private-provider-detail'));
});
for (const mismatch of [{duration_minutes:0},{service_id:B},{date:'2026-09-29'},{time:'10:00:00'}]) test(`availability refuses mismatched SQL success: ${Object.keys(mismatch)[0]}`,async()=>{
  const h=harness({rpc:async(_name,args)=>({data:{available:true,success:true,code:'AVAILABLE',duration_minutes:45,service_id:S,date,time:args.p_appointment_time,...mismatch}})});
  const r=await h.call('AVAILABILITY',`?date=${date}&serviceId=${S}`);assert.equal(r.status,503);assert.equal(r.body.slots,undefined);
});
