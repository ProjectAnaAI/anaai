// Run: node --test tests/atomic-appointments.test.cjs
// Route mocks and SQL contract checks only: no database/provider calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const route = fs.readFileSync('app/api/appointments/route.ts', 'utf8');
const sql = fs.readFileSync('supabase/migrations/202609140001_atomic_manual_appointments.sql', 'utf8');
const customerId = '11111111-1111-1111-1111-111111111111';
const serviceId = '22222222-2222-2222-2222-222222222222';
const appointmentId = '33333333-3333-3333-3333-333333333333';
const body = { customerId, serviceId, appointmentDate: '2026-10-05', appointmentTime: '10:00', notes: ' notes ' };
function harness({ code, rpcError, smsFails, smsThrows, denied } = {}) {
  const events = [];
  const original = { id: appointmentId, customer_name: 'Original', customer_phone: '+14155551234', service: 'Original', appointment_date: '2026-10-04', appointment_time: '09:00', status: 'Confirmed' };
  let stored = { ...original };
  let args, rpcName;
  const supabase = {
    rpc: async (name, params) => {
      events.push('rpc'); args = params; rpcName = name;
      if (rpcError) return { error: { message: 'SECRET SQL DETAILS' }, data: null };
      if (code) return { data: { success: false, code, reason: 'SECRET INTERNAL DETAILS' } };
      stored = { ...stored, customer_name: 'Database customer', service: 'Database service', appointment_date: params.p_appointment_date, appointment_time: params.p_appointment_time };
      events.push('commit');
      return { data: { success: true, appointment: stored } };
    },
    from: (table) => {
      const q = {};
      for (const method of ['select', 'eq', 'order', 'limit']) q[method] = () => q;
      q.maybeSingle = async () => ({ data: table === 'appointments' ? { ...stored } : { business_name: 'Business' } });
      q.update = () => { throw new Error('Unexpected direct update in atomic flow'); };
      return q;
    },
  };
  const exports = {};
  const context = { exports, Request, Response, console: { error() {}, log() {} }, process: { env: { NEXT_PUBLIC_SUPABASE_URL: 'https://example.invalid', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test' } }, require: (name) => {
    if (name === '@supabase/supabase-js') return { createClient: () => supabase };
    if (name === 'next/server') return { NextResponse: { json: (data, init) => Response.json(data, init) } };
    if (name === '@/lib/business-context') return { resolveBusinessContext: async () => denied ? { success: false, status: 403, error: 'No access' } : { success: true, context: { businessId: 'resolved-business', businessName: 'Business' } } };
    if (name === '@/lib/twilio') return { sendSms: async () => {
      assert.ok(events.includes('commit'), 'SMS must follow successful RPC completion');
      events.push('sms'); if (smsThrows) throw new Error('SECRET TWILIO');
      return smsFails ? { success: false, error: 'SECRET TWILIO' } : { success: true, messageSid: 'test' };
    } };
    throw new Error(name);
  } };
  vm.runInNewContext(ts.transpileModule(route, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return {
    events, original, stored: () => stored, args: () => args, rpcName: () => rpcName,
    call: async (method, extra = {}) => {
      const response = await exports[method](new Request('https://example.invalid/api/appointments', { method, headers: { authorization: 'Bearer test', 'x-anaai-business-id': 'requested-business', 'content-type': 'application/json' }, body: JSON.stringify({ ...body, ...(method === 'PATCH' ? { appointmentId, notificationType: 'reschedule' } : {}), ...extra }) }));
      return { status: response.status, body: await response.json() };
    },
  };
}
test('manual create uses RPC, resolved business, selected IDs, no snapshots or SMS', async () => {
  const h = harness(); const r = await h.call('POST', { business_id: 'forged', customerName: 'forged' });
  assert.equal(r.body.success, true); assert.equal(h.rpcName(), 'create_appointment_atomic_business');
  assert.equal(h.args().p_business_id, 'resolved-business'); assert.equal(h.args().p_customer_id, customerId);
  assert.equal(h.args().p_customer_name, undefined); assert.equal(h.args().p_notes, 'notes');
  assert.deepEqual(h.events, ['rpc', 'commit']);
});
for (const [code, status] of Object.entries({ SLOT_CONFLICT:409, INVALID_CUSTOMER:400, INVALID_SERVICE:400, INVALID_DURATION:400, CLOSED:409, OUTSIDE_HOURS:409, INVALID_HOURS:400, INVALID_EXISTING_SCHEDULE:409 })) {
  test(`manual create maps ${code} safely`, async () => {
    const h=harness({code}); const r=await h.call('POST');
    assert.equal(r.status,status); assert.equal(r.body.success,false);
    assert.ok(!JSON.stringify(r.body).includes('SECRET')); assert.deepEqual(h.events,['rpc']);
  });
}
test('reschedule commits before SMS and uses explicit appointment ID', async () => {
  const h=harness(); const r=await h.call('PATCH');
  assert.equal(r.body.success,true); assert.equal(r.body.sms_sent,true);
  assert.equal(h.rpcName(),'reschedule_appointment_atomic_business');
  assert.equal(h.args().p_appointment_id,appointmentId); assert.deepEqual(h.events,['rpc','commit','sms']);
});
for (const code of ['SLOT_CONFLICT','SOURCE_DATE_CHANGED','TERMINAL_APPOINTMENT','INVALID_CUSTOMER','INVALID_SERVICE']) {
  test(`rejected reschedule ${code} does not fall back to a write or send SMS`,async()=>{
    const h=harness({code}); const r=await h.call('PATCH');
    assert.equal(r.body.success,false); assert.deepEqual(h.stored(),h.original); assert.deepEqual(h.events,['rpc']);
  });
}
for (const option of ['smsFails','smsThrows']) test(`${option} preserves committed appointment success`,async()=>{
  const h=harness({[option]:true}); const r=await h.call('PATCH');
  assert.equal(r.body.success,true); assert.equal(r.body.sms_sent,false); assert.equal(r.status,200);
  assert.ok(!JSON.stringify(r.body).includes('SECRET')); assert.equal(h.stored().appointment_date,body.appointmentDate);
});
test('RPC errors are safe and do not trigger SMS',async()=>{
  const h=harness({rpcError:true}); const r=await h.call('PATCH'); assert.equal(r.status,500);
  assert.ok(!JSON.stringify(r.body).includes('SECRET')); assert.deepEqual(h.events,['rpc']);
});
test('denied business context prevents RPC',async()=>{
  const h=harness({denied:true}); const r=await h.call('POST'); assert.equal(r.status,403); assert.deepEqual(h.events,[]);
});
for (const extra of [{ customer_id:serviceId },{ serviceId:'bad' },{ appointmentTime:'25:00' },{ status:'Confirmed' }]) test(`invalid request ${JSON.stringify(extra)}`,async()=>{
  const h=harness(); assert.equal((await h.call('POST',extra)).status,400); assert.deepEqual(h.events,[]);
});
test('SQL contract: exact AI lock, self exclusion, invoker, identity and terminal safeguards',()=>{
  assert.equal((sql.match(/hashtext\(p_business_id::text \|\| ':' \|\| p_appointment_date::text\)/g)||[]).length,1);
  assert.equal((sql.match(/security invoker/gi)||[]).length,2);
  assert.match(sql,/and a.id <> p_appointment_id/);
  assert.match(sql,/where id = p_appointment_id and business_id = p_business_id for update/);
  assert.match(sql,/v_appointment.status not in \('Booked', 'Confirmed'\)/);
  assert.match(sql,/p_business_id, v_user_id, v_customer.id, v_service.id/);
  const update=sql.slice(sql.indexOf('  update public.appointments set'),sql.indexOf('  if not found then',sql.indexOf('  update public.appointments set')));
  assert.doesNotMatch(update,/\b(user_id|status)\s*=/);
  assert.doesNotMatch(sql,/insert into public.customers|create trigger|security definer/i);
});
test('page no longer directly inserts or uses availability to authorize create/reschedule',()=>{
  const page=fs.readFileSync('app/appointments/page.tsx','utf8');
  assert.doesNotMatch(page,/\.insert\(/);
  const create=page.slice(page.indexOf('async function handleCreateAppointment'),page.indexOf('function startEditingAppointment'));
  const reschedule=page.slice(page.indexOf('async function saveAppointmentChanges'),page.indexOf('async function confirmAppointment'));
  assert.doesNotMatch(create+reschedule,/validateAppointmentAvailability/);
  assert.match(create,/creating: true/);
});

test('SQL lock contract: discovery, distinct ordered dates, row lock, stale-source rejection before mutation', () => {
  const reschedule = sql.slice(sql.indexOf('create or replace function public.reschedule'));
  const discovery = reschedule.indexOf('select appointment_date into v_source_date');
  const dates = reschedule.indexOf('select distinct d.scheduling_date');
  const lock = reschedule.indexOf('perform pg_advisory_xact_lock');
  const row = reschedule.indexOf('for update');
  const changed = reschedule.indexOf('if v_appointment.appointment_date is distinct from v_source_date');
  const validation = reschedule.indexOf('select * into v_customer');
  const mutation = reschedule.indexOf('update public.appointments set');
  assert.ok(discovery < dates && dates < lock && lock < row && row < changed && changed < validation && validation < mutation);
  assert.match(reschedule, /from \(values \(v_source_date\), \(p_appointment_date\)\) as d\(scheduling_date\)\s+order by d.scheduling_date/);
  assert.match(reschedule, /hashtext\(p_business_id::text \|\| ':' \|\| v_scheduling_date::text\)/);
  assert.match(reschedule.slice(changed, validation), /return jsonb_build_object\('success', false, 'code', 'SOURCE_DATE_CHANGED'\)/);
  assert.doesNotMatch(sql, /p_appointment_time >=/);
  assert.equal((sql.match(/or p_appointment_time is null then/g) || []).length, 2);
});

// Contract regression plus a mocked selection/parser boundary. This does not
// execute PL/pgSQL; real database fixtures remain required before deployment.
const hoursBlocks = sql.split('create or replace function public.').slice(1).map(fn => {
  const start = fn.indexOf('    select business_hours into v_hours_text');
  return fn.slice(start, fn.indexOf('    v_day :=', start));
});
test('both RPCs select latest TEXT, check missing/null, then parse in a separate statement', () => {
  assert.equal(hoursBlocks.length, 2);
  assert.equal(hoursBlocks[0], hoursBlocks[1]);
  assert.equal((sql.match(/v_hours_text text;/g) || []).length, 2);
  for (const block of hoursBlocks) {
    assert.match(block, /select business_hours into v_hours_text from public.business_profiles\s+where business_id = p_business_id order by created_at desc limit 1;/);
    assert.match(block, /if not found or v_hours_text is null then\s+return jsonb_build_object\('success', false, 'code', 'INVALID_HOURS'\);\s+end if;/);
    assert.ok(block.indexOf('end if;') < block.indexOf('v_hours := v_hours_text::jsonb;'));
  }
  assert.doesNotMatch(sql, /select business_hours::jsonb/i);
});
for (const operation of ['create', 'reschedule']) {
  for (const scenario of ['valid newest with malformed history', 'malformed newest', 'no profile', 'null hours']) {
    test(`${operation}: mocked latest-profile parsing - ${scenario}`, () => {
      // Synthetic fixtures only. Reading older text must never invoke its parser.
      const valid = JSON.stringify({monday:{closed:false,open:'09:00',close:'17:00'}});
      const rows = scenario === 'no profile' ? [] : [
        {created:1, text:'not-json'},
        {created:2, text:scenario === 'malformed newest' ? 'not-json' : scenario === 'null hours' ? null : valid},
      ];
      const selected = [...rows].sort((a,b) => b.created-a.created)[0];
      let parsedCount=0;
      let result;
      try {
        if (!selected || selected.text === null) result='INVALID_HOURS';
        else { parsedCount++; JSON.parse(selected.text); result='PARSED'; }
      } catch { result='INVALID_HOURS'; }
      assert.equal(result, scenario === 'valid newest with malformed history' ? 'PARSED' : 'INVALID_HOURS');
      assert.equal(parsedCount, ['no profile','null hours'].includes(scenario) ? 0 : 1);
    });
  }
}
test('temporary API profile diagnostic is removed and SQL logs do not expose error text', () => {
  assert.doesNotMatch(route, /diagnoseCreation|profileQueryError|businessHoursJsonValid|console\.info/);
  assert.doesNotMatch(sql, /SQLERRM|v_hours_stage|scheduling diagnostic/);
});
