const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const {fixture}=require('./support/working-fixture.cjs');
const migration=fs.readFileSync('supabase/migrations/202610080001_wf01_workforce_visibility.sql','utf8');
// Executes the extracted target predicate ONLY against synthetic existing tables.
// Does not create/apply any WF01 function or claim migration integration.
test('WF01 SQL target predicate: owner/all, manager/verified self, no account self, no other managers/owners/cross-tenant',async t=>{
 const h=await fixture(t),employee=await h.employee(),otherManager=await h.employee({role:'manager'}),owner=await h.employee({role:'owner'}),foreign=await h.employee({tenant:h.other});
 let predicate=migration.match(/where e.business_id=p_business_id[\s\S]*?order by e.id limit 201/)[0];
 for(const [key,value]of Object.entries({p_business_id:'$1::uuid',p_employee_id:'$2::uuid',actor_role:'$3::text',p_authority_mode:'$4::text',p_actor_employee_id:'$5::uuid'}))predicate=predicate.replace(new RegExp('\\b'+key+'\\b','g'),value);
 const read=async(role,mode,self,filter=null)=>(await h.db.query('select e.id from public.employees e '+predicate,[h.business,filter,role,mode,self])).rows.map(r=>r.id);
 const own=await read('owner','account',null);assert.ok([employee,h.actor,otherManager,owner].every(id=>own.includes(id)));assert.ok(!own.includes(foreign));
 const manager=await read('manager','shared-device',h.actor);assert.ok(manager.includes(employee));assert.ok(manager.includes(h.actor));assert.ok(!manager.includes(otherManager));assert.ok(!manager.includes(owner));assert.ok(!(await read('manager','account',null)).includes(h.actor));
 assert.deepEqual(await read('manager','shared-device',h.actor,otherManager),[]);assert.deepEqual(await read('manager','shared-device',h.actor,owner),[]);assert.deepEqual(await read('manager','shared-device',h.actor,foreign),[]);assert.deepEqual(await read('staff','shared-device',employee),[]);
 assert.ok(!(await read('manager','shared-device',owner)).includes(owner));
});
test('WF01 export predicate enforces the same self rule, and all new reads revalidate actor through private targets',async t=>{
 const h=await fixture(t);let condition=migration.match(/if not \((actor_role='owner'[\s\S]*?)\) then raise exception 'Export authority unavailable'/)[1];
 for(const [key,value]of Object.entries({actor_role:'$1',p_authority_mode:'$2',p_actor_employee_id:'$3','target.role':'$4','target.id':'$5'}))condition=condition.split(key).join(value);
 const allowed=async(role,mode,self,targetRole,id)=>(await h.db.query('select ('+condition+') as allowed',[role,mode,self,targetRole,id])).rows[0].allowed;
 assert.equal(await allowed('manager','shared-device',h.actor,'manager',h.actor),true);assert.equal(await allowed('manager','account',null,'manager',h.actor),false);assert.equal(await allowed('manager','shared-device',h.actor,'manager',h.other),false);assert.equal(await allowed('manager','shared-device',h.actor,'owner',h.actor),false);assert.equal(await allowed('owner','account',null,'owner',h.actor),true);
 assert.match(migration,/m06_assert_management_actor/);assert.equal((migration.match(/from public.wf01_report_targets\(/g)||[]).length,2);assert.match(migration,/revoke all on function public.wf01_report_targets.*service_role/);assert.match(migration,/found_count<>cardinality/);
});
test('WF01 report request binds self to verified PIN identity; target spoofing cannot alter actor RPC parameters',async t=>{
 const h=await fixture(t),calls=[];const actual=h.service.rpc;h.service.rpc=async(name,args)=>{if(name==='wf01_report_dataset'){calls.push(args);return {data:[],error:null};}return actual.call(h.service,name,args);};
 const api=h.load('server/handlers/time-reports.ts');const r=await api.GET(h.request('/api/management/time-reports?employeeId='+h.other,{shared:true}));assert.equal(r.status,200);assert.equal(calls[0].p_actor_employee_id,h.actor);assert.equal(calls[0].p_employee_id,h.other);assert.equal(calls[0].p_actor_session_id,h.session);assert.equal(calls[0].p_business_id,h.business);
 const denied=await api.GET(h.request('/api/management/time-reports?actorEmployeeId='+h.other,{shared:true}));assert.equal(denied.status,400);assert.equal(calls.length,1);
});
test('WF01 daily report uses one snapshot for paid work, closed earlier work, open shifts and current state',async t=>{
 const h=await fixture(t);await h.db.query("update public.businesses set timezone='UTC' where id=$1",[h.business]);const former=await h.employee({active:false}),open=await h.employee();const day='2026-03-03';
 await h.event(former,'CLOCK_IN',Date.parse(day+'T09:00:00Z'));await h.event(former,'BREAK_START',Date.parse(day+'T10:00:00Z'),'PAID');await h.event(former,'BREAK_END',Date.parse(day+'T10:15:00Z'),'PAID');await h.event(former,'BREAK_START',Date.parse(day+'T12:00:00Z'),'MEAL');await h.event(former,'BREAK_END',Date.parse(day+'T12:30:00Z'),'MEAL');await h.event(former,'CLOCK_OUT',Date.parse(day+'T17:00:00Z'));await h.event(open,'CLOCK_IN',Date.parse(day+'T09:00:00Z'));
 const report=await h.load('server/time-reports.ts').timeReport(h.service,h.business,'owner',{startDate:day,endDate:day},true);const closed=report.workforceRows.find(r=>r.employeeId===former);assert.equal(closed.state,'OFF_CLOCK');assert.equal(closed.isActive,false);assert.equal(closed.finalPaidMs,7.5*3600000);assert.equal(closed.activeWorkMs,7.25*3600000);assert.equal(closed.open,false);assert.equal(report.workforceRows.find(r=>r.employeeId===open).open,true);assert.equal(report.workforceRows.find(r=>r.employeeId===open).state,'WORKING');
 assert.equal(report.summaryRows.reduce((s,r)=>s+r.finalPaidMs,0),report.allocations.reduce((s,r)=>s+r.finalPaidMs,0));
});

test('WF01 existing working API also prevents manager exposure of other managers/owners; account-only gets no self',async t=>{
 const h=await fixture(t),otherManager=await h.employee({role:'manager'}),owner=await h.employee({role:'owner'}),employee=await h.employee();await h.db.query("update public.business_members set role='manager'");
 const account=await h.get();assert.equal(account.status,200);assert.ok(account.body.employees.some(r=>r.employee.id===employee));assert.ok(!account.body.employees.some(r=>[h.actor,otherManager,owner].includes(r.employee.id)));
 const shared=await h.get({shared:true});assert.ok(shared.body.employees.some(r=>r.employee.id===h.actor));assert.ok(!shared.body.employees.some(r=>[otherManager,owner].includes(r.employee.id)));
});

test('WF01 unavailable migration fails closed, without returning CSV or claiming zero-hour success',async t=>{
 const h=await fixture(t,{workforce:false}),api=h.load('server/handlers/time-reports.ts');const get=await api.GET(h.request('/api/management/time-reports'));assert.equal(get.status,503);const exported=await api.EXPORT(new Request('https://zude.test/api/management/time-reports/export',{method:'POST',headers:{Authorization:'Bearer synthetic-account'},body:JSON.stringify({format:'summary-v1'})}));assert.equal(exported.status,503);assert.equal((await exported.json()).csv,undefined);
});
test('WF01 report API denies employee PIN and cross-business before calling the dataset',async t=>{
 const h=await fixture(t),api=h.load('server/handlers/time-reports.ts'),calls=[];const actual=h.service.rpc;h.service.rpc=async(name,args)=>{calls.push(name);return actual.call(h.service,name,args);};
 assert.equal((await api.GET(h.request('/api/management/time-reports',{headers:{'x-anaai-business-id':h.other}}))).status,403);
 await h.db.query("update public.employees set role='employee' where id=$1",[h.actor]);assert.equal((await api.GET(h.request('/api/management/time-reports',{shared:true}))).status,403);assert.ok(!calls.includes('wf01_report_dataset'));
});
