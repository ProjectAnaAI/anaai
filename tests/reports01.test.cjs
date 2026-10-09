const {test}=require('node:test');const assert=require('node:assert/strict');const {fixture}=require('./support/working-fixture.cjs');const {load}=require('./support/native-management.cjs');
const periods=load('features/management/reportPeriods.ts');const H=3600000;
test('REPORTS01 periods, explicit fourteen-day start, month halves, leap years, bounds and business timezone',()=>{
 const r=(kind,start='',end='',today='2026-10-08')=>periods.periodRange(kind,today,start,end);
 assert.equal(r('Weekly').startDate,'2026-10-05');assert.equal(r('Weekly').endDate,'2026-10-08');assert.equal(r('Weekly').capped,true);
 assert.equal(r('Every two weeks','2026-09-21').endDate,'2026-10-04');assert.throws(()=>r('Every two weeks'),/first day/);
 assert.equal(r('Twice monthly','2026-09-02').endDate,'2026-09-15');assert.equal(r('Twice monthly','2026-09-20').endDate,'2026-09-30');
 assert.equal(r('Monthly','2024-02-01').endDate,'2024-02-29');assert.equal(r('Monthly','2025-02-01').endDate,'2025-02-28');
 assert.equal(r('Custom','2026-07-08','2026-10-08').endDate,'2026-10-08');assert.throws(()=>r('Custom','2026-07-07','2026-10-08'),/93/);
 assert.throws(()=>r('Custom','2026-10-09','2026-10-10'));assert.throws(()=>r('Custom','2026-10-08','2026-10-07'));assert.throws(()=>r('Custom','2026-02-30','2026-03-01'));
 assert.equal(periods.businessToday('America/Los_Angeles',Date.parse('2026-10-09T01:00:00Z')),'2026-10-08');
});
async function setup(t){const h=await fixture(t);await h.db.query("update public.businesses set timezone='UTC' where id=$1",[h.business]);return {...h,reports:h.load('server/time-reports.ts'),api:h.load('server/handlers/time-reports.ts')};}
const range={startDate:'2026-03-03',endDate:'2026-03-04'};
const event=(h,id,type,stamp,kind=null)=>h.event(id,type,Date.parse(stamp),kind);
test('REPORTS01 inclusion, former workers, all owner-visible roles, names and exact shift allocation reconcile',async t=>{
 const h=await setup(t);const inside=await h.employee({name:'Same',active:false}),before=await h.employee({name:'Before'}),after=await h.employee({name:'After'}),duplicate=await h.employee({name:'Same'}),owner=await h.employee({role:'owner',name:'Owner'});
 await event(h,inside,'CLOCK_IN','2026-03-02T23:00:00Z');await event(h,inside,'BREAK_START','2026-03-03T01:00:00Z','PAID');await event(h,inside,'BREAK_END','2026-03-03T01:10:00Z','PAID');await event(h,inside,'BREAK_START','2026-03-03T02:00:00Z','MEAL');await event(h,inside,'BREAK_END','2026-03-03T02:30:00Z','MEAL');await event(h,inside,'CLOCK_OUT','2026-03-04T01:00:00Z');
 for(const [id,start,end]of [[before,'2026-03-01T09:00:00Z','2026-03-01T10:00:00Z'],[after,'2026-03-05T09:00:00Z','2026-03-05T10:00:00Z'],[duplicate,'2026-03-03T09:00:00Z','2026-03-03T10:00:00Z'],[h.actor,'2026-03-03T09:00:00Z','2026-03-03T10:00:00Z'],[owner,'2026-03-03T09:00:00Z','2026-03-03T10:00:00Z']]){await event(h,id,'CLOCK_IN',start);await event(h,id,'CLOCK_OUT',end);}
 const r=await h.reports.timeReport(h.service,h.business,'owner',range,true);assert.equal(r.summaryRows.length,4);assert.ok(r.summaryRows.some(row=>row.employeeId===owner&&row.employeeRole==='owner'));assert.ok(r.summaryRows.some(row=>row.employeeId===inside));assert.ok(!r.summaryRows.some(row=>[before,after].includes(row.employeeId)));assert.equal(r.summaryRows.filter(row=>row.employee==='Same').length,2);
 for(const row of r.summaryRows)assert.equal(row.activeWorkMs+row.paidBreakMs,row.finalPaidMs);
 assert.equal(r.summaryRows.find(row=>row.employeeId===inside).finalPaidMs,24.5*H);
 for(const key of ['workedMs','paidBreakMs','mealBreakMs','activeWorkMs','finalPaidMs'])assert.equal(r.allocations.reduce((sum,row)=>sum+row[key],0),key==='activeWorkMs'?r.totals.workedMs-r.totals.paidBreakMs:key==='finalPaidMs'?r.totals.workedMs:r.totals[key]);
 assert.equal(r.allocations.filter(row=>row.employeeId===inside).length,2);assert.equal(r.allocations.find(row=>row.employeeId===inside).continuesFromPreviousDay,true);
 const m=await h.reports.timeReport(h.service,h.business,'manager',range,true);assert.ok(!m.summaryRows.some(row=>[h.actor,owner].includes(row.employeeId)));
 assert.throws(()=>h.reports.paidHours({workedMs:1,paidBreakMs:2,mealBreakMs:0}),e=>e.code==='TIME_INTEGRITY_ERROR');
});
for(const [label,zone,day,start,end,hours]of [['spring','America/New_York','2026-03-08','2026-03-08T05:00:00Z','2026-03-09T04:00:00Z',23],['fall','America/New_York','2025-11-02','2025-11-02T04:00:00Z','2025-11-03T05:00:00Z',25]])test(`REPORTS01 ${label} detailed allocations use existing DST day bounds`,async t=>{const h=await setup(t),id=await h.employee();await h.db.query('update public.businesses set timezone=$1 where id=$2',[zone,h.business]);await event(h,id,'CLOCK_IN',start);await event(h,id,'CLOCK_OUT',end);const r=await h.reports.timeReport(h.service,h.business,'owner',{startDate:day,endDate:day},true);assert.equal(r.allocations[0].finalPaidMs,hours*H);assert.equal(r.summaryRows[0].finalPaidMs,hours*H);});
test('REPORTS01 formats preserve legacy CSV, exact columns, snapshot, provisional timestamps and audited row counts',async t=>{
 const h=await setup(t),id=await h.employee({name:'=FORMULA,"Name"'});await event(h,id,'CLOCK_IN','2026-03-03T09:00:00Z');await event(h,id,'BREAK_START','2026-03-03T10:00:00Z','PAID');
 for(const format of ['daily-v1','summary-v1','shifts-v1']){
 const response=await h.api.EXPORT(new Request('https://zude.test/api/management/time-reports/export',{method:'POST',headers:{Authorization:'Bearer synthetic-account'},body:JSON.stringify({...range,employeeId:id,format})}));assert.equal(response.status,200);const body=await response.json();assert.equal(body.format,format);assert.ok(body.auditId);assert.equal(body.report.summaryRows[0].open,true);
 assert.equal(body.csv,h.reports.hoursCsv(body.report,format));assert.match(body.csv,/FORMULA/);assert.ok(body.csv.includes("'=FORMULA"));
 if(format==='shifts-v1'){assert.match(body.csv,/clock_out_utc/);assert.match(body.csv,/durations this allocation only/);assert.equal(body.report.allocations[0].clockOutAt,null);}
 if(format==='summary-v1'){assert.match(body.csv,/active_work_ms/);assert.match(body.csv,/not payroll approved/);assert.ok(body.csv.includes(body.report.snapshotAt));}
 if(format==='daily-v1')assert.equal(body.csv,h.reports.reportCsv(body.report));
 }
 assert.equal((await h.db.query("select count(*)::int n from public.employee_management_actions where action='report.exported'")).rows[0].n,3);
});
test('REPORTS01 picker stages dates in a neutral calendar; Cancel preserves value and Done confirms explicitly',()=>{
 const {screen}=require('./support/native-management.cjs');const changes=[];
 const h=screen('features/management/ReportDateField.tsx',{'../identity/EmployeeIdentityContext':{useEmployeeIdentity:()=>({recordEmployeeActivity:()=>true})},'@react-native-community/datetimepicker':{default:'DateTimePicker'},'./reportPeriods':periods},'ReportDateField',{label:'Start',value:'2026-03-03',timezone:'America/Los_Angeles',onChangeText:value=>changes.push(value)});
 h.click('2026-03-03');let picker=h.nodes().find(n=>n.type==='DateTimePicker');assert.equal(picker.props.display,'spinner');assert.equal(picker.props.timeZoneName,'UTC');picker.props.onValueChange({},new Date('2026-03-05T12:00:00Z'));h.render();h.click('Cancel');assert.deepEqual(changes,[]);
 h.click('2026-03-03');picker=h.nodes().find(n=>n.type==='DateTimePicker');picker.props.onValueChange({},new Date('2026-03-05T12:00:00Z'));h.render();h.click('Done');assert.deepEqual(changes,['2026-03-05']);h.dispose();
});
test('REPORTS01 new CSV row/byte limits and unsafe negative active work fail explicitly',async t=>{
 const h=await setup(t);assert.throws(()=>h.reports.paidHours({workedMs:-1,paidBreakMs:0,mealBreakMs:0}));
 const row={employeeId:'e',employee:'Name',employeeRole:'employee',workedMs:1,paidBreakMs:0,mealBreakMs:0,activeWorkMs:1,finalPaidMs:1,open:false,corrected:false};
 const r={businessId:h.business,range:{startDate:'2026-03-03',endDate:'2026-03-03'},timezone:'UTC',snapshotAt:'2026-03-03T00:00:00Z',exceptions:[],summaryRows:Array.from({length:20001},()=>row)};
 assert.throws(()=>h.reports.hoursCsv(r,'summary-v1'),e=>e.code==='REPORT_LIMIT_EXCEEDED');r.summaryRows=[{...row,employee:'x'.repeat(2*1024*1024)}];assert.throws(()=>h.reports.hoursCsv(r,'summary-v1'),e=>e.code==='REPORT_LIMIT_EXCEEDED');
});
test('REPORTS01 metadata-rich daily CSV preserves quoted record boundaries and exact amounts',async t=>{
 const h=await setup(t),id=await h.employee({name:'Quoted,"name"\nsecond line'});await event(h,id,'CLOCK_IN','2026-03-03T09:00:00Z');await event(h,id,'CLOCK_OUT','2026-03-03T10:00:00Z');const r=await h.reports.timeReport(h.service,h.business,'owner',range,true);const csv=h.reports.hoursCsv(r,'daily-v2');assert.match(csv,/snapshot_at/);assert.ok(csv.includes('Quoted,""name""\nsecond line'));assert.ok(csv.includes(r.snapshotAt));assert.equal(h.reports.exportRows(r,'daily-v2'),1);
});
test('REPORTS01 zero-paid open meal intervals remain visible as supported Needs Review warnings',async t=>{
 const h=await setup(t),id=await h.employee();await event(h,id,'CLOCK_IN','2026-03-02T09:00:00Z');await event(h,id,'BREAK_START','2026-03-02T09:00:00Z','MEAL');const r=await h.reports.timeReport(h.service,h.business,'owner',{startDate:'2026-03-03',endDate:'2026-03-03'},true);assert.equal(r.summaryRows.length,0);assert.equal(r.exceptions.length,1);assert.equal(r.exceptions[0].employeeId,id);assert.equal(r.allocations[0].finalPaidMs,0);assert.equal(r.allocations[0].mealBreakMs,24*H);assert.match(r.integrityCoverage,/not assessed/);
});
