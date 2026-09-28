// Explicit opt-in, disposable LOCAL Supabase only. No credentials/body logs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const enabled = process.env.ZUDE_RUN_LOCAL_RESCHEDULE_CHECKS === '1';
test('local DB: authenticated check-only exclusion, other conflict, phone-less, tenant isolation, no writes and unchanged mutations', { skip: !enabled }, async () => {
  for (const key of ['ANAAI_TEST_ANON_KEY','ANAAI_TEST_USER_TOKEN','ZUDE_TEST_SERVICE_KEY','ANAAI_TEST_BUSINESS_ID','ZUDE_TEST_APPOINTMENT_ID','ZUDE_TEST_OTHER_APPOINTMENT_ID','ZUDE_TEST_FOREIGN_APPOINTMENT_ID','ZUDE_TEST_FOREIGN_SERVICE_ID','ZUDE_TEST_FOREIGN_BUSINESS_ID']) {
    assert.ok(process.env[key],`Missing fixture setting ${key}`);
  }
  const url = new URL(process.env.ANAAI_LOCAL_SUPABASE_URL || 'http://127.0.0.1:54321');
  assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname),'Disposable local DB only');
  const member = { apikey: process.env.ANAAI_TEST_ANON_KEY, Authorization: `Bearer ${process.env.ANAAI_TEST_USER_TOKEN}`, 'Content-Type':'application/json' };
  const privileged = { apikey: process.env.ZUDE_TEST_SERVICE_KEY, Authorization: `Bearer ${process.env.ZUDE_TEST_SERVICE_KEY}`, 'Content-Type':'application/json' };
  async function rpc(name, body, headers = member) {
    const response = await fetch(new URL(`/rest/v1/rpc/${name}`,url),{method:'POST',headers,body:JSON.stringify(body)});
    assert.ok(response.ok,`RPC HTTP status ${response.status}`); return response.json();
  }
  const business = process.env.ANAAI_TEST_BUSINESS_ID;
  async function rows(table, select='*', headers=member) {
    const u=new URL(`/rest/v1/${table}`,url); u.searchParams.set(table==='businesses'?'id':'business_id',`eq.${business}`);u.searchParams.set('select',select);u.searchParams.set('order','id');
    const r=await fetch(u,{headers});assert.ok(r.ok,`Fixture read HTTP ${r.status}`);return r.json();
  }
  async function snapshot() {
    return Promise.all(['appointments','customers','services','appointment_actions'].map(t=>rows(t)).concat([
      rows('appointment_notifications','id,business_id,appointment_action_id,appointment_id,status'),
    ]));
  }
  const appointments=await rows('appointments');
  const target=appointments.find(a=>a.id===process.env.ZUDE_TEST_APPOINTMENT_ID);
  const other=appointments.find(a=>a.id===process.env.ZUDE_TEST_OTHER_APPOINTMENT_ID);
  assert.ok(target && other,'Two active fixture appointments required');
  assert.equal((await rows('businesses'))[0].appointment_capacity,1,'Use a capacity-one fixture');
  const customer=(await rows('customers')).find(c=>c.id===target.customer_id);
  assert.ok(customer && !customer.phone,'Target must have a phone-less customer');
  const args={p_business_id:business,p_appointment_id:target.id,p_customer_id:target.customer_id,p_service_id:target.service_id,p_appointment_date:target.appointment_date,p_appointment_time:target.appointment_time};
  const before=await snapshot();
  const own=await rpc('check_reschedule_appointment_business',args);assert.equal(own.success,true);assert.equal(own.code,'AVAILABLE');
  const conflict=await rpc('check_reschedule_appointment_business',{...args,p_appointment_date:other.appointment_date,p_appointment_time:other.appointment_time});assert.equal(conflict.code,'SLOT_CONFLICT');
  assert.equal((await rpc('check_reschedule_appointment_business',{...args,p_appointment_id:process.env.ZUDE_TEST_FOREIGN_APPOINTMENT_ID})).code,'APPOINTMENT_NOT_FOUND');
  assert.equal((await rpc('check_reschedule_appointment_business',{...args,p_appointment_id:'ffffffff-ffff-4fff-8fff-ffffffffffff'})).code,'APPOINTMENT_NOT_FOUND');
  assert.equal((await rpc('check_reschedule_appointment_business',{...args,p_service_id:process.env.ZUDE_TEST_FOREIGN_SERVICE_ID})).code,'INVALID_SERVICE');
  assert.equal((await rpc('check_reschedule_appointment_business',{...args,p_business_id:process.env.ZUDE_TEST_FOREIGN_BUSINESS_ID})).code,'FORBIDDEN');
  const anonymous=await fetch(new URL('/rest/v1/rpc/check_reschedule_appointment_business',url),{method:'POST',headers:{apikey:process.env.ANAAI_TEST_ANON_KEY,'Content-Type':'application/json'},body:JSON.stringify(args)});
  assert.ok([401,403].includes(anonymous.status));
  const {p_appointment_id: _target,...booking}=args;
  const voiceArgs={p_business_id:business,p_service_id:target.service_id,p_appointment_date:target.appointment_date,p_appointment_time:target.appointment_time};
  assert.equal((await rpc('voice_check_appointment_availability',voiceArgs,privileged)).code,'SLOT_CONFLICT','New bookings do not exclude target');
  assert.equal((await rpc('create_appointment_atomic_business',{...booking,p_notes:null})).code,'SLOT_CONFLICT');
  assert.deepEqual(await snapshot(),before,'All checks leave appointment/customer/service/actions/notifications unchanged');
  // Existing actual mutation remains usable for this phone-less target. Run
  // after the strict no-write assertion; it is allowed to refresh snapshots.
  const moved=await rpc('reschedule_appointment_atomic_business',{...args,p_notes:target.notes});
  assert.equal(moved.success,true);assert.equal(moved.appointment.id,target.id);
  assert.equal((await rpc('voice_check_appointment_availability',voiceArgs,privileged)).code,'SLOT_CONFLICT');
});
