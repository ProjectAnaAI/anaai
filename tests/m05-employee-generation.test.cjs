// Required real SQL regression. Synthetic credentials never appear in output.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {fixture}=require('./support/working-fixture.cjs');
const {as}=require('./support/pglite-db.cjs');
async function setup(t){
 const h=await fixture(t),employee=await h.employee(),session=await h.sessionFor(employee);
 const clock=h.load('server/handlers/time-clock.ts');
 const request=(method='GET',key=crypto.randomUUID(),body={})=>new Request('https://zude.test/api/time-clock',{method,headers:{Authorization:`ZudeDevice ${h.deviceCredential}`,'x-zude-employee-session':session.value,'Idempotency-Key':key},...(method==='POST'?{body:JSON.stringify(body)}:{})});
 const counts=async()=>(await h.db.query('select (select count(*)::int from public.employee_time_issues where employee_id=$1) issues,(select count(*)::int from public.employee_time_events where employee_id=$1) originals,(select count(*)::int from public.employee_time_effective_events where employee_id=$1) effective',[employee])).rows[0];
 const issue=(key=crypto.randomUUID(),note='Synthetic issue')=>as(h.db,'service_role','select public.m05_report_time_issue($1,$2,$3,$4,$5,null,null,$6) as r',[h.business,employee,h.device,session.id,key,note]).then(r=>r.rows[0].r);
 const punch=(key=crypto.randomUUID())=>as(h.db,'service_role',"select public.m05_record_time_event($1,$2,$3,$4,'CLOCK_IN',null,$5) as r",[h.business,employee,h.device,session.id,key]).then(r=>r.rows[0].r);
 const stale=()=>h.db.query("update public.employees set updated_at=(select created_at+interval '1 second' from public.employee_sessions where id=$1) where id=$2",[session.id,employee]);
 return {...h,employee,pin:session,clock,request,counts,issue,punch,stale};
}
const denied=e=>e.code==='42501'&&e.message==='Employee identity unavailable';
test('generation: previously HTTP-valid identity cannot issue or clock after employee generation advances without revocation',async t=>{
 const h=await setup(t);assert.equal((await h.clock.STATE(h.request())).status,200);
 await h.stale();assert.equal((await h.clock.STATE(h.request())).status,401);
 assert.equal((await h.db.query('select revoked_at from public.employee_sessions where id=$1',[h.pin.id])).rows[0].revoked_at,null);
 await assert.rejects(h.issue(),denied);await assert.rejects(h.punch(),denied);
 assert.deepEqual(await h.counts(),{issues:0,originals:0,effective:0});
});
for(const route of ['REPORT_ISSUE','CLOCK_IN'])test(`generation: ${route} rejects SQL race after HTTP credential validation`,async t=>{
 const h=await setup(t),rpc=h.service.rpc;let reached=false;
 h.service.rpc=async(name,args)=>{if(name=== (route==='REPORT_ISSUE'?'m05_report_time_issue':'m05_record_time_event')){reached=true;await h.stale();}return rpc(name,args);};
 const response=await h.clock[route](h.request('POST',crypto.randomUUID(),route==='REPORT_ISSUE'?{note:'Synthetic issue'}:{}));assert.ok(reached);assert.equal(response.status,401);
 assert.equal((await response.json()).code,'IDENTITY_UNAUTHORIZED');assert.deepEqual(await h.counts(),{issues:0,originals:0,effective:0});
});
for(const [label,delta,valid] of [['older', '-1 millisecond',true],['equal','0 microseconds',true],['same JS millisecond','1 microsecond',true],['newer millisecond','1 millisecond',false]])test(`generation precision: ${label} agrees with server`,async t=>{
 const h=await setup(t);
 await h.db.query("update public.zude_devices set updated_at=date_trunc('second',updated_at)+interval '123 milliseconds' where id=$1",[h.device]);
 await h.db.query('update public.employee_sessions set created_at=(select updated_at from public.zude_devices where id=$1) where id=$2',[h.device,h.pin.id]);
 await h.db.query('update public.employees set updated_at=(select created_at+$1::interval from public.employee_sessions where id=$2) where id=$3',[delta,h.pin.id,h.employee]);
 assert.equal((await h.clock.STATE(h.request())).status,valid?200:401);
 if(valid){const ik=crypto.randomUUID(),ck=crypto.randomUUID();assert.equal((await h.issue(ik)).replayed,false);assert.equal((await h.issue(ik)).replayed,true);assert.equal((await h.issue(ik,'Changed payload')).code,'TIME_REQUEST_CONFLICT');assert.equal((await h.punch(ck)).replayed,false);assert.equal((await h.punch(ck)).replayed,true);assert.deepEqual(await h.counts(),{issues:1,originals:1,effective:1});}
 else {await assert.rejects(h.issue(),denied);await assert.rejects(h.punch(),denied);assert.deepEqual(await h.counts(),{issues:0,originals:0,effective:0});}
});
for(const rule of ['revoked session','expired session','inactive employee','revoked device','stale device','foreign business','wrong employee','wrong device'])test(`generation preserves ${rule} rejection`,async t=>{
 const h=await setup(t);
 const changes={
 'revoked session':["update public.employee_sessions set revoked_at=now() where id=$1",h.pin.id],
 'expired session':["update public.employee_sessions set expires_at=now()-interval '1 second' where id=$1",h.pin.id],
 'inactive employee':['update public.employees set is_active=false where id=$1',h.employee],
 'revoked device':['update public.zude_devices set revoked_at=now() where id=$1',h.device],
 'stale device':["update public.zude_devices set updated_at=updated_at+interval '1 millisecond' where id=$1",h.device]};
 if(changes[rule])await h.db.query(changes[rule][0],[changes[rule][1]]);
 else {
 const business=rule==='foreign business'?h.other:h.business,employee=rule==='wrong employee'?h.actor:h.employee,device=rule==='wrong device'?crypto.randomUUID():h.device;
 for(const sql of ["select public.m05_record_time_event($1,$2,$3,$4,'CLOCK_IN',null,$5)","select public.m05_report_time_issue($1,$2,$3,$4,$5,null,null,'Synthetic issue')"])
 await assert.rejects(as(h.db,'service_role',sql,[business,employee,device,h.pin.id,crypto.randomUUID()]),denied);
 assert.deepEqual(await h.counts(),{issues:0,originals:0,effective:0});return;
 }
 await assert.rejects(h.issue(),denied);await assert.rejects(h.punch(),denied);assert.deepEqual(await h.counts(),{issues:0,originals:0,effective:0});
});
test('generation invalidation rejects replays without partial writes or consuming fresh request keys',async t=>{
 const h=await setup(t),ik=crypto.randomUUID(),ck=crypto.randomUUID();await h.issue(ik);await h.punch(ck);const before=await h.counts();await h.stale();
 await assert.rejects(h.issue(ik),denied);await assert.rejects(h.punch(ck),denied);assert.deepEqual(await h.counts(),before);
 const key=crypto.randomUUID();await assert.rejects(h.issue(key),denied);
 // New current device/session generation permits the previously rejected key.
 await h.db.query('update public.zude_devices set updated_at=(select updated_at from public.employees where id=$1) where id=$2',[h.employee,h.device]);
 await h.db.query('update public.employee_sessions set created_at=(select updated_at from public.zude_devices where id=$1) where id=$2',[h.device,h.pin.id]);
 assert.equal((await h.issue(key)).replayed,false);
});
