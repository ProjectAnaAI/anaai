const {test}=require('node:test');const assert=require('node:assert/strict');
const {screen,load,ApiError}=require('./support/native-management.cjs');
const routes=load('navigation/reviewContext.ts');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const report={id:A,employee_id:B,employee_name:'Alice',note:'Original report',work_date:'2026-10-06',created_at:'2026-10-06T12:00:00Z',status:'open'};
const detail={issue:report,timesheet:{timezone:'UTC',totals:{workedMs:0},days:[{date:'2026-10-06',workedMs:0,shifts:[]}]},recentCorrections:[],referencedEventVoided:false};
function issues(props={},over={}){const calls=[];const h=screen('features/management/TimeIssuesScreen.tsx',({context})=>{Object.assign(context,over);return {'../../lib/time-issues-api':{issueMessage:()=> 'Access or records changed. Refresh.',getIssues:(business,status,cursor,signal)=>new Promise((resolve,reject)=>calls.push({kind:'list',status,cursor,signal,resolve,reject})),getIssue:(business,id,signal)=>new Promise((resolve,reject)=>calls.push({kind:'detail',id,signal,resolve,reject})),resolveIssue:(business,user,id,intent,signal)=>new Promise((resolve,reject)=>calls.push({kind:'resolve',id,intent,signal,resolve,reject}))}};},'TimeIssuesScreen',props);return {h,calls};}
test('route context accepts UUID selections but rejects repeated, malformed and impossible dates',()=>{
 assert.equal(routes.issueContext({issueId:A}).id,A);
 for(const issueId of [[],[A,A],'bad','',null])assert.equal(routes.issueContext({issueId}).invalid,true);
 for(const params of [{employeeId:'bad'},{employeeId:[A]},{employeeId:A,day:'2026-02-30'},{employeeId:A,weekStart:'2026-10-06'},{employeeId:A,weekStart:'2026-10-05',day:'2026-10-12'},{day:'2026-10-06'}])assert.equal(routes.timesheetContext(params).invalid,true);
 assert.equal(routes.timesheetContext({employeeId:A,day:'2026-10-06'}).context.week,'2026-10-05');
});
test('Today handoff uses business-local shift date and correct Monday week',()=>{
 const destination=routes.timesheetDestination(A,'2026-10-06T01:00:00Z','America/Los_Angeles');
 assert.equal(destination.params.day,'2026-10-05');assert.equal(destination.params.weekStart,'2026-10-05');assert.equal(destination.params.employeeId,A);
});
test('route wrappers remount selections on parameter changes and pass validated context only',()=>{
 for(const [file,name,helper,param]of [['app/time-issues.tsx','TimeIssuesScreen','issueContext',{issueId:A}],['app/timesheets.tsx','TimesheetsScreen','timesheetContext',{employeeId:B,day:'2026-10-06'}]]){
  let params=param;const component=load(file,{'expo-router':{useLocalSearchParams:()=>params},'react/jsx-runtime':{jsx:(type,props,key)=>({type,props,key})},'../navigation/reviewContext':routes,[`../features/${name==='TimeIssuesScreen'?'management/TimeIssuesScreen':'timesheets/TimesheetsScreen'}`]:{[name]:name}}).default;
  const first=component();params={...param,extra:'changed'};assert.notEqual(component().key,first.key);assert.equal(first.props.invalidContext,false);
 }
});
test('selected report loads directly even when it is absent from the first issue page',async()=>{
 const {h,calls}=issues({initialIssueId:A});assert.equal(calls[1].kind,'detail');assert.equal(calls[1].id,A);
 calls[0].resolve({issues:[],nextCursor:'more'});calls[1].resolve(detail);await h.flush();assert.match(h.text(),/Original report/);assert.match(h.text(),/Current time interpretation/);h.dispose();
});
for(const status of [403,404,409])test(`selected issue ${status} hides unavailable details and permits retry`,async()=>{
 const {h,calls}=issues({initialIssueId:A});calls[0].resolve({issues:[],nextCursor:null});calls[1].reject(new ApiError(status,'UNAVAILABLE'));await h.flush();assert.match(h.text(),/Issue unavailable/);assert.doesNotMatch(h.text(),/Current time interpretation/);h.dispose();
});
test('invalid route and employee PIN never fetch manager issue data',()=>{
 for(const [props,over]of [[{invalidContext:true},{}],[{initialIssueId:A},{managementRole:'staff'}],[{initialIssueId:A},{identity:null}]]){const {h,calls}=issues(props,over);assert.equal(calls.length,0);h.dispose();}
});
test('resolution success survives refresh failure without presenting old issue as current',async()=>{
 const {h,calls}=issues({initialIssueId:A});calls[0].resolve({issues:[report],nextCursor:null});calls[1].resolve(detail);await h.flush();h.field('Resolution note','Discussed with employee');h.click('Review resolution');h.click('Confirm resolution');
 const press=calls[2];assert.equal(press.kind,'resolve');calls[2].resolve({id:'resolution'});await h.flush();assert.match(h.text(),/Issue resolved successfully/);assert.equal(calls.filter(c=>c.kind==='resolve').length,1);
 calls[3].reject(new ApiError(503,'UNAVAILABLE'));calls[4].reject(new ApiError(503,'UNAVAILABLE'));await h.flush();assert.match(h.text(),/Issue resolved successfully/);assert.match(h.text(),/Current details are unavailable/);assert.doesNotMatch(h.text(),/Current time interpretation/);assert.equal(h.button('Confirm resolution'),undefined);h.dispose();
});
test('report refresh distinguishes loading, success, failed retrieval and scoped empty page',async()=>{
 const {h,calls}=issues();assert.match(h.text(),/Refreshing employee reports/);calls[0].resolve({issues:[],nextCursor:null});await h.flush();assert.match(h.text(),/Reports last refreshed/);assert.match(h.text(),/No unresolved reports on this page/);h.click('Refresh');assert.doesNotMatch(h.text(),/No unresolved reports on this page/);calls[1].reject(new ApiError(503,'UNAVAILABLE'));await h.flush();assert.match(h.text(),/Current reports are unavailable/);assert.doesNotMatch(h.text(),/No unresolved reports on this page/);h.dispose();
});
test('correction commits refresh context without showing resolution success or writing resolution',async()=>{
 const {h,calls}=issues({initialIssueId:A});calls[0].resolve({issues:[report],nextCursor:null});calls[1].resolve(detail);await h.flush();h.click('Correct time');h.nodes().find(n=>n.type==='CorrectionPanel').props.onCommitted();h.render();assert.doesNotMatch(h.text(),/Issue resolved successfully/);assert.equal(calls.filter(c=>c.kind==='resolve').length,0);h.dispose();
});
function timesheets(initialContext,over={},invalidContext=false){const calls=[];const h=screen('features/timesheets/TimesheetsScreen.tsx',({react,context})=>{Object.assign(context,over);return {'expo-router':{useFocusEffect:fn=>react.useEffect(()=>fn(),[fn])},'../business/BusinessContext':{useBusiness:()=>context},'../identity/EmployeeIdentityContext':{useEmployeeIdentity:()=>context},'../../lib/timesheets-api':{timesheetMessage:()=> 'Access changed',getTimesheetDirectory:(business,signal)=>new Promise((resolve,reject)=>calls.push({kind:'directory',signal,resolve,reject})),getTimesheet:(business,id,week,signal)=>new Promise((resolve,reject)=>calls.push({kind:'sheet',id,week,signal,resolve,reject}))},'../../components/ui':{Badge:'Badge',Button:'Button',styles:{}},'../../theme/tokens':load('theme/tokens.ts'),'./CorrectionPanel':{CorrectionPanel:'CorrectionPanel'},'./correction':{mayCorrect:()=>false,correctionMessage:()=> 'Access changed'},'../appointments/controls':{Notice:'Notice'}}},'TimesheetsScreen',{initialContext,invalidContext});return {h,calls};}
test('timesheet link selects only a target returned by the authorized directory and preserves week',async()=>{
 const {h,calls}=timesheets({employeeId:B,week:'2026-10-05',day:'2026-10-06'});assert.equal(calls.length,1);calls[0].resolve({employees:[{id:B,name:'Alice',role:'employee',isActive:true}]});await h.flush();assert.equal(calls[1].id,B);assert.equal(calls[1].week,'2026-10-05');h.dispose();
});
test('forbidden employee selection never sends a timesheet read; malformed links and employee PIN never load directory',async()=>{
 const x=timesheets({employeeId:B,week:null,day:null});x.calls[0].resolve({employees:[]});await x.h.flush();assert.equal(x.calls.length,1);assert.match(x.h.text(),/no longer available/);x.h.dispose();
 for(const [over,invalid]of [[{managementRole:'staff'},false],[{},true]]){const {h,calls}=timesheets({employeeId:B,week:null,day:null},over,invalid);assert.equal(calls.length,0);h.dispose();}
});
test('pending selected issue clears on identity lock and ignores late detail response',async()=>{
 const {h,calls}=issues({initialIssueId:A});h.context.identity=null;h.render();assert.equal(calls[1].signal.aborted,true);calls[1].resolve(detail);await h.flush();assert.doesNotMatch(h.text(),/Original report/);h.dispose();
});
test('resolution conflict refreshes safely and preserves visible conflict guidance',async()=>{
 const {h,calls}=issues({initialIssueId:A});calls[0].resolve({issues:[report],nextCursor:null});calls[1].resolve(detail);await h.flush();h.field('Resolution note','Discussed with employee');h.click('Review resolution');h.click('Confirm resolution');calls[2].reject(new ApiError(409,'ISSUE_ALREADY_RESOLVED'));await h.flush();assert.match(h.text(),/Access or records changed/);assert.doesNotMatch(h.text(),/Issue resolved successfully/);assert.equal(calls.filter(c=>c.kind==='resolve').length,1);h.dispose();
});
test('success refresh shows resolved detail and removes report from unresolved page',async()=>{
 const {h,calls}=issues({initialIssueId:A});calls[0].resolve({issues:[report],nextCursor:null});calls[1].resolve(detail);await h.flush();h.field('Resolution note','Discussed with employee');h.click('Review resolution');const button=h.button('Confirm resolution');button.props.onPress();button.props.onPress();h.render();assert.equal(calls.filter(c=>c.kind==='resolve').length,1);calls[2].resolve({id:'resolution'});await h.flush();calls[3].resolve({issues:[],nextCursor:null});calls[4].resolve({...detail,issue:{...report,status:'resolved',resolution:{note:'Discussed with employee',recordedAt:report.created_at}}});await h.flush();assert.match(h.text(),/Issue resolved successfully/);assert.match(h.text(),/No unresolved reports on this page/);assert.equal(h.button('Confirm resolution'),undefined);assert.equal(h.button('Correct time'),undefined);h.dispose();
});
