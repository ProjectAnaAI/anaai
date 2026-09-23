// Behavioral application tests with a deterministic in-memory DB protocol double.
// PostgreSQL uniqueness/locking/RLS must additionally be tested on the real schema.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
function load(file,imports={}){const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:n=>imports[n],Request,Response,crypto:require('node:crypto').webcrypto,console:{error(){},log(){}},process:{env:{NEXT_PUBLIC_SUPABASE_URL:'test',NEXT_PUBLIC_SUPABASE_ANON_KEY:'test'}}});return exports;}
const ai=load('lib/ai-actions.ts');
const id=n=>`${n}`.repeat(8)+'-'+`${n}`.repeat(4)+'-'+`${n}`.repeat(4)+'-'+`${n}`.repeat(4)+'-'+`${n}`.repeat(12);
const business=id(1),target=id(2),service=id(3),customer=id(4),key=id(5);
const body={appointmentId:target,customerId:customer,serviceId:service,appointmentDate:'2026-10-05',appointmentTime:'10:00',notes:null};
function harness({initial='Booked',sms='accepted',deny=false}={}){
 const actions=new Map();let status=initial,mutations=0,sends=0,notification=null;
 const db={rpc:async(name,p)=>{
   if(name==='claim_appointment_notification'){
     if(!notification||notification.status!=='pending')return{data:{claimed:false}};
     notification.status='uncertain';return{data:{claimed:true,id:id(7),token:id(8),kind:'confirmation',payload:{phone:'2025550100',date:'2026-10-05',time:'10:00',action:'confirm'}}};
   }
   if(name==='finish_appointment_notification'){if(sms==='record-failure')return{error:{}};notification.status=p.p_status;return{data:true};}
   const action=name.startsWith('confirm')?'confirm':name.startsWith('cancel')?'cancel':p.p_operation==='reschedule'?'reschedule':'book';
   const binding=JSON.stringify({action,fingerprint:p.p_request_fingerprint,target:p.p_appointment_id||p.p_request?.appointment_id});
   const prior=actions.get(p.p_idempotency_key);
   if(prior)return{data:prior.binding!==binding?{success:false,code:'IDEMPOTENCY_CONFLICT'}:{...prior.receipt,replayed:true}};
   let changed=true;
   const desired=action==='confirm'?'Confirmed':action==='cancel'?'Cancelled':status;
   if(action==='confirm'||action==='cancel'){
     if(status===desired)changed=false;
     else if(!(status==='Booked'||action==='cancel'&&status==='Confirmed'))return{data:{success:false,code:'INVALID_TRANSITION'}};
   }
   if(action==='reschedule'&&!['Booked','Confirmed'].includes(status))return{data:{success:false,code:'TERMINAL_APPOINTMENT'}};
   if(action==='book')status='Booked';else status=desired;
   if(changed)mutations++;
   const appointment={id:target,business_id:business,customer_id:customer,service_id:service,appointment_date:p.p_request?.date||body.appointmentDate,appointment_time:p.p_request?.time||body.appointmentTime,status};
   const receipt={success:true,changed,replayed:false,action_id:id(6),action_type:action,business_id:business,appointment_id:target,receipt_scope:'action_outcome',code:changed?'APPLIED':'ALREADY_IN_TARGET_STATE',status,appointment};
   actions.set(p.p_idempotency_key,{binding,receipt});if(changed&&action!=='book')notification={status:'pending'};
   return{data:receipt};
 }};
 const helpers=load('lib/appointment-actions.ts',{'node:crypto':require('node:crypto'),'./ai-actions':ai,'./twilio':{sendSms:async()=>{sends++;if(sms==='throw')throw Error('private');return sms==='accepted'||sms==='record-failure'?{success:true,messageSid:'SM'+'0'.repeat(32)}:{success:false,outcome:sms};}}});
 const route=load('server/handlers/appointments.ts',{'@/lib/appointment-actions':helpers,'@/lib/business-context':{resolveBusinessContext:async()=>deny?{success:false,status:403,error:'Denied'}:{success:true,context:{businessId:business}}},'@supabase/supabase-js':{createClient:()=>db}});
 return{helpers,db,counts:()=>({mutations,sends,actions:actions.size,status,notification:notification?.status}),call:async(method='PATCH',value={appointmentId:target,status:'Confirmed'},k=key)=>{const r=await route[method](new Request('https://example.invalid/api/appointments',{method,headers:{authorization:'Bearer test','idempotency-key':k},body:JSON.stringify(value)}));return{status:r.status,body:await r.json()};}};
}
test('sequential and concurrent identical requests converge through DB replay contract',async()=>{const h=harness();const results=await Promise.all([h.call('POST',body),h.call('POST',body),h.call('POST',body)]);assert.ok(results.every(r=>r.body.success));assert.equal(h.counts().mutations,1);assert.equal(h.counts().actions,1);assert.equal(results.filter(r=>r.body.receipt.replayed).length,2);});
test('same key changed structured request is rejected',async()=>{const h=harness();await h.call('POST',body);assert.equal((await h.call('POST',{...body,appointmentTime:'11:00'})).status,409);assert.equal(h.counts().mutations,1);});
for(const [initial,desired,success,changed] of [['Booked','Confirmed',true,true],['Confirmed','Confirmed',true,false],['Cancelled','Confirmed',false,false],['Booked','Cancelled',true,true],['Confirmed','Cancelled',true,true],['Cancelled','Cancelled',true,false],['Completed','Cancelled',false,false],[null,'Confirmed',false,false]])test(`lifecycle ${initial} -> ${desired}`,async()=>{const h=harness({initial});const first=await h.call('PATCH',{appointmentId:target,status:desired});assert.equal(first.body.success===true,success);assert.equal(h.counts().mutations,changed?1:0);if(success){const second=await h.call('PATCH',{appointmentId:target,status:desired});assert.equal(second.body.receipt.replayed,true);assert.equal(h.counts().sends,changed?1:0);assert.match(second.body.message,/original/);}});
for(const sms of ['failed','uncertain','throw','record-failure'])test(`committed action survives ${sms}; replay never blindly resends`,async()=>{const h=harness({sms});assert.equal((await h.call()).body.success,true);assert.equal((await h.call()).body.success,true);assert.equal(h.counts().sends,1);assert.equal(h.counts().mutations,1);});
test('caller notification type cannot dictate wording/action',async()=>{const h=harness();const result=await h.call('PATCH',{appointmentId:target,status:'Confirmed',notificationType:'cancel'});assert.equal(result.body.receipt.action_type,'confirm');});
test('tenant denial prevents all action and notification RPCs',async()=>{const h=harness({deny:true});assert.equal((await h.call()).status,403);assert.equal(h.counts().mutations,0);assert.equal(h.counts().actions,0);});
for(const day of ['2026-10-05','2026-10-06'])test(`reschedule ${day} replays without mutation`,async()=>{const h=harness();const value={...body,appointmentDate:day};assert.equal((await h.call('PATCH',value)).body.success,true);assert.equal((await h.call('PATCH',value)).body.receipt.replayed,true);assert.equal(h.counts().mutations,1);assert.equal(h.counts().sends,1);});
test('fingerprint ignores key order and canonicalizes equivalent time/phone',()=>{const h=harness();const first=h.helpers.schedulingIntent({service_id:service,date:'2026-10-05',time:'10:00',customer_name:' Test ',customer_phone:'(202) 555-0100'});const second=h.helpers.schedulingIntent({customer_phone:'+12025550100',customer_name:'Test',time:'10:00:00.000000',date:'2026-10-05',service_id:service});assert.equal(h.helpers.fingerprint(first),h.helpers.fingerprint(second));assert.notEqual(h.helpers.fingerprint(first),h.helpers.fingerprint({...second,notes:'different'}));});
test('request keys persist through retries and change for edited input or success',()=>{const store=load('lib/appointment-request-key.ts').createRequestKeyStore();const first=store.forRequest({business,body});assert.equal(store.forRequest({business,body}),first);assert.notEqual(store.forRequest({business,body:{...body,notes:'changed'}}),first);store.clear();assert.notEqual(store.forRequest({business,body}),first);});
test('forged action receipts and wrong tenant/target cannot authorize UI success',()=>{const h=harness();for(const value of [null,{success:'true'},{success:true,changed:true,replayed:false,action_id:id(6),appointment_id:target,business_id:id(9),action_type:'confirm',receipt_scope:'action_outcome',code:'APPLIED',status:'Confirmed',appointment:{id:target}}])assert.equal(h.helpers.actionReceipt(value,business,'confirm',target),null);});
