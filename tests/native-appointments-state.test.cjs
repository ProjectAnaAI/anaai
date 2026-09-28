const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const crypto = require('node:crypto');
const base='apps/zude-mobile/src/features/appointments/';
class ZudeApiError extends Error { constructor(status,code,message='safe') { super(message);this.status=status;this.code=code; } }
function load(file,imports,globals={}) {
  const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,
    {exports,AbortController,Date,Map,...globals,require(name){ if(Object.hasOwn(imports,name))return imports[name];throw Error(name); }});return exports;
}
const state=load(base+'state.ts',{'../../lib/api':{ZudeApiError}});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('date navigation preserves local date across leap/month/year boundaries without device timezone conversion',()=>{
  assert.equal(state.shiftDate('2028-02-28',1),'2028-02-29');assert.equal(state.shiftDate('2026-12-31',1),'2027-01-01');assert.equal(state.validDate('2026-02-29'),false);
});
test('slot recovery invalidates only time, preserving appointment/customer/service/date',()=>{
  const input={appointmentId:'a',customerId:'c',serviceId:'s',date:'2026-09-28',time:'09:00'};
  assert.equal(JSON.stringify(state.recoverConflict(input)),JSON.stringify({...input,time:''}));assert.equal(input.time,'09:00');
});
test('native lifecycle actions reflect terminal states',()=>{
  assert.equal(JSON.stringify(state.lifecycleActions('Booked')),'["Confirmed","Cancelled"]');assert.equal(JSON.stringify(state.lifecycleActions('Confirmed')),'["Completed","Cancelled"]');
  assert.equal(state.lifecycleActions('Completed').length,0);assert.equal(state.lifecycleActions('Cancelled').length,0);
});
for(const [status,code,pattern] of [[401,'UNAUTHORIZED',/session/],[403,'FORBIDDEN',/access/],[400,'INVALID_SERVICE',/selections/],[409,'SLOT_CONFLICT',/another available time/],[0,'NETWORK_ERROR',/connection/],[503,'INTERNAL_ERROR',/retry/]]) test(`native safe recovery ${code}`,()=>{
  assert.match(state.safeMessage(new ZudeApiError(status,code,'private-provider-detail')),pattern);assert.ok(!state.safeMessage(new ZudeApiError(status,code,'private-provider-detail')).includes('private-provider-detail'));
});
function keyHarness() {
  const storage=new Map(), calls=[];let fail=null;
  const mod=load(base+'requestKeys.ts',{
    '@react-native-async-storage/async-storage':{default:{async getItem(k){return storage.get(k)||null},async setItem(k,v){storage.set(k,v)},async removeItem(k){storage.delete(k)}}},
    'expo-crypto':{CryptoDigestAlgorithm:{SHA256:'sha256'},digestStringAsync:async(_,v)=>crypto.createHash('sha256').update(v).digest('hex'),randomUUID:()=>crypto.randomUUID()},
    '../../lib/api':{ZudeApiError},'../../lib/appointments-api':{async mutateAppointment(business,body,key){calls.push({business,body,key});if(fail)throw fail;return{id:'saved'}}},
  });return{...mod,storage,calls,fail(e){fail=e}};
}
test('uncertain mutation retains durable intent key through retry and clears after verified success',async()=>{
  const h=keyHarness();h.fail(new ZudeApiError(0,'NETWORK_ERROR'));
  const body={customerId:'private-customer',serviceId:'s',appointmentDate:'2026-09-28',appointmentTime:'09:00:00'};
  await assert.rejects(h.performAction('u','b',body));assert.equal(h.storage.size,1);assert.ok(!JSON.stringify([...h.storage]).includes('private-customer'));
  h.fail(null);await h.performAction('u','b',body);assert.equal(h.calls[0].key,h.calls[1].key);assert.equal(h.storage.size,0);
});
test('request keys are scoped to user/business/intent; definitive conflicts permit a fresh key',async()=>{
  const h=keyHarness();h.fail(new ZudeApiError(409,'SLOT_CONFLICT'));
  await assert.rejects(h.performAction('u','b',{time:'09:00'}));await assert.rejects(h.performAction('u','b',{time:'09:00'}));assert.notEqual(h.calls[0].key,h.calls[1].key);
  h.fail(new ZudeApiError(0,'NETWORK_ERROR'));for(const [u,b] of [['u','b'],['u2','b'],['u','b2']]) await assert.rejects(h.performAction(u,b,{time:'09:00'}));assert.equal(h.storage.size,3);
});
test('concurrent duplicate submits share one mutation promise',async()=>{
  const h=keyHarness();await Promise.all([h.performAction('u','b',{status:'Confirmed'}),h.performAction('u','b',{status:'Confirmed'})]);assert.equal(h.calls.length,1);
});
function hooks() {
  const states=[],effects=[];let cursor=0,effectCursor=0;
  return {react:{useState(initial){const i=cursor++;if(!(i in states))states[i]=typeof initial==='function'?initial():initial;return[states[i],next=>{states[i]=typeof next==='function'?next(states[i]):next}]},
    useRef(initial){const i=cursor++;if(!(i in states))states[i]={current:initial};return states[i]},
    useEffect(fn,deps){const i=effectCursor++,old=effects[i];if(!old||deps.some((d,j)=>!Object.is(d,old.deps[j])))effects[i]={fn,deps,cleanup:old?.cleanup,pending:true}}},
    render(fn){cursor=0;effectCursor=0;const result=fn();for(const e of effects)if(e.pending){e.cleanup?.();e.cleanup=e.fn();e.pending=false}return result},unmount(){for(const e of effects)e.cleanup?.()}};
}
function resourceHarness() {
  const driver=hooks(),requests=[];let foreground;
  const {useResource}=load(base+'useResource.ts',{react:driver.react,'react-native':{AppState:{addEventListener(_,fn){foreground=fn;return{remove(){}}}}},'./state':state});
  return{requests,foreground:()=>foreground('active'),unmount:driver.unmount,render:(key)=>driver.render(()=>useResource(key,(signal)=>new Promise((resolve,reject)=>requests.push({key,signal,resolve,reject}))))};
}
test('resource hides stale tenant/day data and rejects late responses after navigation',async()=>{
  const h=resourceHarness();assert.equal(h.render('a:day1').loading,true);h.render('b:day2');assert.equal(h.requests[0].signal.aborted,true);
  h.requests[1].resolve(['new']);await flush();h.requests[0].resolve(['old']);await flush();assert.equal(JSON.stringify(h.render('b:day2').data),'["new"]');h.unmount();assert.ok(h.requests[1].signal.aborted);
});
test('resource error, explicit day refresh and foreground refresh hide obsolete data',async()=>{
  const h=resourceHarness();h.render('day');h.requests[0].reject(new ZudeApiError(0,'NETWORK_ERROR'));await flush();const failed=h.render('day');assert.match(failed.error,/connection/);
  failed.refresh();assert.ok(h.render('day').loading);h.requests[1].resolve([]);await flush();assert.equal(h.render('day').data.length,0);
  h.foreground();assert.ok(h.render('day').loading);assert.equal(h.requests.length,3);
});
const jsx={jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props}),Fragment:'Fragment'};
function nodes(node){if(!node||typeof node!=='object')return[];if(Array.isArray(node))return node.flatMap(nodes);return[node,...nodes(node.props?.children)]}
function composerHarness(options={}) {
  const driver=hooks(),calls=[],saved=[],viewed=[];let failure=null,refreshes=0;
  const controls={Action:'Action',DateControls:'DateControls',Notice:'Notice',s:{}};
  const customer={id:'c',full_name:'Customer',phone:null},service={id:'s',name:'Cut',duration_minutes:45};
  const result={id:'a',customer_id:'c',service_id:'s',customer_name:'Customer',service:'Cut',appointment_date:'2026-09-28',appointment_time:'09:00:00',status:'Booked'};
  const {AppointmentComposer}=load(base+'AppointmentComposer.tsx',{
    react:driver.react,'react/jsx-runtime':jsx,'react-native':Object.fromEntries(['ActivityIndicator','KeyboardAvoidingView','Modal','Pressable','ScrollView','Text','TextInput','View'].map(x=>[x,x]).concat([['Platform',{OS:'ios'}]])),
    'react-native-safe-area-context':{SafeAreaView:'SafeAreaView'},'../../lib/appointments-api':{},
    '../business/BusinessContext':{useBusiness:()=>({business:{id:'b',name:'Business',timezone:'UTC'},userId:'u'})},
    './requestKeys':{performAction:async(...args)=>{calls.push(args);if(failure)throw failure;return result}},'./state':state,'./controls':controls,
    './useResource':{useResource(key){return {data:!key?undefined:key.includes(':customers:')?{customers:[customer],nextOffset:null}:key.includes(':services')?[service]:{slots:options.code?[]:['09:00:00'],code:options.code||'AVAILABLE'},loading:!!options.loading,error:options.error,refresh(){refreshes++}}}},
  },{setTimeout:()=>1,clearTimeout(){}});
  let tree;
  const h={calls,saved,viewed,get refreshes(){return refreshes},fail(e){failure=e},render(){tree=driver.render(()=>AppointmentComposer({initialDate:'2026-09-28',today:'2026-09-28',appointment:options.appointment,onClose(){},onSaved:a=>saved.push(a),onView:a=>viewed.push(a)}));return tree},
    action(label){const item=nodes(tree).find(n=>n.type==='Action' && n.props.label===label);assert.ok(item,`Missing ${label}`);return item.props},
    select(){h.render();nodes(tree).find(n=>n.type==='Pressable').props.onPress();h.render();h.action('Cut · 45 min').onPress();h.render();h.action('9:00 AM').onPress();h.render()}};return h;
}
test('single composer booking succeeds with verified appointment and View Appointment action',async()=>{
  const h=composerHarness();h.select();assert.equal(h.action('Book Appointment').disabled,false);h.action('Book Appointment').onPress();await flush();h.render();assert.equal(h.saved.length,1);h.action('View Appointment').onPress();assert.equal(h.viewed[0].id,'a');
  assert.equal(h.calls[0][2].customerId,'c');assert.equal(h.calls[0][2].serviceId,'s');
});
test('composer conflict keeps selections, clears only time and refreshes SQL alternatives immediately',async()=>{
  const h=composerHarness();h.select();h.fail(new ZudeApiError(409,'SLOT_CONFLICT'));h.action('Book Appointment').onPress();await flush();h.render();assert.equal(h.action('Book Appointment').disabled,true);assert.equal(h.refreshes,1);
  h.fail(null);h.action('9:00 AM').onPress();h.render();h.action('Book Appointment').onPress();await flush();assert.equal(h.calls[1][2].customerId,'c');assert.equal(h.calls[1][2].serviceId,'s');assert.equal(h.calls[1][2].appointmentDate,'2026-09-28');
});
test('composer uncertain save locks changes and retries the exact same payload',async()=>{
  const h=composerHarness();h.select();h.fail(new ZudeApiError(0,'NETWORK_ERROR'));h.action('Book Appointment').onPress();await flush();h.render();assert.equal(h.action('Close').disabled,true);assert.equal(h.action('Change customer').disabled,true);assert.equal(h.action('Retry Same Request').disabled,false);
  h.fail(null);h.action('Retry Same Request').onPress();await flush();assert.equal(JSON.stringify(h.calls[0][2]),JSON.stringify(h.calls[1][2]));
});
for(const [code,pattern] of [['CLOSED',/closed/],['NO_AVAILABILITY',/No available times/]]) test(`composer presents real ${code} and keeps booking disabled`,()=>{
  const h=composerHarness({code});h.render();
  // Select customer and service; no authoritative time can be chosen.
  const tree=h.render();nodes(tree).find(n=>n.type==='Pressable').props.onPress();h.render();h.action('Cut · 45 min').onPress();
  const ready=h.render();assert.equal(h.action('Book Appointment').disabled,true);assert.ok(nodes(ready).some(n=>n.type==='Notice' && pattern.test(n.props.message)));
});
test('reschedule keeps customer/service and sends only reviewed date/time to existing mutation',async()=>{
  const appointment={id:'target',customer_id:'c',service_id:'s',customer_name:'Customer',service:'Cut',notes:'Existing note',appointment_date:'2026-09-28',status:'Booked'};
  const h=composerHarness({appointment});let tree=h.render();assert.ok(!nodes(tree).some(n=>n.type==='Action' && n.props.label==='Change customer'));
  nodes(tree).find(n=>n.type==='DateControls').props.onChange('2026-09-29');h.render();h.action('9:00 AM').onPress();h.render();h.action('Save Reschedule').onPress();await flush();
  const body=h.calls[0][2];assert.equal(body.appointmentId,'target');assert.equal(body.customerId,'c');assert.equal(body.serviceId,'s');assert.equal(body.appointmentDate,'2026-09-29');assert.equal(body.notes,'Existing note');
});
test('composer renders loading/error data states without enabling an unverified booking',()=>{
  const h=composerHarness({loading:true,error:'Unable to reach ZUDE.'});const tree=h.render();assert.equal(h.action('Book Appointment').disabled,true);assert.ok(nodes(tree).some(n=>n.type==='ActivityIndicator'));assert.ok(nodes(tree).some(n=>n.type==='Notice'));
});
test('configuration/storage failures do not pretend a mutation was sent',()=>{
  for(const code of ['CONFIGURATION_ERROR','LOCAL_STORAGE_ERROR']) assert.equal(state.uncertainAction(new ZudeApiError(0,code)),false);
  assert.match(state.safeMessage(new ZudeApiError(0,'LOCAL_STORAGE_ERROR')),/No request was sent/);
});
