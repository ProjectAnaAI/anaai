const {test}=require('node:test');
const assert=require('node:assert/strict');
const {fixture}=require('./support/working-fixture.cjs');
const {serviceClient}=require('./support/pglite-db.cjs');
const H=3600000,M=60000;
async function setup(t){
  const h=await fixture(t,{serviceFactory(db,hooks,queries){
    const base=serviceClient(db);return {...base,from(table){const q=base.from(table),then=q.then;
      q.then=(resolve,reject)=>(async()=>{queries.push(table);await hooks.beforeRead?.(table);const result=await {then:then.bind(q)};await hooks.result?.(table,result);return result;})().then(resolve,reject);return q;}};
  }});
  const handler=h.load('server/handlers/timesheets.ts');
  const get=async(id,week,options={})=>{const r=await handler.GET(h.request(`/api/management/timesheets/${id}${week===undefined?'':'?weekStart='+week}`,options));return {status:r.status,body:await r.json()};};
  const directory=async(options={})=>{const r=await handler.DIRECTORY(h.request('/api/management/timesheets',options));return {status:r.status,body:await r.json()};};
  const employee=await h.employee();return {...h,get,directory,target:employee};
}
for(const role of ['staff','manager','owner'])test(`Timesheets ${role}: endpoint and directory authority/target policy`,async t=>{
  const h=await setup(t),owner=await h.employee({role:'owner'});await h.db.query('update public.business_members set role=$1',[role]);
  for(const [target,targetRole] of [[h.target,'employee'],[h.actor,'manager'],[owner,'owner']]){
    const r=await h.get(target);assert.equal(r.status,role==='owner'||(role==='manager'&&targetRole==='employee')?200:403);
  }
  const list=await h.directory();assert.equal(list.status,role==='staff'?403:200);
  if(role==='manager'){assert.equal(list.body.employees.length,1);assert.equal(list.body.employees[0].id,h.target);}
  if(role==='owner')assert.equal(list.body.employees.length,3);
});
test('Timesheets shared manager can read regular employees only; tenant selectors and target IDs never grant access',async t=>{
  const h=await setup(t);assert.equal((await h.get(h.target,undefined,{shared:true})).status,200);assert.equal((await h.get(h.actor,undefined,{shared:true})).status,403);
  const foreign=await h.employee({tenant:h.other});assert.equal((await h.get(foreign)).status,404);
  assert.equal((await h.get(h.target,undefined,{headers:{'x-anaai-business-id':h.other}})).status,403);
  assert.equal((await h.get('not-a-uuid')).status,400);
});
for(const [label,change] of [
 ['revoked session',h=>h.db.query('update public.employee_sessions set revoked_at=now() where id=$1',[h.session])],
 ['expired session',h=>h.db.query("update public.employee_sessions set expires_at=now()-interval '1 minute' where id=$1",[h.session])],
 ['revoked device',h=>h.db.query('update public.zude_devices set revoked_at=now() where id=$1',[h.device])],
 ['generation mismatch',h=>h.db.query('update public.zude_devices set updated_at=now() where id=$1',[h.device])],
])test(`Timesheets ${label} fails closed`,async t=>{const h=await setup(t);await change(h);assert.equal((await h.get(h.target,undefined,{shared:true})).status,401);assert.equal((await h.directory({shared:true})).status,401);});
test('Timesheets partial shared credentials and employee PIN fail closed',async t=>{
 const h=await setup(t);for(const headers of [{'x-zude-device':'invalid'},{'x-zude-employee-session':'invalid'}, {Authorization:''}])assert.equal((await h.get(h.target,undefined,{headers})).status,401);
 await h.db.query("update public.employees set role='employee' where id=$1",[h.actor]);assert.equal((await h.get(h.target,undefined,{shared:true})).status,403);
});
test('Timesheets canonical Monday, strict query/date validation, current/historical and future contract',async t=>{
 const h=await setup(t);const current=await h.get(h.target);assert.equal(current.status,200);assert.equal(current.body.week.startDate,current.body.currentWeekStart);assert.equal(current.body.nextWeekStart,null);
 assert.equal((await h.get(h.target,'2026-03-02')).status,200);
 for(const week of ['', '2026-02-30','invalid','2026-03-03','0000-01-03','2026-03-02&weekStart=2026-03-09','2026-03-02&timezone=UTC','2026-03-02&role=owner'])assert.equal((await h.get(h.target,week)).status,400,week);
 const r=await h.get(h.target,'9999-12-27');assert.equal(r.status,400);assert.equal(r.body.code,'FUTURE_WEEK');
});
test('Timesheets historical shifts: same-time seq, paid/meal, multiple shifts, overnight and week carry-in/out agree with M05',async t=>{
 const h=await setup(t),calc=h.load('server/time-calculation.ts'),all=[];
 const event=async(type,time,brk=null)=>{all.push(await h.event(h.target,type,Date.parse(time),brk));};
 // LA Monday 2026-03-02 starts 08:00Z. Carry-in paid break is already running.
 await event('CLOCK_IN','2026-03-02T06:00:00Z');await event('BREAK_START','2026-03-02T07:50:00Z','PAID');await event('BREAK_END','2026-03-02T08:10:00Z','PAID');
 await event('BREAK_START','2026-03-02T09:00:00Z','MEAL');await event('BREAK_END','2026-03-02T09:30:00Z','MEAL');await event('CLOCK_OUT','2026-03-02T09:30:00Z');
 await event('CLOCK_IN','2026-03-02T10:00:00Z');await event('CLOCK_OUT','2026-03-02T11:00:00Z');
 // Overnight Tuesday -> Wednesday.
 await event('CLOCK_IN','2026-03-04T07:00:00Z');await event('CLOCK_OUT','2026-03-04T09:00:00Z');
 // DST Sunday -> next Monday closure. Must report closed, not fabricate open.
 await event('CLOCK_IN','2026-03-09T06:00:00Z');await event('BREAK_START','2026-03-09T06:30:00Z','MEAL');await event('BREAK_END','2026-03-09T07:10:00Z','MEAL');await event('CLOCK_OUT','2026-03-09T08:00:00Z');
 // Unrelated later shifts must not leak into event detail.
 await h.event(h.target,'CLOCK_IN',Date.parse('2026-03-10T08:00:00Z'));await h.event(h.target,'CLOCK_OUT',Date.parse('2026-03-10T09:00:00Z'));
 const r=await h.get(h.target,'2026-03-02');assert.equal(r.status,200);const b=r.body;
 assert.equal(b.week.startsAt,'2026-03-02T08:00:00.000Z');assert.equal(b.week.endsAt,'2026-03-09T07:00:00.000Z');assert.equal(Date.parse(b.week.endsAt)-Date.parse(b.week.startsAt),167*H);
 assert.equal(b.days[6].workedMs,30*M);assert.equal(b.days[0].workedMs,2*H);assert.equal(b.days[0].paidBreakMs,10*M);assert.equal(b.days[0].mealBreakMs,30*M);
 assert.equal(b.days[1].workedMs,H);assert.equal(b.days[2].workedMs,H);assert.equal(b.totals.hasOpenShift,false);
 const shifts=calc.buildShifts(all),snapshot=Date.parse(b.snapshotAt);
 const expected=calc.windowTotals(shifts,Date.parse(b.week.startsAt),Date.parse(b.week.endsAt),snapshot);
 for(const k of ['workedMs','paidBreakMs','mealBreakMs'])assert.equal(b.totals[k],expected[k]);
 assert.deepEqual(b.events.map(e=>e.id),all.map(e=>e.id));assert.ok(b.events.every((e,i,a)=>i===0||e.seq>a[i-1].seq));
 assert.equal(b.events[4].occurredAt,b.events[5].occurredAt);assert.equal(b.events[4].type,'BREAK_END');assert.equal(b.events[5].type,'CLOCK_OUT');
 assert.equal(b.days[6].shifts[0].open,false);assert.equal(b.days[6].shifts[0].continuesNextDay,true);
 assert.doesNotMatch(JSON.stringify(b),/pin|salt|hash|credential|session|device|request_id|updated_at/i);
});
test('Timesheets current-week open inactive shift uses one snapshot, matches My Time calculations, and historical weeks clip it',async t=>{
 const h=await setup(t),calc=h.load('server/time-calculation.ts'),week=calc.businessWeek(Date.now(),'America/Los_Angeles');
 const start=week.startsAt-2*H;await h.event(h.actor,'CLOCK_IN',start);await h.event(h.actor,'BREAK_START',start+H,'MEAL');
 const result=await h.get(h.actor);assert.equal(result.status,200);const b=result.body,snapshot=Date.parse(b.snapshotAt);
 assert.equal(b.totals.hasOpenShift,true);assert.equal(b.totals.workedMs,0);assert.equal(b.totals.mealBreakMs,snapshot-week.startsAt);
 assert.equal(b.days.reduce((n,d)=>n+d.mealBreakMs,0),b.totals.mealBreakMs);
 const myTime=h.load('server/handlers/time-clock.ts');
 // Compare both original/current readers at exactly the management snapshot.
 const own=await h.load('server/time-ledger.ts').employeeLedger(h.service,h.business,h.actor,week.startsAt);
 const totals=calc.windowTotals(calc.buildShifts(own.events),week.startsAt,week.endsAt,snapshot);
 for(const k of ['workedMs','paidBreakMs','mealBreakMs'])assert.equal(b.totals[k],totals[k]);
 // My Time keeps its device-only identity boundary and rejects all selectors.
 for(const suffix of ['?weekStart=2026-03-02','?employeeId='+h.target])assert.equal((await myTime.MY_TIME(h.timeRequest('/api/my-time'+suffix))).status,401);
 const ownResponse=await myTime.MY_TIME(h.timeRequest('/api/my-time'));assert.equal(ownResponse.status,200);
 const ownBody=await ownResponse.json();assert.equal(ownBody.week.startDate,b.week.startDate);
 const ownExpected=calc.windowTotals(calc.buildShifts(own.events),week.startsAt,week.endsAt,Date.parse(ownBody.serverNow));
 for(const k of ['workedMs','paidBreakMs','mealBreakMs'])assert.equal(ownBody.week[k],ownExpected[k]);
 await h.db.query('update public.employees set is_active=false where id=$1',[h.actor]);
 const inactive=await h.get(h.actor);assert.equal(inactive.status,200);assert.equal(inactive.body.employee.isActive,false);assert.equal(inactive.body.totals.hasOpenShift,true);
 const prior=await h.get(h.actor,calc.addDays(week.startDate,-7));assert.equal(prior.status,200);assert.equal(prior.body.totals.workedMs,H);assert.equal(prior.body.totals.mealBreakMs,H);
});
test('Timesheets fall-back day has 25 hours, inactive historical employee retained, empty week truthful',async t=>{
 const h=await setup(t);await h.event(h.target,'CLOCK_IN',Date.parse('2025-11-02T07:00:00Z'));await h.event(h.target,'CLOCK_OUT',Date.parse('2025-11-03T08:00:00Z'));
 await h.db.query('update public.employees set is_active=false where id=$1',[h.target]);const b=(await h.get(h.target,'2025-10-27')).body;
 assert.equal(b.days[6].workedMs,25*H);assert.equal(b.employee.isActive,false);assert.equal(b.days[6].shifts[0].open,false);
 assert.ok((await h.directory()).body.employees.some(e=>e.id===h.target&&!e.isActive));
 const empty=(await h.get(h.target,'2025-10-20')).body;assert.equal(empty.totals.workedMs,0);assert.equal(empty.events.length,0);assert.equal(empty.days.length,7);
});
test('Timesheets retries complete read after append during paging',async t=>{
 const h=await setup(t);await h.event(h.target,'CLOCK_IN',Date.now()-H);
 let eventReads=0;h.hooks.result=async(table)=>{if(table==='employee_time_effective_events'&&++eventReads===1)await h.event(h.target,'CLOCK_OUT',Date.now());};
 const r=await h.get(h.target);assert.equal(r.status,200);assert.equal(r.body.totals.hasOpenShift,false);assert.equal(r.body.events.length,2);
 delete h.hooks.result;assert.equal((await h.get(h.target)).body.totals.hasOpenShift,false);
});
test('Timesheets pages beyond 500, excludes lifetime history, and rejects incomplete event pages',async t=>{
 const h=await setup(t);await h.db.query(`insert into public.employee_time_events(business_id,employee_id,device_id,event_type,occurred_at,request_id)
 select $1,$2,$3,case when n%2=1 then 'CLOCK_IN' else 'CLOCK_OUT' end,'2025-01-01'::timestamptz+n*interval '1 second',gen_random_uuid() from generate_series(1,2000) n`,[h.business,h.target,h.device]);
 await h.event(h.target,'CLOCK_IN',Date.parse('2026-03-03T00:00:00Z'));
 await h.db.query(`insert into public.employee_time_events(business_id,employee_id,device_id,event_type,break_type,occurred_at,request_id)
 select $1,$2,$3,case when n%2=1 then 'BREAK_START' else 'BREAK_END' end,'PAID','2026-03-03'::timestamptz+n*interval '1 second',gen_random_uuid() from generate_series(1,600) n`,[h.business,h.target,h.device]);
 await h.event(h.target,'CLOCK_OUT',Date.parse('2026-03-03T01:00:00Z'));
 const r=await h.get(h.target,'2026-03-02');assert.equal(r.status,200);assert.equal(r.body.events.length,602);assert.equal(r.body.totals.workedMs,H);
 h.hooks.result=(table,r)=>{if(table==='employee_time_effective_events'&&Array.isArray(r.data)&&r.count!==undefined)r.data=[];};assert.equal((await h.get(h.target,'2026-03-02')).status,503);
});
test('Timesheets pathological carry-in limit and truncated/oversized directory fail explicitly',async t=>{
 const h=await setup(t);await h.event(h.target,'CLOCK_IN',Date.parse('2026-02-01T00:00:00Z'));
 await h.db.query(`insert into public.employee_time_events(business_id,employee_id,device_id,event_type,break_type,occurred_at,request_id)
 select $1,$2,$3,case when n%2=1 then 'BREAK_START' else 'BREAK_END' end,'PAID','2026-02-01'::timestamptz+n*interval '1 second',gen_random_uuid() from generate_series(1,10000) n`,[h.business,h.target,h.device]);
 const r=await h.get(h.target,'2026-03-02');assert.equal(r.status,503);assert.equal(r.body.code,'TIMESHEET_LIMIT_EXCEEDED');assert.equal(r.body.totals,undefined);
 h.hooks.result=(table,r)=>{if(table==='employees'&&Array.isArray(r.data))r.data=[];};assert.equal((await h.directory()).status,503);delete h.hooks.result;
 await h.db.query("insert into public.employees(business_id,display_name,role,pin_hash,pin_salt) select $1,'Extra','employee','fixture','fixture' from generate_series(1,200)",[h.business]);
 assert.equal((await h.directory()).body.code,'TIMESHEET_LIMIT_EXCEEDED');
});
test('Timesheets real supabase-js historical query requests exact counts before paging and uses fixed tenant/employee/seq bounds',async t=>{
 const h=await setup(t),{createClient}=require('@supabase/supabase-js'),requests=[];
 const clockIn={id:'in',seq:5,event_type:'CLOCK_IN',break_type:null,occurred_at:'2026-03-03T00:00:00Z'};
 const clockOut={id:'out',seq:6,event_type:'CLOCK_OUT',break_type:null,occurred_at:'2026-03-03T01:00:00Z'};
 const client=createClient('https://fixture.invalid','synthetic-test-key',{auth:{persistSession:false},global:{fetch:async(url,init)=>{
  const u=new URL(url),q=u.searchParams,headers=new Headers(init.headers);requests.push({u,headers});
  let data,count=false;
  if(u.pathname.endsWith('/rpc/m06_ledger_read_versions'))data=[{employeeId:h.target,originalWatermark:'6',correctionRevision:'0'}];
  else if(u.pathname.endsWith('/businesses'))data={id:h.business,timezone:'UTC'};
  else if(headers.get('prefer')?.includes('count=exact')){data=[clockIn,clockOut];count=true;}
  else if(q.get('occurred_at')==='lt.2026-03-02T00:00:00.000Z')data=null;
  else data=clockOut;
  return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json',...(count?{'content-range':'0-1/2'}:{})}});
 }}});
 const result=await h.load('server/time-ledger.ts').historicalLedger(client,h.business,h.target,'2026-03-02');assert.equal(result.events.length,2);
 const pages=requests.filter(r=>r.headers.get('prefer')?.includes('count=exact'));assert.equal(pages.length,1);
 const q=pages[0].u.searchParams;assert.equal(q.get('business_id'),'eq.'+h.business);assert.equal(q.get('employee_id'),'eq.'+h.target);assert.equal(q.get('seq'),'lte.6');assert.equal(q.get('occurred_at'),'gte.2026-03-02T00:00:00.000Z');assert.equal(q.get('limit'),'500');assert.equal(q.get('order'),'seq.asc');assert.equal(q.get('select'),'id,seq,event_type,break_type,occurred_at,origin,replaced,correction_revision');
 assert.ok(pages[0].u.pathname.endsWith('/employee_time_effective_events'),'reads the effective ledger');
});
