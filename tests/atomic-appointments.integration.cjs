// Opt-in LOCAL Supabase scaffolding. Never points to a hosted database.
// Creates test appointments; prepare a disposable business as described in the README.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const enabled = process.env.ANAAI_RUN_LOCAL_SCHEDULING_TESTS === '1';
test('local PostgreSQL: concurrent creation and self-excluding reschedule', { skip: !enabled }, async () => {
  const required = ['ANAAI_TEST_ANON_KEY','ANAAI_TEST_USER_TOKEN','ANAAI_TEST_BUSINESS_ID','ANAAI_TEST_CUSTOMER_ID','ANAAI_TEST_SERVICE_ID','ANAAI_TEST_DATE','ANAAI_TEST_TIME','ANAAI_TEST_SECOND_DATE'];
  for (const key of required) assert.ok(process.env[key], `Missing ${key}`);
  const url = new URL(process.env.ANAAI_LOCAL_SUPABASE_URL || 'http://127.0.0.1:54321');
  assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname), 'Local database only');
  const params = {
    p_business_id: process.env.ANAAI_TEST_BUSINESS_ID,
    p_customer_id: process.env.ANAAI_TEST_CUSTOMER_ID,
    p_service_id: process.env.ANAAI_TEST_SERVICE_ID,
    p_appointment_date: process.env.ANAAI_TEST_DATE,
    p_appointment_time: process.env.ANAAI_TEST_TIME,
    p_notes: 'Disposable local concurrency test',
  };
  const headers = { apikey: process.env.ANAAI_TEST_ANON_KEY, authorization: `Bearer ${process.env.ANAAI_TEST_USER_TOKEN}`, 'content-type': 'application/json' };
  async function rpc(name, body) {
    const r=await fetch(new URL(`/rest/v1/rpc/${name}`,url),{method:'POST',headers,body:JSON.stringify(body)});
    assert.ok(r.ok,`RPC HTTP ${r.status}`); return r.json();
  }
  // Distinct HTTP requests use separate DB transactions. Repeat with new empty
  // slots and explicit DB lock barriers for a stronger concurrency proof.
  const results=await Promise.all(Array.from({length:8},()=>rpc('create_appointment_atomic_business',params)));
  const successes=results.filter(r=>r.success===true);
  assert.equal(successes.length,1);
  for(const r of results.filter(r=>r.success!==true)) assert.equal(r.code,'SLOT_CONFLICT');
  const id=successes[0].appointment.id;
  const moved=await rpc('reschedule_appointment_atomic_business',{...params,p_appointment_id:id});
  assert.equal(moved.success,true,'Unchanged interval must exclude itself');
  assert.equal(moved.appointment.id,id);
  const secondDate = process.env.ANAAI_TEST_SECOND_DATE;
  assert.notEqual(secondDate, params.p_appointment_date, 'Use a different empty open date');
  // Same appointment, competing cross-date moves. Requests whose preliminary
  // read saw the old date must fail safely; later readers may validly succeed.
  const moves = await Promise.all(Array.from({length:4}, () => rpc(
    'reschedule_appointment_atomic_business',
    {...params, p_appointment_id:id, p_appointment_date:secondDate}
  )));
  assert.ok(moves.some(r => r.success === true));
  for (const result of moves) {
    if (result.success !== true) assert.equal(result.code, 'SOURCE_DATE_CHANGED');
    else assert.equal(result.appointment.appointment_date, secondDate);
  }
  // Move back to cover both chronological directions with the same lock order.
  const returned = await rpc('reschedule_appointment_atomic_business', {...params,p_appointment_id:id});
  assert.equal(returned.success,true);
  assert.equal(returned.appointment.appointment_date,params.p_appointment_date);
  const query=new URL('/rest/v1/appointments',url);
  query.searchParams.set('business_id',`eq.${params.p_business_id}`);
  query.searchParams.set('appointment_date',`eq.${params.p_appointment_date}`);
  query.searchParams.set('status','in.(Booked,Confirmed)');
  query.searchParams.set('select','id');
  const read=await fetch(query,{headers}); assert.ok(read.ok);
  assert.deepEqual(await read.json(),[{id}],'Fixture date must have only the winning appointment');
});
