const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const ts=require('typescript');
class ZudeApiError extends Error {constructor(status,code,message){super(message);this.status=status;this.code=code}}
function harness(payload) {
  const calls=[],exports={};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('apps/zude-mobile/src/lib/appointments-api.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,URLSearchParams,require(){return{ZudeApiError,apiGet:async(...args)=>{calls.push(args);return payload},apiMutate:async(...args)=>{calls.push(args);return payload}}}});
  return{...exports,calls};
}
const signal=new AbortController().signal;
const appointment={id:'a',appointment_date:'2026-09-28',status:'Booked'};
test('native day rejects data from another tenant/date before display',async()=>{
  for(const payload of [{businessId:'other',date:'2026-09-28',appointments:[appointment]},{businessId:'b',date:'2026-09-29',appointments:[appointment]}]) {
    await assert.rejects(harness(payload).getDay('b','2026-09-28',signal),e=>e.code==='INVALID_RESPONSE');
  }
});
test('native availability binds slots to exact service/date/target, preserving closed as data',async()=>{
  const base={businessId:'b',date:'2026-09-28',serviceId:'s',appointmentId:'a',code:'CLOSED',slots:[]};
  assert.equal((await harness(base).getAvailability('b','2026-09-28','s','a',signal)).code,'CLOSED');
  for(const patch of [{serviceId:'other'},{appointmentId:null},{slots:['25:00:00']},{slots:['09:00:00']}]) {
    await assert.rejects(harness({...base,...patch}).getAvailability('b','2026-09-28','s','a',signal),e=>e.code==='INVALID_RESPONSE');
  }
});
test('native success requires matching mutation receipt tenant and target',async()=>{
  const base={appointment,receipt:{business_id:'b',appointment_id:'a'}};
  assert.equal((await harness(base).mutateAppointment('b',{appointmentId:'a',status:'Confirmed'},'key','u')).id,'a');
  for(const receipt of [{business_id:'other',appointment_id:'a'},{business_id:'b',appointment_id:'other'}]) await assert.rejects(harness({...base,receipt}).mutateAppointment('b',{appointmentId:'a'},'key','u'),e=>e.code==='INVALID_RESPONSE');
});
test('customer search is encoded and sent through the API with cancellation/business scope',async()=>{
  const h=harness({businessId:'b',customers:[],nextOffset:null});await h.getCustomers('b','A&B',25,signal);
  assert.equal(h.calls[0][0],'/api/customers?q=A%26B&offset=25');assert.equal(h.calls[0][1].signal,signal);assert.equal(h.calls[0][1].businessId,'b');
});
