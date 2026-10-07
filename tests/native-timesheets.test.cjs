const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const root='apps/zude-mobile/src/';
function load(file,imports={},globals={}) {
 const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(root+file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,
 {exports,URL,URLSearchParams,AbortController,Date,Intl,...globals,require(name){if(name in imports)return imports[name];throw Error('Unexpected import '+name);}});return exports;
}
class ApiError extends Error{constructor(status,code){super('private provider detail');this.status=status;this.code=code;}}
const B='business-a',current='2026-09-28',at='2026-10-02T16:00:00Z';
const alice={id:'alice',name:'Alice',role:'employee',isActive:false},bob={id:'bob',name:'Bob',role:'employee',isActive:true};
const zero={workedMs:0,paidBreakMs:0,mealBreakMs:0};
const directory=(employees=[alice,bob],businessId=B)=>({success:true,businessId,employees});
function view(employee=alice,week=current,businessId=B){
 const next=(n)=>new Date(Date.parse(week+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
 const shift={id:'shift',clockInAt:week+'T13:00:00Z',clockOutAt:null,open:true,continuesFromPreviousDay:false,continuesNextDay:false,...zero,workedMs:3600000,breaks:[]};
 return {success:true,businessId,employee,timezone:'America/New_York',snapshotAt:at,currentWeekStart:current,previousWeekStart:next(-7),nextWeekStart:week===current?null:next(7),
 week:{startDate:week,endDate:next(6),startsAt:week+'T04:00:00Z',endsAt:next(7)+'T04:00:00Z'},totals:{...zero,workedMs:3600000,hasOpenShift:true},
 days:Array.from({length:7},(_,i)=>({date:next(i),startsAt:next(i)+'T04:00:00Z',endsAt:next(i+1)+'T04:00:00Z',...zero,workedMs:i===0?3600000:0,shifts:i===0?[shift]:[]})),
 events:[{id:'shift',shiftId:'shift',seq:1,type:'CLOCK_IN',breakType:null,occurredAt:shift.clockInAt}]};
}
const flush=()=>new Promise(r=>setImmediate(r));
function screen(over={}){
 const slots=[],pending=[],calls=[];let cursor=0,dirty=false,tree,focused=true;
 const context={business:{id:B,name:'Salon',role:'owner'},userId:'account-a',managementRole:'manager',sharedMode:true,identity:{employee:{id:'manager'},expiresAt:at},...over};
 const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>v===b[i]);
 const react={
  useState(initial){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return [slots[i],v=>{const next=typeof v==='function'?v(slots[i]):v;if(!Object.is(next,slots[i])){slots[i]=next;dirty=true;}}];},
  useRef(initial){const i=cursor++;return slots[i]??(slots[i]={current:initial});},
  useCallback(fn,deps){const i=cursor++;if(!slots[i]||!same(slots[i].deps,deps))slots[i]={fn,deps};return slots[i].fn;},
  useEffect(fn,deps){const i=cursor++;if(!slots[i]||!same(slots[i].deps,deps)){const previous=slots[i];slots[i]={deps,cleanup:previous?.cleanup};pending.push(()=>{slots[i].cleanup?.();slots[i].cleanup=fn();});}},
 };
 const native={View:'View',Text:'Text',StyleSheet:{create:s=>s},AppState:{addEventListener:()=>({remove(){}})}};
 const api={getTimesheetDirectory(businessId,signal){return new Promise((resolve,reject)=>calls.push({kind:'directory',businessId,signal,resolve,reject}));},getTimesheet(businessId,employeeId,week,signal){return new Promise((resolve,reject)=>calls.push({kind:'sheet',businessId,employeeId,week,signal,resolve,reject}));},
 timesheetMessage:load('lib/timesheets-api.ts',{'./api':{ZudeApiError:ApiError},'./operational-identity':{}}).timesheetMessage};
 const Screen=load('features/timesheets/TimesheetsScreen.tsx',{
 react,'react/jsx-runtime':{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})},'react-native':native,
 'expo-router':{useFocusEffect(fn){react.useEffect(()=>focused?fn():undefined,[focused,fn]);}},
 '../../components/ui':{Badge:'Badge',Button:'Button',styles:{}},'../../components/records':{RecordRow:'RecordRow',recordStyles:{}},
 '../../components/workspace':{Feedback:'Feedback',MasterDetail:'MasterDetail',PaneTitle:'PaneTitle',WorkspaceHeader:'WorkspaceHeader',workspaceStyles:{}},
 '../../lib/api':{ZudeApiError:ApiError},'../../lib/timesheets-api':api,'../business/BusinessContext':{useBusiness:()=>context},'../identity/EmployeeIdentityContext':{useEmployeeIdentity:()=>context},
 '../time/useTimeResource':load('features/time/useTimeResource.ts',{react,'react-native':native,'../../lib/api':{ZudeApiError:ApiError}}),
 '../time/state':load('features/time/state.ts',{'../../lib/api':{ZudeApiError:ApiError}}),'../../theme/tokens':load('theme/tokens.ts'),
 '../appointments/controls':{Notice:'Notice'},'./CorrectionPanel':{CorrectionPanel:'CorrectionPanel'},
 './correction':load('features/timesheets/correction.ts',{'../../lib/api':{ZudeApiError:ApiError},'../time/state':load('features/time/state.ts',{'../../lib/api':{ZudeApiError:ApiError}})}),
 }).TimesheetsScreen;
 function nodes(n){if(!n||typeof n!=='object')return [];if(Array.isArray(n))return n.flatMap(nodes);return [n,...['children','action','master','detail'].flatMap(k=>nodes(n.props?.[k]))];}
 const h={context,calls,render(){let n=0;do{assert.ok(n++<15,'render settled');dirty=false;cursor=0;tree=Screen();while(pending.length)pending.shift()();}while(dirty);return tree;},
 nodes(){return nodes(tree);},text(){return nodes(tree).map(n=>n.type==='Text'?[].concat(n.props.children).filter(v=>typeof v==='string'||typeof v==='number').join(''):JSON.stringify(n.props)).join('\n');},
 button(label){return h.nodes().find(n=>n.type==='Button'&&n.props.label===label);},click(label){const n=h.button(label)||h.nodes().find(n=>n.type==='RecordRow'&&n.props.label===label);assert.ok(n,'Control '+label);assert.ok(!n.props.disabled);n.props.onPress();h.render();},
 async settle(index,data){calls[index].resolve(data);await flush();h.render();},async reject(index,error){calls[index].reject(error);await flush();h.render();},
 focus(value){focused=value;h.render();},dispose(){for(const slot of slots)slot?.cleanup?.();},
 };h.render();return h;
}
async function ready(){const h=screen();await h.settle(0,directory());h.click('View timesheet for Alice');await h.settle(1,view());return h;}
test('Timesheets manager/owner navigation and native route; employee/shared regular role hidden',()=>{
 const nav=load('navigation/items.ts');for(const role of ['manager','owner'])assert.ok(nav.visibleNavigation(role).flatMap(g=>g.items).some(i=>i.route==='/timesheets'));
 for(const [role,permissions] of [['staff',null],['owner',[]]])assert.ok(!nav.visibleNavigation(role,permissions).flatMap(g=>g.items).some(i=>i.route==='/timesheets'));
 assert.equal(nav.activeNavigationLabel('/timesheets'),'Timesheets');assert.match(fs.readFileSync(root+'app/timesheets.tsx','utf8'),/TimesheetsScreen as default/);
});
test('Timesheets direct employee route blocked, including locked identity; no requests',()=>{
 for(const over of [{managementRole:'staff'},{identity:null},{userId:null}]){const h=screen(over);assert.equal(h.calls.length,0);assert.match(h.text(),/for managers and owners/);h.dispose();}
});
test('Timesheets directory loading/empty; only authorized server targets rendered; selection loads current week',async()=>{
 const h=screen();assert.match(h.text(),/Loading employees/);await h.settle(0,directory([alice]));assert.doesNotMatch(h.text(),/Bob/);
 h.click('View timesheet for Alice');assert.equal(h.calls[1].employeeId,'alice');assert.equal(h.calls[1].week,null);assert.match(h.text(),/Loading timesheet/);
 await h.settle(1,view());assert.match(h.text(),/1h 00m worked/);assert.match(h.text(),/Inactive employee/);assert.match(h.text(),/Shift still open/);h.dispose();
 const empty=screen();await empty.settle(0,directory([]));assert.match(empty.text(),/No employees to show/);empty.dispose();
});
test('Timesheets previous/next/current navigation uses server dates, prevents future, resets day detail',async()=>{
 const h=await ready();assert.equal(h.button('Next week').props.disabled,true);
 h.click('View Mon, Sep 28');assert.match(h.text(),/Shift events/);h.click('Previous week');assert.equal(h.calls[2].week,'2026-09-21');assert.doesNotMatch(h.text(),/Shift events/);
 await h.settle(2,view(alice,'2026-09-21'));h.click('Next week');assert.equal(h.calls[3].week,current);await h.settle(3,view());
 h.click('Previous week');await h.settle(4,view(alice,'2026-09-21'));h.click('Current week');assert.equal(h.calls[5].week,null);h.dispose();
});
test('Timesheets ordered day events, paid/meal periods, read-only controls and truthful empty week',async()=>{
 const h=screen();await h.settle(0,directory());h.click('View timesheet for Alice');const detail=view();
 detail.days[0].shifts[0].breaks=[{type:'PAID',intendedMinutes:10,startedAt:current+'T14:00:00Z',endedAt:current+'T14:10:00Z',open:false,durationMs:600000},{type:'MEAL',intendedMinutes:30,startedAt:current+'T15:00:00Z',endedAt:null,open:true,durationMs:3600000}];
 detail.events.push({id:'paid-start',shiftId:'shift',seq:2,type:'BREAK_START',breakType:'PAID',occurredAt:current+'T14:00:00Z'},{id:'paid-end',shiftId:'shift',seq:3,type:'BREAK_END',breakType:'PAID',occurredAt:current+'T14:10:00Z'},{id:'meal-start',shiftId:'shift',seq:4,type:'BREAK_START',breakType:'MEAL',occurredAt:current+'T15:00:00Z'});
 await h.settle(1,detail);h.click('View Mon, Sep 28');assert.match(h.text(),/Paid break started/);assert.match(h.text(),/Paid break ended/);assert.match(h.text(),/Meal break started/);assert.match(h.text(),/full break/);assert.match(h.text(),/Clock in/);assert.match(h.text(),/9:00 AM/);assert.match(h.text(),/Still open/);
 // Slice 5: the only change control is the deliberate "Correct time" entry point; nothing inline-editable.
 const labels=h.nodes().filter(n=>n.type==='Button').map(n=>n.props.label);assert.ok(labels.includes('Correct time'));
 assert.doesNotMatch(labels.filter(l=>l!=='Correct time').join('|'),/Edit|Fix|Adjust|Correct|Save|Export|Delete/);assert.equal(h.nodes().some(n=>n.type==='CorrectionPanel'),false);
 const raw=fs.readFileSync(root+'components/records.tsx','utf8');assert.match(raw,/accessibilityRole="button"/);assert.ok(Number(raw.match(/row: \{ minHeight: (\d+)/)[1])>=44);
 h.click('Previous week');const b=view(alice,'2026-09-21');b.events=[];b.totals={...zero,hasOpenShift:false};b.days=b.days.map(d=>({...d,...zero,shifts:[]}));
 await h.settle(2,b);assert.match(h.text(),/No time in this week/);assert.match(h.text(),/Historical time retained/);h.dispose();
});
test('Timesheets network/safety errors hide prior employee/week and offer retry/current week',async()=>{
 const h=await ready();h.click('View timesheet for Bob');assert.doesNotMatch(h.text(),/1h 00m worked/);
 await h.reject(2,new ApiError(503,'TIMESHEET_LIMIT_EXCEEDED'));assert.match(h.text(),/too large to load/);assert.doesNotMatch(h.text(),/private provider detail|1h 00m worked/);
 h.nodes().find(n=>n.type==='Feedback'&&n.props.title==='Timesheet unavailable').props.retry();h.render();assert.equal(h.calls.length,4);h.dispose();
 const list=screen();await list.reject(0,new ApiError(0,'NETWORK_ERROR'));assert.match(list.text(),/Check your connection/);list.dispose();
});
test('Timesheets stale employee response ignored after another selection',async()=>{
 const h=screen();await h.settle(0,directory());h.click('View timesheet for Alice');h.click('View timesheet for Bob');assert.equal(h.calls[1].signal.aborted,true);
 await h.settle(1,view());assert.doesNotMatch(h.text(),/1h 00m worked/);await h.settle(2,view(bob));assert.match(h.text(),/1h 00m worked/);assert.doesNotMatch(h.text(),/Inactive employee/);h.dispose();
});
test('Timesheets stale week response ignored after employee changes',async()=>{
 const h=await ready();h.click('Previous week');h.click('View timesheet for Bob');assert.equal(h.calls[2].signal.aborted,true);
 await h.settle(2,view(alice,'2026-09-21'));assert.doesNotMatch(h.text(),/Sep 21|1h 00m worked/);await h.settle(3,view(bob));h.dispose();
});
for(const change of ['lock','business','account','session','authority','logout'])test(`Timesheets ${change} clears selection and aborts late data`,async()=>{
 const h=await ready();h.click('Previous week');
 if(change==='lock')h.context.identity=null;
 if(change==='business')h.context.business={...h.context.business,id:'business-b'};
 if(change==='account')h.context.userId='account-b';
 if(change==='session')h.context.identity={...h.context.identity,expiresAt:'new-session'};
 if(change==='authority')h.context.managementRole='staff';
 if(change==='logout')h.context.userId=null;
 h.render();assert.equal(h.calls[2].signal.aborted,true);await h.settle(2,view(alice,'2026-09-21'));assert.doesNotMatch(h.text(),/1h 00m worked|Shift events/);h.dispose();
});
test('Timesheets authority rejection clears selected state and returning to screen refreshes directory',async()=>{
 const h=await ready();h.click('Previous week');await h.reject(2,new ApiError(403,'ROLE_FORBIDDEN'));assert.match(h.text(),/access changed/);assert.doesNotMatch(h.text(),/1h 00m worked/);
 assert.equal(h.nodes().find(n=>n.type==='MasterDetail').props.showDetail,false);
 h.focus(false);h.focus(true);assert.equal(h.calls[3].kind,'directory');await h.settle(3,directory());assert.match(h.text(),/Choose an employee/);h.dispose();
});
test('Timesheets refresh safely reloads directory and selected week without polling',async()=>{
 const h=await ready();h.render();assert.equal(h.calls.length,2);h.click('Refresh');assert.equal(h.calls[2].kind,'directory');assert.doesNotMatch(h.text(),/1h 00m worked/);
 await h.settle(2,directory());assert.equal(h.calls[3].kind,'sheet');await h.settle(3,view());assert.match(h.text(),/1h 00m worked/);h.dispose();
});
function transport(response,identity={mode:'employee',credential:'synthetic-device',session:'synthetic-session'}){
 const calls=[],rejections=[];
 const api=load('lib/api.ts',{'./supabase':{supabase:{auth:{getSession:async()=>({data:{session:{access_token:'synthetic-account',user:{id:'account'}}}})}}}},
 {__DEV__:false,process:{env:{EXPO_PUBLIC_ZUDE_API_URL:'https://zude.invalid'}},fetch:async(url,init)=>{calls.push({url,init});return new Response(JSON.stringify(response.body??response),{status:response.status??200,headers:{'content-type':'application/json'}});}});
 const operational=load('lib/operational-identity.ts',{'./api':api});operational.publishOperationalIdentity(B,identity);operational.onOperationalRejection(r=>rejections.push(r));
 return {calls,rejections,api:load('lib/timesheets-api.ts',{'./api':api,'./operational-identity':operational})};
}
test('Timesheets transport preserves bearer/business and operational identity headers; uses only employee/week selectors',async()=>{
 const h=transport(view());await h.api.getTimesheet(B,'alice',current,new AbortController().signal);
 const {url,init}=h.calls[0];assert.equal(url,'https://zude.invalid/api/management/timesheets/alice?weekStart=2026-09-28');assert.equal(init.method,'GET');assert.equal(init.headers.Authorization,'Bearer synthetic-account');assert.equal(init.headers['x-anaai-business-id'],B);assert.equal(init.headers['x-zude-device'],'synthetic-device');assert.equal(init.headers['x-zude-employee-session'],'synthetic-session');assert.equal(init.body,undefined);
 const d=transport(directory(),{mode:'account'});await d.api.getTimesheetDirectory(B,new AbortController().signal);assert.equal(d.calls[0].init.headers['x-zude-device'],undefined);
 const locked=transport(view(),{mode:'locked'});await assert.rejects(locked.api.getTimesheet(B,'alice',null,new AbortController().signal),e=>e.code==='IDENTITY_REQUIRED');assert.equal(locked.calls.length,0);
});
test('Timesheets parser rejects mismatched business/employee/week, bad totals and event sequence; strips unexpected fields',async()=>{
 const bad=[view(alice,current,'other'),view(bob),view(alice,'2026-09-21'),{...view(),totals:{...zero,workedMs:-1,hasOpenShift:true}}, {...view(),events:[...view().events,...view().events]}];
 for(const data of bad)await assert.rejects(transport(data).api.getTimesheet(B,'alice',current,new AbortController().signal),e=>e.code==='INVALID_RESPONSE');
 const data=view();data.private='private';data.employee.private='private';data.events[0].private='private';const safe=await transport(data).api.getTimesheet(B,'alice',current,new AbortController().signal);assert.doesNotMatch(JSON.stringify(safe),/private/);
 await assert.rejects(transport(directory([alice,alice])).api.getTimesheetDirectory(B,new AbortController().signal),e=>e.code==='INVALID_RESPONSE');
});
test('Timesheets coded identity rejection uses existing recovery and does not retry',async()=>{
 const h=transport({status:401,body:{success:false,code:'IDENTITY_UNAUTHORIZED'}});await assert.rejects(h.api.getTimesheetDirectory(B,new AbortController().signal),e=>e.code==='IDENTITY_UNAUTHORIZED');assert.equal(h.rejections.length,1);assert.equal(h.calls.length,1);
});
test('Timesheets rapid week changes ignore the older week response for the same employee',async()=>{
 const h=await ready();h.click('Previous week');await h.settle(2,view(alice,'2026-09-21'));
 const previous=h.button('Previous week'),next=h.button('Next week');previous.props.onPress();h.render();next.props.onPress();h.render();
 assert.equal(h.calls[3].week,'2026-09-14');assert.equal(h.calls[3].signal.aborted,true);assert.equal(h.calls[4].week,current);
 await h.settle(3,view(alice,'2026-09-14'));assert.doesNotMatch(h.text(),/Sep 14|1h 00m worked/);
 await h.settle(4,view());assert.match(h.text(),/Sep 28/);h.dispose();
});
