const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const root='apps/zude-mobile/src/';
function load(file,imports={},globals={}) {
  const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(root+file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,
    {exports,URL,URLSearchParams,AbortController,Date,Intl,...globals,require(name){if(name in imports)return imports[name];throw Error('Unexpected import '+name);}});return exports;
}
class ApiError extends Error {constructor(status,code){super('private provider detail');this.status=status;this.code=code;}}
const B='business-a',at='2026-10-02T16:00:00.000Z';
const row={employee:{id:'e1',name:'Avery',role:'employee',isActive:false},state:'WORKING',stateStartedAt:'2026-10-02T13:00:00.000Z',inactiveOpenShift:true,
  shift:{id:'s1',clockInAt:'2026-10-02T13:00:00.000Z',elapsedMs:10800000,workedMs:10800000,paidBreakMs:0,mealBreakMs:0,break:null}};
const view=(employees=[row],businessId=B)=>({success:true,businessId,timezone:'America/New_York',snapshotAt:at,employees});
const flush=()=>new Promise(r=>setImmediate(r));
function screen(over = {}) {
  const slots=[],pending=[],calls=[];let cursor=0,dirty=false,tree,focused=true;
  const context={business:{id:B,name:'Salon',role:'owner'},userId:'account-a',managementRole:'manager',sharedMode:true,identity:{employee:{id:'manager'},expiresAt:at},...over};
  const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>v===b[i]);
  const react={
    useState(initial){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return [slots[i],v=>{const next=typeof v==='function'?v(slots[i]):v;if(!Object.is(next,slots[i])){slots[i]=next;dirty=true;}}];},
    useRef(initial){const i=cursor++;return slots[i]??(slots[i]={current:initial});},
    useCallback(fn,deps){const i=cursor++;if(!slots[i]||!same(slots[i].deps,deps))slots[i]={fn,deps};return slots[i].fn;},
    useEffect(fn,deps){const i=cursor++;if(!slots[i]||!same(slots[i].deps,deps)){const previous=slots[i];slots[i]={deps,cleanup:previous?.cleanup};pending.push(()=>{slots[i].cleanup?.();slots[i].cleanup=fn();});}},
  };
  const native={View:'View',Text:'Text',ScrollView:'ScrollView',StyleSheet:{create:s=>s},AppState:{addEventListener:()=>({remove(){}})}};
  const resource=load('features/time/useTimeResource.ts',{react,'react-native':native,'../../lib/api':{ZudeApiError:ApiError}});
  const jsx={jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};
  const Screen=load('features/working/WorkingScreen.tsx',{
    react,'react/jsx-runtime':jsx,'react-native':native,'expo-router':{useFocusEffect(fn){react.useEffect(()=>focused?fn():undefined,[focused,fn]);}},
    '../../components/ui':{Badge:'Badge',Button:'Button',styles:{}},'../../components/workspace':{Feedback:'Feedback',WorkspaceHeader:'WorkspaceHeader',workspaceStyles:{}},
    '../../lib/api':{ZudeApiError:ApiError},'../../lib/working-api':{getWorking(businessId,signal){return new Promise((resolve,reject)=>calls.push({businessId,signal,resolve,reject}));}},
    '../business/BusinessContext':{useBusiness:()=>context},'../identity/EmployeeIdentityContext':{useEmployeeIdentity:()=>context},
    '../time/useTimeResource':resource,'../time/state':load('features/time/state.ts',{'../../lib/api':{ZudeApiError:ApiError}}),'../../theme/tokens':load('theme/tokens.ts'),
  }).WorkingScreen;
  function nodes(n){if(!n||typeof n!=='object')return [];if(Array.isArray(n))return n.flatMap(nodes);return [n,...['children','action'].flatMap(k=>nodes(n.props?.[k]))];}
  const h={context,calls,render(){let n=0;do{assert.ok(n++<12,'render settled');dirty=false;cursor=0;tree=Screen();while(pending.length)pending.shift()();}while(dirty);return tree;},
    text(){return nodes(tree).map(n=>n.type==='Text'?[].concat(n.props.children).filter(v=>typeof v==='string'||typeof v==='number').join(''):JSON.stringify(n.props)).join('\n');},nodes(){return nodes(tree);},feedback(kind){return h.nodes().find(n=>n.type==='Feedback'&&n.props.kind===kind);},
    focus(value){focused=value;h.render();},refresh(){const b=h.nodes().find(n=>n.type==='Button'&&n.props.label==='Refresh');assert.ok(b&&!b.props.disabled);b.props.onPress();h.render();},
    dispose(){for(const slot of slots)slot?.cleanup?.();},
  };h.render();return h;
}
test('Working manager/owner navigation, employee/shared permissions and real route',()=>{
  const nav=load('navigation/items.ts');
  for(const role of ['manager','owner'])assert.equal(nav.visibleNavigation(role).flatMap(g=>g.items).find(i=>i.route==='/working')?.label,'Who’s Working');
  assert.ok(!nav.visibleNavigation('staff').flatMap(g=>g.items).some(i=>i.route==='/working'));
  assert.ok(!nav.visibleNavigation('owner',[]).flatMap(g=>g.items).some(i=>i.route==='/working'));
  assert.equal(nav.activeNavigationLabel('/working'),'Who’s Working');assert.match(fs.readFileSync(root+'app/working.tsx','utf8'),/WorkingScreen as default/);
});
test('Working direct employee route is denied without loading data; account manager is allowed',()=>{
  const h=screen({managementRole:'staff'});assert.equal(h.calls.length,0);assert.match(h.text(),/for managers and owners/);assert.doesNotMatch(h.text(),/Avery/);
  const count=h.calls.length;h.render();assert.equal(h.calls.length,count);
  h.context.managementRole='manager';h.context.sharedMode=false;h.context.identity=null;h.render();assert.equal(h.calls.length,count+1);h.dispose();
});
test('Working loading, inactive open row, business-local dates, snapshot durations and manual refresh',async()=>{
  const h=screen();assert.ok(h.feedback('loading'));h.calls[0].resolve(view());await flush();h.render();
  for(const pattern of [/Avery/,/Inactive · Shift still open/,/No clock-out has been recorded/,/3h 00m worked/,/9:00 AM/,/as of this snapshot/])assert.match(h.text(),pattern);
  assert.equal(h.calls.length,1);h.render();assert.equal(h.calls.length,1,'no polling or render fetching');
  const r=h.nodes().find(n=>n.type==='View'&&n.props.style?.minHeight);assert.ok(r.props.style.minHeight>=44);
  h.refresh();assert.equal(h.calls.length,2);h.calls[1].resolve(view([]));await flush();h.render();assert.match(h.text(),/No employees to show/);h.dispose();
});
test('Working errors are safe, hide stale rows, and can retry',async()=>{
  const h=screen();h.calls[0].resolve(view());await flush();h.render();h.refresh();h.calls[1].reject(new ApiError(503,'WORKING_LIMIT_EXCEEDED'));await flush();h.render();
  assert.ok(h.feedback('error'));assert.match(h.text(),/too large to load/);assert.doesNotMatch(h.text(),/Avery|private provider detail/);
  h.feedback('error').props.retry();h.render();assert.equal(h.calls.length,3);h.dispose();
});
for(const change of ['business','account','session','employee','lock','authority','logout'])test(`Working aborts and ignores stale response after ${change}`,async()=>{
  const h=screen();
  if(change==='business')h.context.business={...h.context.business,id:'business-b'};
  if(change==='account')h.context.userId='account-b';
  if(change==='logout')h.context.userId=null;
  if(change==='session')h.context.identity={...h.context.identity,expiresAt:'2026-10-03T16:00:00Z'};
  if(change==='employee')h.context.identity={...h.context.identity,employee:{id:'manager-b'}};
  if(change==='lock')h.context.identity=null;
  if(change==='authority')h.context.managementRole='staff';
  h.render();assert.equal(h.calls[0].signal.aborted,true);h.calls[0].resolve(view());await flush();h.render();assert.doesNotMatch(h.text(),/Avery/);h.dispose();
});
test('Working Lock clears loaded data; blur aborts; returning loads a new snapshot with no cached rows',async()=>{
  const h=screen();h.calls[0].resolve(view());await flush();h.render();assert.match(h.text(),/Avery/);
  h.focus(false);assert.doesNotMatch(h.text(),/Avery/);assert.equal(h.calls[0].signal.aborted,true);
  h.focus(true);assert.equal(h.calls.length,2);assert.ok(h.feedback('loading'));assert.doesNotMatch(h.text(),/Avery/);
  h.calls[1].resolve(view());await flush();h.render();h.context.identity=null;h.render();assert.doesNotMatch(h.text(),/Avery/);assert.match(h.text(),/for managers and owners/);h.dispose();
});
function transport(response,identity={mode:'account'}) {
  const calls=[],rejections=[];
  const api=load('lib/api.ts',{'./supabase':{supabase:{auth:{getSession:async()=>({data:{session:{access_token:'synthetic-account-token',user:{id:'account-a'}}}})}}}},
    {__DEV__:false,process:{env:{EXPO_PUBLIC_ZUDE_API_URL:'https://zude.invalid'}},fetch:async(url,init)=>{calls.push({url,init});return new Response(JSON.stringify(response.body??response),{status:response.status??200,headers:{'content-type':'application/json'}});}});
  const operational=load('lib/operational-identity.ts',{'./api':api});operational.publishOperationalIdentity(B,identity);operational.onOperationalRejection(v=>rejections.push(v));
  const working=load('lib/working-api.ts',{'./api':api,'./operational-identity':operational});return {working,calls,rejections};
}
test('Working transport uses existing bearer/business + verified operational headers; locked requests send nothing',async()=>{
  for(const identity of [{mode:'account'},{mode:'employee',credential:'synthetic-device',session:'synthetic-session'}]){
    const h=transport(view(),identity);await h.working.getWorking(B,new AbortController().signal);assert.equal(h.calls.length,1);
    const {url,init}=h.calls[0];assert.equal(url,'https://zude.invalid/api/management/working');assert.equal(init.headers.Authorization,'Bearer synthetic-account-token');assert.equal(init.headers['x-anaai-business-id'],B);
    assert.equal(init.headers['x-zude-device'],identity.credential);assert.equal(init.headers['x-zude-employee-session'],identity.session);
  }
  const locked=transport(view(),{mode:'locked'});await assert.rejects(locked.working.getWorking(B,new AbortController().signal),e=>e.code==='IDENTITY_REQUIRED');assert.equal(locked.calls.length,0);
});
test('Working malformed/cross-business data fails verification and unexpected fields are discarded',async()=>{
  for(const data of [view([row],'other'),{...view(),timezone:'bad-zone'},view([{...row,shift:{...row.shift,workedMs:-1}}]),view([row,row]),view([{...row,state:'OFF_CLOCK'}])]){
    await assert.rejects(transport(data).working.getWorking(B,new AbortController().signal),e=>e.code==='INVALID_RESPONSE');
  }
  const safe=await transport({...view([{...row,unexpected:'private',employee:{...row.employee,private:'private'}}]),private:'private'}).working.getWorking(B,new AbortController().signal);
  assert.doesNotMatch(JSON.stringify(safe),/private|unexpected/);
});
test('Working operational rejection notifies existing identity recovery without retries',async()=>{
  const h=transport({status:401,body:{success:false,code:'IDENTITY_UNAUTHORIZED',error:'private'}},{mode:'employee',credential:'synthetic-device',session:'synthetic-session'});
  await assert.rejects(h.working.getWorking(B,new AbortController().signal),e=>e.code==='IDENTITY_UNAUTHORIZED');assert.equal(h.rejections.length,1);assert.equal(h.calls.length,1);
});
