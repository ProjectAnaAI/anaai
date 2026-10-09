// Full RPC/handler integration against disposable in-memory PostgreSQL only.
const {test}=require('node:test');const assert=require('node:assert/strict');const {fixture}=require('./support/working-fixture.cjs');const H=3600000;
async function setup(t){const h=await fixture(t);await h.db.query("update public.businesses set timezone='UTC' where id=$1",[h.business]);const employee=await h.employee(),otherManager=await h.employee({role:'manager'}),owner=await h.employee({role:'owner'}),former=await h.employee({active:false}),zero=await h.employee(),foreign=await h.employee({tenant:h.other});
 for(const id of [employee,h.actor,otherManager,owner,former]){await h.event(id,'CLOCK_IN',Date.parse('2026-03-03T09:00:00Z'));await h.event(id,'CLOCK_OUT',Date.parse('2026-03-03T10:00:00Z'));}
 const api=h.load('server/handlers/time-reports.ts'),daily=h.load('server/handlers/workforce.ts'),range={startDate:'2026-03-03',endDate:'2026-03-03'};
 const result=async r=>({status:r.status,body:await r.json()});
 const get=(filters={},opts={})=>api.GET(h.request('/api/management/time-reports?'+new URLSearchParams({...range,...filters}),opts)).then(result);
 const exports=(format,filters={},opts={})=>api.EXPORT(new Request('https://zude.test/api/management/time-reports/export',{method:'POST',headers:Object.fromEntries(h.request('/',opts).headers),body:JSON.stringify({...range,...filters,format})})).then(result);
 const workforce=(opts={},date='2026-03-03')=>daily.GET(h.request('/api/management/workforce?date='+date,opts)).then(result);
 const directory=opts=>api.DIRECTORY(h.request('/api/management/time-reports/directory',opts)).then(result);
 return {...h,createEmployee:h.employee,employee,otherManager,owner,former,zero,foreign,api,daily,get,exports,workforce,directory};}
test('WF01A installed RPC signatures, definer/search_path and execution grants',async t=>{
 const h=await setup(t);const rows=(await h.db.query("select proname,prosecdef,proconfig,has_function_privilege('anon',oid,'execute') anon,has_function_privilege('authenticated',oid,'execute') authenticated,has_function_privilege('service_role',oid,'execute') service from pg_proc where pronamespace='public'::regnamespace and proname in ('wf01_report_targets','wf01_report_dataset','wf01_report_directory','m06_record_time_export')")).rows;
 assert.equal(rows.length,4);for(const r of rows){assert.equal(r.prosecdef,true);assert.ok(r.proconfig.some(v=>v.startsWith('search_path=')));assert.equal(r.anon,false);assert.equal(r.authenticated,false);assert.equal(r.service,r.proname!=='wf01_report_targets');}
});
test('WF01A owner all roles; account-manager employees only; PIN-manager verified self; private/foreign targets denied',async t=>{
 const h=await setup(t);let r=await h.get();assert.equal(r.status,200);assert.equal(r.body.summaryRows.length,5);assert.equal(r.body.totals.workedMs,5*H);assert.ok(!r.body.summaryRows.some(r=>r.employeeId===h.zero));
 await h.db.query("update public.business_members set role='manager'");r=await h.get();assert.equal(r.status,200);assert.equal(r.body.totals.workedMs,2*H);assert.ok(r.body.summaryRows.some(r=>r.employeeId===h.former));assert.ok(!r.body.summaryRows.some(r=>r.employeeId===h.actor));
 r=await h.get({}, {shared:true});assert.equal(r.status,200);assert.equal(r.body.totals.workedMs,3*H);assert.ok(r.body.summaryRows.some(r=>r.employeeId===h.actor));
 for(const id of [h.otherManager,h.owner,h.foreign])assert.equal((await h.get({employeeId:id},{shared:true})).status,404);
 assert.equal((await h.get({employeeId:h.actor},{shared:true})).body.totals.workedMs,H);
 const dir=await h.directory({shared:true});assert.equal(dir.status,200);assert.ok(dir.body.employees.some(r=>r.id===h.actor));assert.ok(!dir.body.employees.some(r=>[h.owner,h.otherManager,h.foreign].includes(r.id)));
});
test('WF01A effective account/PIN restrictions, spoofed identity, cross-business and switched/revoked user',async t=>{
 const h=await setup(t);assert.equal((await h.get({actorEmployeeId:h.owner},{shared:true})).status,400);assert.equal((await h.get({}, {headers:{'x-anaai-business-id':h.other}})).status,403);
 const employeeSession=await h.sessionFor(h.employee);assert.equal((await h.get({}, {shared:true,headers:{'x-zude-employee-session':employeeSession.value}})).status,403);
 const ownerSession=await h.sessionFor(h.owner);await h.db.query("update public.business_members set role='manager'");const r=await h.get({}, {shared:true,headers:{'x-zude-employee-session':ownerSession.value}});assert.equal(r.status,200);assert.ok(!r.body.summaryRows.some(r=>[h.actor,h.otherManager,h.owner].includes(r.employeeId)));
 await h.db.query('update public.employee_sessions set revoked_at=now() where id=$1',[h.session]);assert.equal((await h.get({}, {shared:true})).status,401);assert.equal((await h.workforce({shared:true})).status,401);
});
test('WF01A manager summary/detail exports include self and reconcile exact authorized totals and audit',async t=>{
 const h=await setup(t);await h.db.query("update public.business_members set role='manager'");for(const format of ['summary-v1','shifts-v1']){const r=await h.exports(format,{}, {shared:true});assert.equal(r.status,200);assert.equal(r.body.report.totals.workedMs,3*H);assert.ok(r.body.csv.includes(h.actor));assert.ok(!r.body.csv.includes(h.otherManager));assert.ok(!r.body.csv.includes(h.owner));
 assert.equal(r.body.report.summaryRows.reduce((s,r)=>s+r.finalPaidMs,0),r.body.report.allocations.reduce((s,r)=>s+r.finalPaidMs,0));for(const row of r.body.report.summaryRows)assert.equal(row.activeWorkMs+row.paidBreakMs,row.finalPaidMs);}
 assert.equal((await h.db.query("select count(*)::int n from public.employee_management_actions where action='report.exported'")).rows[0].n,2);
 for(const id of [h.otherManager,h.owner,h.foreign]){const r=await h.exports('summary-v1',{employeeId:id},{shared:true});assert.equal(r.status,404);assert.equal(r.body.csv,undefined);}
});
for(const change of ['session','device','actor-role','target-role'])test(`WF01A export revalidation blocks ${change} change after dataset`,async t=>{
 const h=await setup(t);await h.db.query("update public.business_members set role='manager'");const rpc=h.service.rpc;let changed=false;h.service.rpc=async(name,args)=>{const r=await rpc(name,args);if(name==='wf01_report_dataset'&&!changed){changed=true;if(change==='session')await h.db.query('update public.employee_sessions set revoked_at=now() where id=$1',[h.session]);if(change==='device')await h.db.query('update public.zude_devices set revoked_at=now() where id=$1',[h.device]);if(change==='actor-role')await h.db.query("update public.business_members set role='staff'");if(change==='target-role')await h.db.query("update public.employees set role='owner' where id=$1",[h.employee]);}return r;};
 const r=await h.exports('summary-v1',{}, {shared:true});assert.ok([401,403].includes(r.status));assert.equal(r.body.csv,undefined);assert.equal((await h.db.query("select count(*)::int n from public.employee_management_actions where action='report.exported'")).rows[0].n,0);
});
test('WF01A Today includes closed historical/self hours and distinguishes work/break/earlier with one snapshot',async t=>{
 const h=await setup(t);const open=await h.createEmployee(),paid=await h.createEmployee(),meal=await h.createEmployee();for(const id of [open,paid,meal])await h.event(id,'CLOCK_IN',Date.parse('2026-03-03T09:00:00Z'));
 await h.event(paid,'BREAK_START',Date.parse('2026-03-03T10:00:00Z'),'PAID');await h.event(meal,'BREAK_START',Date.parse('2026-03-03T10:00:00Z'),'MEAL');
 const r=await h.workforce({shared:true});assert.equal(r.status,200);assert.ok(r.body.employees.some(r=>r.employeeId===h.actor));assert.ok(r.body.employees.some(r=>r.employeeId===h.former&&!r.isActive&&r.state==='OFF_CLOCK'));assert.ok(!r.body.employees.some(r=>[h.owner,h.otherManager,h.zero].includes(r.employeeId)));
 for(const [id,state]of [[open,'WORKING'],[paid,'ON_PAID_BREAK'],[meal,'ON_MEAL_BREAK']]){const row=r.body.employees.find(r=>r.employeeId===id);assert.equal(row.state,state);assert.equal(row.open,true);assert.equal(row.activeWorkMs+row.paidBreakMs,row.finalPaidMs);}
 assert.equal(r.body.employees.find(r=>r.employeeId===meal).finalPaidMs,H);assert.equal(r.body.date,'2026-03-03');assert.equal((await h.workforce({},'2026-02-30')).status,400);
 const owner=await h.workforce();assert.ok(owner.body.employees.some(r=>r.employeeId===h.owner));assert.ok(owner.body.employees.some(r=>r.employeeId===h.otherManager));
});
test('WF01A direct RPC rejects forged actor identity even under service_role',async t=>{
 const h=await setup(t),args={p_business_id:h.business,p_actor_id:h.account,p_authority_mode:'shared-device',p_expected_account_role:'owner',p_actor_employee_id:h.otherManager,p_actor_device_id:h.device,p_actor_session_id:h.session};const r=await h.service.rpc('wf01_report_directory',args);assert.equal(r.error.code,'28000');
 const other=await h.service.rpc('wf01_report_directory',{...args,p_actor_employee_id:h.actor,p_business_id:h.other});assert.equal(other.error.code,'42501');
});

for(const [label,zone,day,start,end,hours]of [['spring','America/New_York','2026-03-08','2026-03-08T05:00:00Z','2026-03-09T04:00:00Z',23],['fall','America/New_York','2025-11-02','2025-11-02T04:00:00Z','2025-11-03T05:00:00Z',25]])test(`WF01A Today ${label} DST uses business-local day and authoritative allocation`,async t=>{
 const h=await setup(t);await h.db.query('update public.businesses set timezone=$1 where id=$2',[zone,h.business]);const id=await h.createEmployee();await h.event(id,'CLOCK_IN',Date.parse(start));await h.event(id,'CLOCK_OUT',Date.parse(end));const r=await h.workforce({shared:true},day);assert.equal(r.status,200);assert.equal(r.body.timezone,zone);assert.equal(r.body.date,day);assert.equal(r.body.employees.length,1);assert.equal(r.body.employees[0].finalPaidMs,hours*H);assert.equal(r.body.employees[0].state,'OFF_CLOCK');assert.equal(r.body.employees[0].open,false);
 const exported=await h.exports('shifts-v1',{startDate:day,endDate:day},{shared:true});assert.equal(exported.status,200);assert.equal(exported.body.report.allocations.reduce((s,r)=>s+r.finalPaidMs,0),hours*H);
});
test('WF01A Today includes overnight carry-in for an inactive historical worker',async t=>{
 const h=await setup(t),id=await h.createEmployee({active:false});await h.event(id,'CLOCK_IN',Date.parse('2026-01-15T23:00:00Z'));await h.event(id,'CLOCK_OUT',Date.parse('2026-01-16T02:00:00Z'));const r=await h.workforce({shared:true},'2026-01-16');assert.equal(r.status,200);assert.equal(r.body.employees.length,1);assert.equal(r.body.employees[0].employeeId,id);assert.equal(r.body.employees[0].finalPaidMs,2*H);assert.equal(r.body.employees[0].isActive,false);
});
