// Real SQL commits deliberately interleaved between read requests. Required
// PGlite suite; not a claim of multi-connection PostgreSQL validation.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {fixture}=require('./support/working-fixture.cjs');
const {as}=require('./support/pglite-db.cjs');
const H=3600000;
async function setup(t){
 const h=await fixture(t),calls=[];
 const from=h.service.from.bind(h.service),rpc=h.service.rpc.bind(h.service);
 h.service.from=table=>{
  const wrap=q=>new Proxy(q,{get(target,key){
   if(key==='then')return (resolve,reject)=>(async()=>{const result=await target;await h.hooks.afterRead?.(table,result);return result;})().then(resolve,reject);
   const value=target[key];return typeof value==='function'?(...args)=>wrap(value.apply(target,args)):value;
  }});
  return wrap(from(table));
 };
 h.service.rpc=async(name,args)=>{calls.push(name);const r=await rpc(name,args);await h.hooks.afterRpc?.(name,r);return r;};
 const ledger=h.load('server/time-ledger.ts'),calc=h.load('server/time-calculation.ts'),sheets=h.load('server/handlers/timesheets.ts'),clock=h.load('server/handlers/time-clock.ts');
 const target=await h.employee(),session=await h.sessionFor(target);
 const json=async r=>({status:r.status,body:await r.json()});
 const sheet=(week='2026-03-02')=>sheets.GET(h.request(`/api/management/timesheets/${target}?weekStart=${week}`)).then(json);
 const timeRequest=(path,method='GET',body={})=>new Request('https://zude.test/api/'+path,{method,headers:{Authorization:`ZudeDevice ${h.deviceCredential}`,'x-zude-employee-session':session.value,'Idempotency-Key':crypto.randomUUID()},...(method==='POST'?{body:JSON.stringify(body)}:{})});
 const time=()=>clock.STATE(timeRequest('time-clock')).then(json);
 const mine=()=>clock.MY_TIME(timeRequest('my-time')).then(json);
 const action=(name)=>clock[name](timeRequest('time-clock/action','POST')).then(json);
 const version=async(id=target,business=h.business)=>(await h.service.rpc('m06_ledger_read_versions',{p_business_id:business,p_employee_id:id})).data;
 async function correct(operations,{commit=true}={}){
  const [v]=await version();
  const r=await as(h.db,'service_role',`select public.m06_correct_employee_time($1,$2,$3,'account','owner',null,null,null,$4::jsonb,'Read race regression',$5,$6,$7,$8,null,null) as result`,[h.business,target,h.account,JSON.stringify(operations),crypto.randomUUID(),Number(v.correctionRevision),v.originalWatermark,commit]);
  assert.equal(r.rows[0].result.ok,true);return r.rows[0].result;
 }
 const effective=async()=> (await h.db.query('select id,seq,event_type,break_type,occurred_at,origin,replaced,correction_revision from public.employee_time_effective_events where employee_id=$1 order by seq',[target])).rows;
 const stableEqual=(r,events)=>{
  assert.equal(r.status,200);const b=r.body,shifts=calc.buildShifts(events),snapshot=Date.parse(b.snapshotAt);
  const expected=calc.windowTotals(shifts,Date.parse(b.week.startsAt),Date.parse(b.week.endsAt),snapshot);
  for(const k of ['workedMs','paidBreakMs','mealBreakMs'])assert.equal(b.totals[k],expected[k]);
  const days=calc.businessWeek(Date.parse(b.week.startsAt),b.timezone).days;
  assert.deepEqual(b.days,JSON.parse(JSON.stringify(days.map(d=>calc.dayView(shifts,d,snapshot)))));
  for(const e of b.events){const stored=events.find(x=>x.id===e.id);assert.ok(stored);assert.equal(Date.parse(e.occurredAt),Date.parse(stored.occurred_at));assert.equal(e.corrected,stored.replaced);assert.equal(e.correctionRevision,stored.correction_revision);}
 };
 return {...h,ledger,calc,calls,target,version,correct,effective,sheet,time,mine,action,stableEqual};
}
async function many(h,{base='2026-03-03T00:00:00Z',count=502,step='1 minute'}={}){
 await h.db.query(`insert into public.employee_time_events(business_id,employee_id,device_id,event_type,occurred_at,request_id)
 select $1,$2,$3,case when n%2=1 then 'CLOCK_IN' else 'CLOCK_OUT' end,$4::timestamptz+n*$5::interval,gen_random_uuid() from generate_series(1,$6) n`,[h.business,h.target,h.device,base,step,count]);
 return h.effective();
}
function once(h,predicate,change){let ran=false;h.hooks.afterRead=async(table,result)=>{if(!ran&&predicate(table,result)){ran=true;await change();}};return ()=>assert.ok(ran,'interleaving executed');}
const page=(table,r)=>table==='employee_time_effective_events'&&Array.isArray(r.data)&&r.data.length===500;
const replaced=(event,delta)=>({op:'REPLACE',target:event.id,occurredAt:new Date(Date.parse(event.occurred_at)+delta).toISOString(),...(event.break_type?{breakType:event.break_type}:{})});
test('4.1 exact 15060000 → forbidden 15090000 → 15120000 race: retry discards every old page, day, shift and provenance',async t=>{
 const h=await setup(t),events=await many(h);const old=await h.sheet();assert.equal(old.body.totals.workedMs,15060000);
 const ran=once(h,page,()=>h.correct([replaced(events[1],30000),replaced(events[501],30000)]));
 const r=await h.sheet();ran();assert.equal(r.status,200);assert.equal(r.body.totals.workedMs,15120000);assert.notEqual(r.body.totals.workedMs,15090000);
 assert.deepEqual(r.body.events.map(e=>e.id),old.body.events.map(e=>e.id),'count and ALL logical IDs unchanged');
 h.stableEqual(r,await h.effective());assert.equal(r.body.events.length,502,'no merged/duplicate failed pages');
});
test('4.1 real clock-out between historical pages changes watermark without correction revision',async t=>{
 const h=await setup(t),events=await many(h,{count:501});const before=(await h.version())[0];
 const ran=once(h,page,async()=>assert.equal((await h.action('CLOCK_OUT')).status,200));
 const r=await h.sheet();ran();assert.equal(r.status,200);assert.equal(r.body.totals.hasOpenShift,false);
 const after=(await h.version())[0];assert.equal(after.correctionRevision,before.correctionRevision);assert.ok(BigInt(after.originalWatermark)>BigInt(before.originalWatermark));assert.equal(r.body.events.length,events.length+1);h.stableEqual(r,await h.effective());
});
for(const op of ['BREAK','VOID','INSERT'])test(`4.1 ${op} correction between pages produces only new interpretation`,async t=>{
 const h=await setup(t);let events;
 if(op==='BREAK'){
  await h.event(h.target,'CLOCK_IN',Date.parse('2026-03-03T00:00:00Z'));
  await h.db.query(`insert into public.employee_time_events(business_id,employee_id,device_id,event_type,break_type,occurred_at,request_id)
   select $1,$2,$3,case when n%2=1 then 'BREAK_START' else 'BREAK_END' end,'MEAL','2026-03-03T00:00:00Z'::timestamptz+n*interval '1 minute',gen_random_uuid() from generate_series(1,500) n`,[h.business,h.target,h.device]);
  await h.event(h.target,'CLOCK_OUT',Date.parse('2026-03-03T09:00:00Z'));events=await h.effective();
 }else events=await many(h);
 const operations=op==='BREAK'?[replaced(events[2],30000)]:op==='VOID'?[{op:'VOID',target:events[0].id},{op:'VOID',target:events[1].id}]:[
  {op:'INSERT',type:'BREAK_START',breakType:'MEAL',occurredAt:'2026-03-03T00:01:10Z',after:events[0].id,ref:'break'},
  {op:'INSERT',type:'BREAK_END',breakType:'MEAL',occurredAt:'2026-03-03T00:01:40Z',afterRef:'break'}];
 const ran=once(h,page,()=>h.correct(operations));const r=await h.sheet();ran();h.stableEqual(r,await h.effective());
});
test('4.1 two corrections in one attempt do not cancel token changes; next stable attempt wins',async t=>{
 const h=await setup(t),events=await many(h);
 const ran=once(h,page,async()=>{await h.correct([replaced(events[1],30000)]);await h.correct([replaced(events[501],30000)]);});
 const r=await h.sheet();ran();assert.equal(r.body.totals.workedMs,15120000);h.stableEqual(r,await h.effective());
});
test('4.1 repeated instability stops after two attempts with safe TIME_LEDGER_CHANGED',async t=>{
 const h=await setup(t),events=await many(h);let changes=0;
 h.hooks.afterRead=async(table,result)=>{if(page(table,result)){changes++;await h.correct([replaced(events[1],changes*1000)]);}};
 const r=await h.sheet();assert.equal(changes,2);assert.equal(r.status,503);assert.equal(r.body.code,'TIME_LEDGER_CHANGED');
 assert.equal(r.body.events,undefined);assert.equal(r.body.totals,undefined);assert.doesNotMatch(JSON.stringify(r.body),/revision|watermark|SQL|credential|session/i);
});
for(const route of ['time','mine'])test(`4.1 ${route} current-week employee read retries timestamp correction and real append`,async t=>{
 const h=await setup(t),now=Date.now();
 const zone=['UTC','Asia/Tokyo','America/Los_Angeles'].find(z=>now-h.calc.businessWeek(now,z).startsAt>15*60000);
 await h.db.query('update public.businesses set timezone=$1 where id=$2',[zone,h.business]);
 const base=new Date(now-12*60000).toISOString(),events=await many(h,{base,step:'1 second'});
 const ran=once(h,page,()=>h.correct([replaced(events[1],500),replaced(events[501],500)]));const r=await h[route]();ran();assert.equal(r.status,200);
 const all=await h.effective(),shifts=h.calc.buildShifts(all),snapshot=Date.parse(r.body.serverNow),week=h.calc.businessWeek(snapshot,zone);
 const totals=h.calc.windowTotals(shifts,week.startsAt,week.endsAt,snapshot);
 if(route==='mine')for(const k of ['workedMs','paidBreakMs','mealBreakMs'])assert.equal(r.body.week[k],totals[k]);
 assert.equal(r.body.state,'OFF_CLOCK');
 const appended=once(h,page,async()=>assert.equal((await h.action('CLOCK_IN')).status,200));const next=await h[route]();appended();assert.equal(next.status,200);assert.equal(next.body.state,'WORKING');assert.ok(next.body.shift);
});
test('4.1 Working retries entire roster on correction and keeps one common snapshot without N+1',async t=>{
 const h=await setup(t),start=Date.now()-2*H;const other=await h.employee();
 const first=await h.event(h.target,'CLOCK_IN',start);await h.event(other,'CLOCK_IN',start);
 const beforeCalls=h.calls.length;
 const ran=once(h,(table,r)=>table==='employees'&&Array.isArray(r.data)&&r.data[0]?.latest!==undefined,()=>h.correct([{op:'INSERT',type:'CLOCK_OUT',occurredAt:new Date(start+H).toISOString(),after:first.id}]));
 const r=await h.get();ran();assert.equal(r.status,200);const a=r.body.employees.find(e=>e.employee.id===h.target),b=r.body.employees.find(e=>e.employee.id===other);
 assert.equal(a.state,'OFF_CLOCK');assert.equal(a.shift,null);assert.equal(b.state,'WORKING');assert.equal(b.shift.elapsedMs,Date.parse(r.body.snapshotAt)-start);
 // Four wrapper RPCs plus the correction helper's one version read.
 assert.equal(h.calls.slice(beforeCalls).filter(n=>n==='m06_ledger_read_versions').length,5);
 const from=h.calls.length;assert.equal((await h.get()).status,200);assert.equal(h.calls.length-from,2,'only two version requests, independent of roster size');
});
test('4.1 Working retries real clock append between heads and open-event load',async t=>{
 const h=await setup(t);await h.event(h.target,'CLOCK_IN',Date.now()-H);
 const ran=once(h,(table,r)=>table==='employees'&&Array.isArray(r.data)&&r.data[0]?.latest!==undefined,async()=>assert.equal((await h.action('CLOCK_OUT')).status,200));
 const r=await h.get();ran();assert.equal(r.status,200);assert.equal(r.body.employees.find(e=>e.employee.id===h.target).state,'OFF_CLOCK');
});
test('4.1 tokens are tenant-scoped, bigint-safe, STABLE/invoker and inaccessible to browser roles',async t=>{
 const h=await setup(t);const [empty]=await h.version();assert.equal(empty.originalWatermark,'0');assert.equal(empty.correctionRevision,'0');assert.deepEqual(await h.version(h.target,h.other),[]);
 for(const role of ['anon','authenticated'])await assert.rejects(as(h.db,role,'select public.m06_ledger_read_versions($1,$2)',[h.business,h.target]),e=>e.code==='42501');
 const f=(await h.db.query("select provolatile,prosecdef from pg_proc where proname='m06_ledger_read_versions'")).rows[0];assert.equal(f.provolatile,'s');assert.equal(f.prosecdef,false);
 await h.db.exec("alter table public.employee_time_events alter column seq restart with 9007199254740993");
 await h.event(h.target,'CLOCK_IN',Date.now()-H);assert.equal((await h.version())[0].originalWatermark,'9007199254740993');
});
test('4.1 watermark/revision and projection commit atomically; rejected correction and transaction rollback advance neither',async t=>{
 const h=await setup(t);assert.equal((await h.action('CLOCK_IN')).status,200);const v1=await h.version(),original=await h.effective();assert.ok(BigInt(v1[0].originalWatermark)>0n);
 await assert.rejects(h.correct([{op:'VOID',target:crypto.randomUUID()}]));assert.deepEqual(await h.version(),v1);
 const start=Date.parse(original[0].occurred_at);
 await h.correct([{op:'INSERT',type:'CLOCK_OUT',occurredAt:new Date(start).toISOString(),after:original[0].id}]);
 const v2=await h.version();assert.equal(v2[0].originalWatermark,v1[0].originalWatermark);assert.equal(v2[0].correctionRevision,'1');assert.equal((await h.effective()).at(-1).event_type,'CLOCK_OUT');
 // Critical lifecycle: next REAL clock-in uses the corrected state.
 assert.equal((await h.action('CLOCK_IN')).status,200);const v3=await h.version();assert.ok(BigInt(v3[0].originalWatermark)>BigInt(v2[0].originalWatermark));assert.equal(v3[0].correctionRevision,'1');
 const before=await h.effective();
 // Force rollback AFTER correction history and projection have both changed.
 await assert.rejects(h.db.transaction(async tx=>{
  await tx.exec('set local role service_role');
  const operations=[{op:'INSERT',type:'CLOCK_OUT',occurredAt:before.at(-1).occurred_at,after:before.at(-1).id}];
  const result=await tx.query("select public.m06_correct_employee_time($1,$2,$3,'account','owner',null,null,null,$4::jsonb,'Rollback regression',$5,$6,$7,true,null,null) as result",[h.business,h.target,h.account,JSON.stringify(operations),crypto.randomUUID(),v3[0].correctionRevision,v3[0].originalWatermark]);
  assert.equal(result.rows[0].result.ok,true);
  const token=(await tx.query('select public.m06_ledger_read_versions($1,$2) as v',[h.business,h.target])).rows[0].v[0];
  assert.equal(token.correctionRevision,'2');
  assert.equal((await tx.query('select event_type from public.employee_time_effective_events where employee_id=$1 order by seq desc limit 1',[h.target])).rows[0].event_type,'CLOCK_OUT');
  throw Error('forced correction rollback');
 }),/forced correction rollback/);
 assert.deepEqual(await h.version(),v3);assert.deepEqual(await h.effective(),before);
 await assert.rejects(h.db.transaction(async tx=>{await tx.query("insert into public.employee_time_events(business_id,employee_id,device_id,event_type,occurred_at,request_id) values ($1,$2,$3,'CLOCK_OUT',now(),$4)",[h.business,h.target,h.device,crypto.randomUUID()]);throw Error('rollback');}));
 assert.deepEqual(await h.version(),v3);assert.deepEqual(await h.effective(),before);
});
test('4.1 stable failures do not retry, missing version RPC fails closed, limits remain enforced',async t=>{
 const h=await setup(t);let reads=0;
 await assert.rejects(h.ledger.consistentLedgerRead(h.service,h.business,h.target,async()=>{reads++;throw new Error('stable fixture error');}),/stable fixture error/);assert.equal(reads,1);
 const rpc=h.service.rpc;h.service.rpc=async()=>({data:null,error:{code:'fixture'}});assert.equal((await h.sheet()).status,503);h.service.rpc=rpc;
 await many(h,{count:10002,step:'1 second'});const r=await h.sheet();assert.equal(r.status,503);assert.equal(r.body.code,'TIMESHEET_LIMIT_EXCEEDED');
});
