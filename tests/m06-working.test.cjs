const {test}=require('node:test');
const assert=require('node:assert/strict');
const {fixture}=require('./support/working-fixture.cjs');
const H=3600000,M=60000;
for(const role of ['staff','manager','owner'])test(`Working account ${role} authority`,async t=>{
  const h=await fixture(t);await h.db.query('update public.business_members set role=$1',[role]);
  const r=await h.get();assert.equal(r.status,role==='staff'?403:200);
  if(role==='staff')assert.equal(h.queries.length,0);
});
test('Working shared manager allowed; employee PIN never inherits owner and weaker account role wins',async t=>{
  const h=await fixture(t);assert.equal((await h.get({shared:true})).status,200);
  await h.db.query("update public.employees set role='employee' where id=$1",[h.actor]);
  const denied=await h.get({shared:true});assert.equal(denied.status,403);assert.equal(denied.body.code,'EMPLOYEE_FORBIDDEN');
  await h.db.query("update public.employees set role='owner' where id=$1",[h.actor]);
  await h.db.query("update public.business_members set role='staff'");assert.equal((await h.get({shared:true})).status,403);
});
for(const [name,sql,field,code] of [
  ['revoked session','update public.employee_sessions set revoked_at=now() where id=$1','session','IDENTITY_UNAUTHORIZED'],
  ['expired session',"update public.employee_sessions set expires_at=now()-interval '1 minute' where id=$1",'session','IDENTITY_UNAUTHORIZED'],
  ['revoked device','update public.zude_devices set revoked_at=now() where id=$1','device','DEVICE_REVOKED'],
  ['device generation','update public.zude_devices set updated_at=now() where id=$1','device','IDENTITY_UNAUTHORIZED'],
  ['employee generation','update public.employees set updated_at=now() where id=$1','actor','IDENTITY_UNAUTHORIZED'],
])test(`Working rejects ${name}`,async t=>{
  const h=await fixture(t);await h.db.query(sql,[h[field]]);const r=await h.get({shared:true});assert.equal(r.status,401);assert.equal(r.body.code,code);assert.equal(h.queries.length,0);
});
test('Working bearer, partial credentials, invalid credentials and tenant selector fail closed',async t=>{
  const h=await fixture(t);
  for(const headers of [{Authorization:''},{'x-zude-device':'invalid'},{'x-zude-employee-session':'invalid'}])assert.equal((await h.get({headers})).status,401);
  assert.equal((await h.get({headers:{'x-anaai-business-id':h.other}})).status,403);
  assert.equal((await h.get({shared:true,headers:{'x-zude-employee-session':''}})).status,401);
  assert.equal(h.queries.length,0);
});
test('Working all four states, inactive open shifts, same-time seq and one overnight snapshot reuse M05 calculations',async t=>{
  const h=await fixture(t),now=Date.now(),start=now-30*H;
  const working=await h.employee({name:'Working'}),paid=await h.employee({name:'Paid'}),meal=await h.employee({name:'Meal'}),closed=await h.employee({name:'Closed'});
  const inactive=await h.employee({active:false,name:'Inactive open'}),inactiveOff=await h.employee({active:false,name:'Inactive off'});
  const foreign=await h.employee({tenant:h.other,name:'Other business'});
  for(const id of [working,paid,meal,closed,inactive])await h.event(id,'CLOCK_IN',start);
  await h.event(paid,'BREAK_START',now-10*M,'PAID');await h.event(meal,'BREAK_START',now-30*M,'MEAL');
  await h.event(working,'BREAK_START',now-H,'MEAL');await h.event(working,'BREAK_END',now-30*M,'MEAL');
  await h.event(inactive,'BREAK_START',now-5*M,'PAID');
  // Same-timestamp break end + clock out: seq, not occurred_at, decides OFF_CLOCK.
  await h.event(closed,'BREAK_START',now-H,'MEAL');await h.event(closed,'BREAK_END',now-30*M,'MEAL');await h.event(closed,'CLOCK_OUT',now-30*M);
  const r=await h.get();assert.equal(r.status,200);assert.equal(r.body.timezone,'America/Los_Angeles');
  const rows=new Map(r.body.employees.map(e=>[e.employee.id,e])),snapshot=Date.parse(r.body.snapshotAt);
  assert.equal(rows.get(h.actor).state,'OFF_CLOCK');assert.equal(rows.get(h.actor).stateStartedAt,null);
  assert.equal(rows.get(closed).state,'OFF_CLOCK');assert.equal(rows.get(closed).shift,null);
  for(const [id,state,mealMs,paidMs] of [[working,'WORKING',30*M,0],[paid,'ON_PAID_BREAK',0,snapshot-(now-10*M)],[meal,'ON_MEAL_BREAK',snapshot-(now-30*M),0],[inactive,'ON_PAID_BREAK',0,snapshot-(now-5*M)]]){
    const row=rows.get(id);assert.equal(row.state,state);assert.equal(row.shift.elapsedMs,snapshot-start);
    assert.equal(row.shift.workedMs,snapshot-start-mealMs);assert.equal(row.shift.mealBreakMs,mealMs);assert.equal(row.shift.paidBreakMs,paidMs);
  }
  assert.equal(rows.get(inactive).inactiveOpenShift,true);assert.equal(rows.get(inactive).employee.isActive,false);
  assert.ok(!rows.has(inactiveOff));assert.ok(!rows.has(foreign));
  assert.doesNotMatch(JSON.stringify(r.body),/pin_hash|pin_salt|token|credential|session|device_id|updated_at|synthetic/i);
  assert.equal(h.queries.filter(q=>q.table==='employees').length,1);assert.equal(h.queries.filter(q=>q.table==='employee_time_effective_events').length,1);
});
test('Working batches open employee ranges, excludes lifetime closed history and pages beyond 500 events',async t=>{
  const h=await fixture(t),now=Date.now();
  for(let i=0;i<25;i++){const id=await h.employee();await h.event(id,'CLOCK_IN',now-H);}
  // Large closed history, then one open shift with 502 events requiring pagination.
  const id=await h.employee();
  await h.db.query(`insert into public.employee_time_events(business_id,employee_id,device_id,event_type,occurred_at,request_id)
    select $1,$2,$3,case when n%2=1 then 'CLOCK_IN' else 'CLOCK_OUT' end,now()-interval '3 days'+n*interval '1 second',gen_random_uuid() from generate_series(1,2000) n`,[h.business,id,h.device]);
  await h.event(id,'CLOCK_IN',now-H);
  await h.db.query(`insert into public.employee_time_events(business_id,employee_id,device_id,event_type,break_type,occurred_at,request_id)
    select $1,$2,$3,case when n%2=1 then 'BREAK_START' else 'BREAK_END' end,'PAID',$4::timestamptz+n*interval '1 second',gen_random_uuid() from generate_series(1,501) n`,[h.business,id,h.device,new Date(now-3000*1000).toISOString()]);
  const r=await h.get();assert.equal(r.status,200);assert.equal(r.body.employees.length,27);
  assert.equal(r.body.employees.find(e=>e.employee.id===id).state,'ON_PAID_BREAK');
  assert.equal(h.queries.filter(q=>q.table==='employees').length,1);
  assert.equal(h.queries.filter(q=>q.table==='employee_time_effective_events').length,3,'two batches plus one extra page, not 26 employee requests');
});
test('Working retries concurrent append with a fresh complete attempt',async t=>{
  const h=await fixture(t),start=Date.now()-H;await h.event(h.actor,'CLOCK_IN',start);
  h.hooks.beforeEvents=async()=>{delete h.hooks.beforeEvents;await h.event(h.actor,'CLOCK_OUT',Date.now());};
  const first=await h.get();assert.equal(first.status,200);assert.equal(first.body.employees[0].state,'OFF_CLOCK');
  assert.equal(first.body.employees[0].shift,null);
  assert.equal((await h.get()).body.employees[0].state,'OFF_CLOCK');
});
test('Working rejects truncated roster, missing open events and oversized complete roster',async t=>{
  const h=await fixture(t);h.hooks.result=(table,r)=>{if(table==='employees')r.data=[];};
  assert.equal((await h.get()).status,503);delete h.hooks.result;
  await h.event(h.actor,'CLOCK_IN',Date.now()-H);
  h.hooks.result=(table,r)=>{if(table==='employee_time_effective_events')r.data=[];};assert.equal((await h.get()).status,503);delete h.hooks.result;
  await h.db.query("insert into public.employees(business_id,display_name,role,pin_hash,pin_salt) select $1,'Extra','employee','fixture','fixture' from generate_series(1,200)",[h.business]);
  const r=await h.get();assert.equal(r.status,503);assert.equal(r.body.code,'WORKING_LIMIT_EXCEEDED');assert.equal(r.body.employees,undefined);
});
test('Working rejects open ledger over 10000 events, never silently truncates',async t=>{
  const h=await fixture(t);await h.event(h.actor,'CLOCK_IN',Date.now()-24*H);
  await h.db.query(`insert into public.employee_time_events(business_id,employee_id,device_id,event_type,break_type,occurred_at,request_id)
    select $1,$2,$3,case when n%2=1 then 'BREAK_START' else 'BREAK_END' end,'PAID',now()-interval '20 hours'+n*interval '1 second',gen_random_uuid() from generate_series(1,10000) n`,[h.business,h.actor,h.device]);
  const r=await h.get();assert.equal(r.status,503);assert.equal(r.body.code,'WORKING_LIMIT_EXCEEDED');
});
test('Working rejects client filters and invalid business timezone; empty roster is successful',async t=>{
  const h=await fixture(t);assert.equal((await h.get({query:'?timezone=UTC'})).status,400);
  await h.db.query("update public.businesses set timezone='invalid-zone' where id=$1",[h.business]);
  const r=await h.get();assert.equal(r.status,503);assert.equal(r.body.code,'TIME_CONFIGURATION_UNAVAILABLE');
  await h.db.query("update public.business_members set business_id=$1",[h.other]);
  const empty=await h.get({headers:{'x-anaai-business-id':h.other}});assert.equal(empty.status,200);assert.deepEqual(empty.body.employees,[]);
});
test('Working actual supabase-js wire query has composite FK, alias limits and business-scoped event ranges',async t=>{
  const h=await fixture(t),{createClient}=require('@supabase/supabase-js'),urls=[];
  const start={id:'event-id',seq:5,event_type:'CLOCK_IN',break_type:null,occurred_at:new Date(Date.now()-H).toISOString()};
  const client=createClient('https://fixture.invalid','synthetic-test-key',{auth:{persistSession:false},global:{fetch:async(url,init)=>{
    const u=new URL(url);urls.push(u);
    let data;if(u.pathname.endsWith('/rpc/m06_ledger_read_versions'))data=[{employeeId:h.actor,originalWatermark:'5',correctionRevision:'0'}];
    else if(u.pathname.endsWith('/businesses'))data={id:h.business,timezone:'UTC'};
    else if(u.pathname.endsWith('/employees'))data=[{id:h.actor,display_name:'Actor',role:'manager',is_active:true,latest:[start],opened:[start]}];
    else data=[{employee_id:h.actor,...start}];
    if(Array.isArray(data)&&!u.pathname.includes('/rpc/'))assert.match(new Headers(init.headers).get('prefer'),/count=exact/);
    return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json','Content-Range':'0-0/1'}});
  }}});
  const result=await h.load('server/time-ledger.ts').workingLedger(client,h.business);assert.equal(result.employees.length,1);
  assert.equal(urls.length,5);
  const heads=urls[2].searchParams,events=urls[3].searchParams;
  assert.ok(urls[3].pathname.endsWith('/employee_time_effective_events'),'reads the effective ledger');
  assert.equal(heads.get('business_id'),'eq.'+h.business);assert.equal(heads.get('limit'),'201');
  for(const alias of ['latest','opened']){assert.equal(heads.get(alias+'.limit'),'1');assert.equal(heads.get(alias+'.order'),'seq.desc');}
  assert.equal(heads.get('opened.event_type'),'eq.CLOCK_IN');assert.match(heads.get('select'),/employee_time_effective_events!employee_time_effective_events_business_employee_fkey/);
  assert.equal(events.get('business_id'),'eq.'+h.business);assert.equal(events.get('or'),`(and(employee_id.eq.${h.actor},seq.gte.5,seq.lte.5))`);
  assert.equal(events.get('order'),'seq.asc');assert.equal(events.get('limit'),'500');
});
