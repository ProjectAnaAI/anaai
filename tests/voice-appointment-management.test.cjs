const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const crypto = require('node:crypto');
const B = '11111111-1111-4111-8111-111111111111';
const C = '22222222-2222-4222-8222-222222222222';
const S = '33333333-3333-4333-8333-333333333333';
const A = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';
const PHONE = '+12025550123';
const NOW = Date.parse('2026-10-01T12:00:00Z');
const target = { id: A, businessId: B, customerId: C, serviceId: S, serviceName: 'Haircut', date: '2026-10-06', time: '17:00', status: 'Booked' };
class Clock extends Date { constructor(...args) { super(...(args.length ? args : [NOW])); } static now() { return NOW; } }
function harness() {
  const cache = {}, logs = [], calls = [];
  let rpc = async () => ({ data: null, error: null });
  const db = {
    rpc: async (name, args) => { calls.push({ name, args }); return rpc(name, args); },
    from(table) {
      const q = {};
      for (const method of ['select','eq','abortSignal']) q[method] = () => q;
      q.maybeSingle = async () => ({ data: table === 'business_phone_numbers' ?
        { business_id: B, businesses: { name: 'Salon', timezone: 'UTC' } } :
        { human_transfer_phone: '+12025550999', is_enabled: true }, error: null });
      return q;
    },
  };
  function load(file) {
    if (cache[file]) return cache[file];
    const exports = {}; cache[file] = exports;
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, { exports, Buffer, Date: Clock, Intl, URL, AbortSignal, FormData,
      process: { env: { VOICE_STATE_SECRET: 'ab'.repeat(32), TWILIO_VOICE_WEBHOOK_URL: 'https://example.invalid/api/voice' } },
      console: { info: (...x) => logs.push(x), error: (...x) => logs.push(x) },
      require(name) {
        if (name === 'server-only') return {};
        if (name === 'node:crypto') return crypto;
        if (name === 'twilio') return { default: require('twilio') };
        if (name === '@/lib/voice-booking') return { loadVoiceServices: async () => [], executeVoiceBooking: async () => { throw Error('unexpected new booking'); } };
        if (name === '@/lib/voice-receptionist') return { safeVoiceText: v => v, answerVoiceQuestion: async () => 'Information' };
        if (name === '@/lib/voice-understanding') return { understandVoiceTurn: async () => { throw Error('unexpected model'); } };
        if (name === '@/lib/supabase-server') return { createSupabaseServiceClient: () => db };
        if (name.startsWith('@/')) return load(name.slice(2) + '.ts');
        if (name === './ai-actions') return load('lib/ai-actions.ts');
        throw Error(name);
      },
    });
    return exports;
  }
  const state = load('lib/voice-state.ts'), management = load('lib/voice-appointment-management.ts');
  const fresh = (action = 'cancel') => state.initialManagementState(state.initialVoiceState(), action);
  const binding = { businessId: B, callSid: 'CA' + 'a'.repeat(32), ingress: 'production' };
  return { state, management, fresh, binding, logs, calls,
    async run(speech, token = '', digits = '', confidence = '0.95') {
      const formData = new FormData();
      for (const [key,value] of Object.entries({ From: PHONE, To: '+12025550100', CallSid: binding.callSid, SpeechResult: speech, Digits: digits })) formData.set(key,value);
      if (confidence !== null) formData.set('Confidence', confidence);
      return load('lib/voice-handler.ts').buildVoiceResponse({ formData, mode: token ? 'listen' : '', ingress: 'production', stateToken: token });
    }, rpc(fn) { rpc = fn; } };
}
function conversation(action = 'cancel', rows = [target]) {
  const h = harness(), state = h.fresh(action), checks = [], commits = [];
  let outcome = { verified: true, conflict: false, replayed: false };
  const deps = {
    lookup: async () => rows,
    execute: async (s, b, p, check) => {
      (check ? checks : commits).push(JSON.parse(JSON.stringify(s.management)));
      return outcome;
    },
  };
  return { ...h, state, checks, commits, outcome(value) { outcome = value; },
    turn(speech, options = {}) { return h.management.voiceManagementTurn({ state, businessId: B, callerPhone: PHONE,
      timezone: 'UTC', speech, digits: '', confidence: 'high', ...options }, deps); },
  };
}
for (const [speech, expected] of [['cancel my appointment tomorrow','cancel'], ['cancel my haircut','cancel'],
  ['reschedule my haircut','reschedule'], ['move my appointment','reschedule'], ['change my 5 PM appointment','reschedule'], ['book an appointment',null]]) {
  test(`intent: ${speech}`, () => assert.equal(harness().management.managementIntent(speech), expected));
}
test('unfinished new booking cancellation stays in booking flow', () => assert.equal(harness().management.managementIntent('cancel this new booking', true), null));
for (const phone of ['+12025550123', '(202) 555-0123', '12025550123']) test(`phone normalization ${phone}`, () => assert.equal(harness().management.managementPhone(phone), PHONE));
test('anonymous caller cannot look up appointments', async () => { const h=harness(); assert.equal(await h.management.lookupVoiceAppointments(B,'anonymous'),null); assert.equal(h.calls.length,0); });
for (const [label, mutate] of [
  ['wrong business', d => d.appointments[0].businessId=OTHER],
  ['wrong customer', d => d.appointments[0].customerId=OTHER],
  ['terminal', d => d.appointments[0].status='Completed'],
  ['cancelled', d => d.appointments[0].status='Cancelled'],
  ['duplicate', d => d.appointments.push({...d.appointments[0]})],
  ['malformed', d => d.appointments[0].time='99:00'],
  ['extra PII', d => d.appointments[0].phone=PHONE],
]) test(`lookup rejects ${label}`, async () => {
  const h=harness(), d={success:true,business_id:B,customer_id:C,appointments:[{...target}]}; mutate(d);
  h.rpc(async()=>({data:d,error:null})); assert.equal(await h.management.lookupVoiceAppointments(B,PHONE),null);
});
test('lookup validates business and customer and sends only signed context', async () => {
  const h=harness(); h.rpc(async()=>({data:{success:true,business_id:B,customer_id:C,appointments:[target]},error:null}));
  assert.equal((await h.management.lookupVoiceAppointments(B,PHONE))[0].id,A);
  assert.equal(h.calls[0].args.p_business_id,B); assert.equal(h.calls[0].args.p_caller_phone,PHONE);
});
test('zero matches does not mutate', async () => { const h=conversation('cancel',[]); assert.match((await h.turn('cancel my appointment')).message,/couldn't find/); assert.equal(h.commits.length,0); });
test('one match is summarized but details never authorize cancel', async () => { const h=conversation(); const r=await h.turn('cancel my haircut on October 6th',{opening:true}); assert.match(r.message,/October 6.*5 PM/); assert.equal(h.state.management.stage,'confirm'); assert.equal(h.commits.length,0); });
test('multiple appointments require clarification and preserve selectors', async () => {
  const h=conversation('cancel',[target,{...target,id:OTHER,time:'15:00'}]);
  assert.match((await h.turn('cancel my haircut')).message,/Which appointment/); assert.equal(h.state.management.target,null);
  await h.turn('5 PM'); assert.equal(h.state.management.target.id,A); assert.equal(h.commits.length,0);
});
for(const mode of ['speech','dtmf']) test(`cancel explicit ${mode} confirmation`, async()=>{
  const h=conversation(); await h.turn('cancel my appointment',{opening:true});
  assert.match((await h.turn(mode==='speech'?'yes':'',{digits:mode==='dtmf'?'1':''})).message,/has been cancelled/); assert.equal(h.commits.length,1);
});
test('DTMF outside pending confirmation never mutates', async()=>{const h=conversation(); await h.turn('',{digits:'1'});assert.equal(h.commits.length,0);});
test('DTMF 2 declines pending cancellation',async()=>{const h=conversation();await h.turn('cancel my appointment');assert.equal((await h.turn('',{digits:'2'})).done,true);assert.equal(h.commits.length,0);});
for(const confidence of ['low','invalid']) test(`${confidence} speech cannot cancel`,async()=>{const h=conversation();await h.turn('cancel my appointment');await h.turn('yes',{confidence});assert.equal(h.commits.length,0);});
test('backend cancellation rejection never speaks success',async()=>{const h=conversation();await h.turn('cancel my appointment');h.outcome({verified:false});assert.match((await h.turn('yes')).message,/couldn't verify/);});
test('replay describes original outcome, not a second change',async()=>{const h=conversation();await h.turn('cancel my appointment');h.outcome({verified:true,replayed:true});assert.match((await h.turn('yes')).message,/retry made no new change/);});
test('old and replacement dates are separated',async()=>{
  const h=conversation('reschedule');await h.turn('Move my October 6th appointment to October 7th at 3 PM',{opening:true});
  assert.equal(h.state.management.target.date,'2026-10-06');assert.equal(h.state.management.date,'2026-10-07');assert.equal(h.state.management.time,'15:00');assert.equal(h.checks.length,1);assert.equal(h.commits.length,0);
  await h.turn('yes');assert.equal(h.commits.length,1);
});
test('replacement collection, AM/PM clarification and corrections preserve target',async()=>{
  const h=conversation('reschedule');await h.turn('reschedule my haircut',{opening:true});
  await h.turn('October 7th at 3');assert.equal(h.state.management.verified,false);await h.turn('PM');
  assert.equal(h.state.management.time,'15:00');await h.turn('Actually make that 5');await h.turn('PM');
  assert.equal(h.state.management.date,'2026-10-07');assert.equal(h.state.management.time,'17:00');
  await h.turn('No, October 8th instead');assert.equal(h.state.management.date,'2026-10-08');assert.equal(h.state.management.time,'17:00');assert.equal(h.state.management.target.id,A);assert.equal(h.commits.length,0);assert.equal(h.checks.length,3);
});
for(const speech of ['yes, October 8th instead','yes, make that 4 PM','yes, change the day to something else']) test(`detail-bearing affirmative cannot commit: ${speech}`,async()=>{
  const h=conversation('reschedule');await h.turn('move my appointment to October 7th at 3 PM',{opening:true});await h.turn(speech);assert.equal(h.commits.length,0);
});
test('unparseable correction invalidates stale confirmation',async()=>{
  const h=conversation('reschedule');await h.turn('move my appointment to October 7th at 3 PM');await h.turn('actually another time');await h.turn('yes');assert.equal(h.commits.length,0);assert.equal(h.state.management.verified,false);
});
test('ambiguous target retains requested replacement until disambiguation',async()=>{
  const h=conversation('reschedule',[target,{...target,id:OTHER,date:'2026-10-09'}]);
  await h.turn('move my haircut to October 7th at 3 PM');await h.turn('October 6th');assert.equal(h.state.management.date,'2026-10-07');assert.equal(h.state.management.time,'15:00');assert.equal(h.state.management.target.id,A);
});
test('unavailable replacement never reaches confirmation',async()=>{
  const h=conversation('reschedule');h.outcome({verified:false,conflict:true});assert.match((await h.turn('move my appointment to October 7th at 3 PM')).message,/isn't available/);assert.equal(h.state.management.verified,false);await h.turn('yes');assert.equal(h.commits.length,0);
});
test('commit race invalidates slot and creates fresh operation key',async()=>{
  const h=conversation('reschedule');await h.turn('move my appointment to October 7th at 3 PM');const key=h.state.management.idempotencyKey;
  h.outcome({verified:false,conflict:true});assert.match((await h.turn('yes')).message,/no longer available/);assert.equal(h.state.management.verified,false);assert.notEqual(h.state.management.idempotencyKey,key);
});
function receipt(s) { const m=s.management;return {success:true,changed:true,code:'APPLIED',action_id:OTHER,action_type:m.action,business_id:B,appointment_id:A,customer_id:C,service_id:S,date:m.action==='cancel'?target.date:m.date,time:m.action==='cancel'?target.time:m.time,status:m.action==='cancel'?'Cancelled':'Booked',duration_minutes:23,replayed:false,receipt_scope:'action_outcome'}; }
for(const action of ['cancel','reschedule']) test(`${action} validates complete receipt and rejects mismatches`,async()=>{
  const h=conversation(action);await h.turn(action==='cancel'?'cancel my appointment':'move my appointment to October 7th at 3 PM');
  const r=receipt(h.state);assert.equal(h.management.managementReceipt(r,h.state,B,false),true);
  for(const field of ['business_id','appointment_id','customer_id','service_id','action_type','status','date','time','code','receipt_scope','action_id','replayed','success','changed']) assert.equal(h.management.managementReceipt({...r,[field]:'bad'},h.state,B,false),false,field);
  if(action==='reschedule') for(const duration of [null,0,-1,1.5,'23']) assert.equal(h.management.managementReceipt({...r,duration_minutes:duration},h.state,B,false),false);
});
test('RPC fingerprint and key stable on retry; fingerprint changes with detail',async()=>{
  const h=conversation('reschedule');await h.turn('move my appointment to October 7th at 3 PM');h.rpc(async()=>({data:receipt(h.state),error:null}));
  await h.management.manageVoiceAppointment(h.state,B,PHONE,false);await h.management.manageVoiceAppointment(h.state,B,PHONE,false);
  assert.equal(h.calls[0].args.p_idempotency_key,h.calls[1].args.p_idempotency_key);assert.equal(h.calls[0].args.p_request_fingerprint,h.calls[1].args.p_request_fingerprint);
  h.state.management.time='16:00';await h.management.manageVoiceAppointment(h.state,B,PHONE,false);assert.notEqual(h.calls[0].args.p_request_fingerprint,h.calls[2].args.p_request_fingerprint);
});
test('idempotency conflict and malformed backend payload fail receipt validation',async()=>{
  const h=conversation();await h.turn('cancel my appointment');for(const data of [{success:false,code:'IDEMPOTENCY_CONFLICT'},null,{success:true}]) { h.rpc(async()=>({data,error:null}));assert.equal((await h.management.manageVoiceAppointment(h.state,B,PHONE,false)).verified,false); }
});
test('state roundtrip is encrypted, bounded and contains no caller PII',async()=>{
  const h=conversation('reschedule');await h.turn('move my appointment to October 7th at 3 PM');const token=h.state; // conversation state shadows module
  const st=harness().state;const sealed=st.sealVoiceState(token,h.binding);assert.ok(sealed.length<1800);assert.equal(st.openVoiceState(sealed,h.binding).management.target.id,A);
  assert.doesNotMatch(sealed,/Haircut|2026-10|202255/);assert.doesNotMatch(JSON.stringify(token),/customerName|customerPhone|transcript/);
});
test('state rejects impossible combinations, unknown fields and malformed targets',()=>{
  const h=harness();for(const mutate of [s=>s.management.stage='confirm',s=>s.management.verified=true,s=>s.management.phone=PHONE,s=>s.management.date='2026-02-31',s=>s.management.target=target,s=>s.management.pendingTimeOptions=['99:00','15:00']]) {
    const s=h.fresh();mutate(s);assert.throws(()=>h.state.openVoiceState(h.state.sealVoiceState(s,h.binding),h.binding));
  }
});
test('state rejects call/business substitution, expiry and turn exhaustion',()=>{
  const h=harness(),s=h.fresh(),token=h.state.sealVoiceState(s,h.binding);
  for(const b of [{...h.binding,businessId:OTHER},{...h.binding,callSid:'CA'+'b'.repeat(32)}]) assert.throws(()=>h.state.openVoiceState(token,b));
  assert.throws(()=>h.state.openVoiceState(token,h.binding,NOW+31*60000));s.turns=30;assert.throws(()=>h.state.openVoiceState(h.state.sealVoiceState(s,h.binding),h.binding));
});
test('management logs contain bounded categories only',async()=>{const h=harness();h.rpc(async()=>{throw Error(PHONE+A);});await h.management.lookupVoiceAppointments(B,PHONE);assert.doesNotMatch(JSON.stringify(h.logs),new RegExp(PHONE.replace('+','\\+')+'|'+A));});

const migration=fs.readFileSync('supabase/migrations/202609210008_voice_appointment_management.sql','utf8');
const sql=migration.replace(/\/\*[\s\S]*?\*\//g,'').replace(/--[^\n]*/g,'');
test('service-only bridge signatures, pinned search path, and grants',()=>{
  for(const signature of ['voice_find_appointments_business(uuid,text)','voice_manage_appointment_business(uuid,text,uuid,text,uuid,text,jsonb,date,time,boolean)']) {
    assert.ok(sql.includes(`revoke all on function public.${signature} from public,anon,authenticated;`));assert.ok(sql.includes(`grant execute on function public.${signature} to service_role;`));
  }
  assert.match(sql,/voice_manage_appointment_business\([\s\S]+?security definer\s+set search_path = pg_catalog, public/);
  assert.doesNotMatch(sql,/grant execute on function public\.[^;]+ to (?:anon|authenticated)/);
});
test('bridge reuses authoritative cores and has ledger-before-date-before-row lock ordering',()=>{
  const bridge=sql.slice(sql.indexOf('create function public.voice_manage_appointment_business'));
  assert.ok(bridge.indexOf('insert into public.appointment_actions')<bridge.indexOf('pg_advisory_xact_lock'));
  assert.ok(bridge.indexOf('pg_advisory_xact_lock')<bridge.indexOf('into v_old'));
  assert.match(bridge,/anaai_private\.reschedule_appointment_core/);assert.match(bridge,/anaai_private\.appointment_lifecycle_core/);
  assert.match(bridge,/request_payload is distinct from v_request/);assert.match(bridge,/request_fingerprint is distinct from p_request_fingerprint/);
  assert.match(bridge,/return v_action.result \|\| jsonb_build_object\('replayed',true\)/);
  assert.match(bridge,/customer_id=v_customer for update/);assert.match(bridge,/p_expected is distinct from jsonb_build_object/);
});
test('shared scheduler preserves self-exclusion, current duration and fail-closed capacity',()=>{
  const core=sql.slice(0,sql.indexOf('create or replace function public.reschedule_appointment_atomic_business'));
  assert.match(core,/check_appointment_capacity_business\(\s*p_business_id,\s*p_appointment_date,\s*p_appointment_time,\s*v_service.duration_minutes,\s*p_appointment_id/);
  assert.match(core,/v_capacity_result is distinct from 'AVAILABLE'/);assert.match(core,/duration_minutes = v_service.duration_minutes/);
  assert.match(core,/status not in \('Booked', 'Confirmed'\)/);assert.match(core,/and is_active = true/);
  assert.ok(core.indexOf('if p_check_only then')<core.indexOf('update public.appointments'));
});
test('manual wrapper retains invoker/member auth and private helper retains member guard',()=>{
  const manual=sql.slice(sql.indexOf('create or replace function public.reschedule_appointment_atomic_business'),sql.indexOf('create or replace function anaai_private.appointment_lifecycle_core'));
  assert.match(manual,/security invoker/);assert.match(manual,/if v_user_id is null/);assert.match(manual,/is_business_member\(p_business_id\)/);
  assert.match(sql,/if auth.role\(\) is distinct from 'service_role' then[\s\S]*?is_business_member/);
});
test('no booking/AI/capacity replacement, data backfill, or historical mutation',()=>{
  assert.doesNotMatch(sql,/create or replace function public\.(?:voice_book|book_appointment|schedule_appointment_idempotent|create_appointment)/);
  assert.doesNotMatch(sql,/create or replace function anaai_private.check_appointment_capacity/);
  assert.doesNotMatch(sql,/alter table|delete from/);
});
test('human handoff precedes management dispatch including bare person',()=>{
  const source=fs.readFileSync('lib/voice-handler.ts','utf8'); const start=source.indexOf('async function buildVoiceResponseInternal'); const transfer=source.indexOf('const transferred =',start); assert.ok(transfer > start && transfer < source.indexOf('const intent = managementIntent',start));
  assert.match(source,/\^person/);
});
function stateToken(xml) {
  const action = /action="([^"]+)"/.exec(xml)?.[1];
  return action ? new URL(action.replaceAll('&amp;','&')).searchParams.get('state') : '';
}
function rpcResponse(args) {
  return { success:true,changed:true,code:'APPLIED',action_id:OTHER,action_type:args.p_action_type,
    business_id:B,appointment_id:A,customer_id:C,service_id:S,
    date:args.p_date||target.date,time:args.p_time||target.time,
    status:args.p_action_type==='cancel'?'Cancelled':'Booked',duration_minutes:23,
    receipt_scope:'action_outcome',replayed:false };
}
test('actual handler routes cancellation, seals state and validates commit receipt',async()=>{
  const h=harness();h.rpc(async(name,args)=>({data:name==='voice_find_appointments_business'?
    {success:true,business_id:B,customer_id:C,appointments:[target]}:rpcResponse(args),error:null}));
  const prompt=await h.run('cancel my haircut on October 6th');assert.match(prompt,/Do you want me to cancel/);
  assert.equal(h.calls.filter(c=>c.name==='voice_manage_appointment_business').length,0);
  const done=await h.run('yes',stateToken(prompt));assert.match(done,/has been cancelled/);
  assert.equal(h.calls.filter(c=>c.name==='voice_manage_appointment_business').length,1);
});
for(const speech of ['person','human','representative','speak to someone']) test(`handler transfer preempts pending management: ${speech}`,async()=>{
  const h=harness();h.rpc(async()=>({data:{success:true,business_id:B,customer_id:C,appointments:[target]},error:null}));
  const prompt=await h.run('cancel my appointment');const before=h.calls.length;
  const done=await h.run(speech,stateToken(prompt));assert.match(done,/<Dial>/);assert.equal(h.calls.length,before);
});
test('same final webhook reuses key and validates replay receipt',async()=>{
  const h=harness();let prior;
  h.rpc(async(name,args)=>{
    if(name==='voice_find_appointments_business')return {data:{success:true,business_id:B,customer_id:C,appointments:[target]},error:null};
    if(prior) {assert.equal(args.p_idempotency_key,prior.p_idempotency_key);assert.equal(args.p_request_fingerprint,prior.p_request_fingerprint);}
    const replayed=!!prior;prior=args;return {data:{...rpcResponse(args),replayed},error:null};
  });
  const prompt=await h.run('cancel my appointment');const token=stateToken(prompt);
  await h.run('yes',token);assert.match(await h.run('yes',token),/retry made no new change/);
});
test('actual handler reschedule checks replacement and DTMF commits only pending summary',async()=>{
  const h=harness();h.rpc(async(name,args)=>({error:null,data:name==='voice_find_appointments_business'?
    {success:true,business_id:B,customer_id:C,appointments:[target]}:args.p_check_only?
    {...rpcResponse(args),available:true,code:'AVAILABLE'}:rpcResponse(args)}));
  let prompt=await h.run('move my appointment on October 6th to October 7th at 3 PM');
  assert.match(prompt,/Say yes or press 1/);assert.equal(h.calls[1].args.p_check_only,true);
  prompt=await h.run('yes, October 8th instead',stateToken(prompt));assert.equal(h.calls[2].args.p_check_only,true);
  assert.match(await h.run('',stateToken(prompt),'1'),/has been rescheduled/);assert.equal(h.calls[3].args.p_check_only,false);
});
test('cancel detail-changing yes requires a fresh target summary',async()=>{
  const h=conversation('cancel',[target,{...target,id:OTHER,date:'2026-10-08'}]);await h.turn('cancel my appointment October 6th');
  await h.turn('yes, October 8th instead');assert.equal(h.commits.length,0);assert.equal(h.state.management.target.id,OTHER);
});
test('unknown service selector does not silently choose sole appointment',async()=>{
  const h=conversation();assert.match((await h.turn('cancel my massage')).message,/Which appointment/);assert.equal(h.state.management.target,null);
});
test('switching cancellation to reschedule never cancels the target',async()=>{
  const h=conversation();await h.turn('cancel my appointment');await h.turn('reschedule my appointment instead');
  assert.equal(h.state.management.action,'reschedule');assert.equal(h.state.management.stage,'replacement');assert.equal(h.commits.length,0);
});
test('shared scheduler body matches 007 apart from guarded service access and check-only support',()=>{
  const old=fs.readFileSync('supabase/migrations/202609210007_appointment_duration_snapshot.sql','utf8');
  const start=old.indexOf('create or replace function public.reschedule_appointment_atomic_business(');
  let body=old.slice(start,old.indexOf('$function$;',start));
  let core=migration.slice(migration.indexOf('create or replace function anaai_private.reschedule_appointment_core('),migration.indexOf('$function$;'));
  body=body.slice(body.indexOf("  if current_setting"));core=core.slice(core.indexOf("  if current_setting"));
  core=core.replace(/  if p_check_only then[\s\S]*?  end if;\n\n/,'').replace("v_capacity_result is distinct from 'AVAILABLE'","v_capacity_result <> 'AVAILABLE'");
  assert.equal(core,body);
});

// Receipt projections are evaluated from the migration's actual jsonb_build_object
// arguments, not a separately maintained receipt fixture. This is a source-contract
// test, not PostgreSQL execution. A poisoned v_row catches accidental failure reads.
const bridgeSql = sql.slice(sql.indexOf('create function public.voice_manage_appointment_business'));
const baseProjection = /v_receipt := jsonb_build_object\(([\s\S]*?)\);/.exec(bridgeSql)?.[1];
const successProjection = /v_receipt := v_receipt \|\| jsonb_build_object\(([\s\S]*?)\);/.exec(bridgeSql)?.[1];
function projectReceipt(argumentsSql, scope) {
  assert.ok(argumentsSql, 'receipt projection must exist');
  const args = argumentsSql.split(',').map(x => x.trim());
  assert.equal(args.length % 2, 0);
  const out = {};
  for (let i=0; i<args.length; i+=2) {
    assert.match(args[i], /^'[a-z_]+'$/);
    const expression=args[i+1];
    let value;
    if (/^'[^']*'$/.test(expression)) value=expression.slice(1,-1);
    else if (expression === 'false') value=false;
    else {
      assert.match(expression,/^[a-z_]+(?:\.[a-z_]+)?$/);
      value=expression.split('.').reduce((object,key)=>object[key],scope);
      assert.notEqual(value,undefined,`unresolved receipt expression ${expression}`);
    }
    out[args[i].slice(1,-1)]=value;
  }
  return out;
}
function projectedOutcome(action, success, changed, code) {
  const scope={v_success:success,v_changed:changed,v_code:code,
    v_action:{id:OTHER},p_action_type:action,p_business_id:B,p_appointment_id:A,
    v_customer:C,v_old:{service_id:S},
    v_row:success?{appointment_date:action==='cancel'?target.date:'2026-10-07',
      appointment_time:action==='cancel'?target.time:'15:00',status:action==='cancel'?'Cancelled':'Booked',duration_minutes:23}:
      new Proxy({}, {get(){throw Error('uninitialized appointment row read');}})};
  const result=projectReceipt(baseProjection,scope);
  if(success) Object.assign(result,projectReceipt(successProjection,scope));
  return result;
}
for(const code of ['SLOT_CONFLICT','TARGET_CHANGED','CLOSED','OUTSIDE_HOURS','INVALID_SCHEDULE','TERMINAL_APPOINTMENT']) {
  test(`controlled ${code} receipt omits unread state, preserves rejection and never authorizes success`,async()=>{
    const h=conversation('reschedule');await h.turn('move my appointment to October 7th at 3 PM');
    const rejected=projectedOutcome('reschedule',false,false,code);
    assert.equal(rejected.success,false);assert.equal(rejected.changed,false);assert.equal(rejected.code,code);
    for(const field of ['date','time','status','duration_minutes']) assert.equal(Object.hasOwn(rejected,field),false);
    h.rpc(async()=>({data:rejected,error:null}));
    const result=await h.management.manageVoiceAppointment(h.state,B,PHONE,false);
    assert.equal(result.verified,false);assert.equal(result.conflict,code==='SLOT_CONFLICT');
  });
}
test('cancellation controlled rejection has deterministic ledger metadata and no resulting state',async()=>{
  const h=conversation();await h.turn('cancel my appointment');
  for(const code of ['TARGET_CHANGED','INVALID_TRANSITION']) {
    const rejected=projectedOutcome('cancel',false,false,code);
    assert.deepEqual(rejected,{success:false,changed:false,code,action_id:OTHER,action_type:'cancel',
      business_id:B,appointment_id:A,customer_id:C,service_id:S,replayed:false,receipt_scope:'action_outcome'});
    h.rpc(async()=>({data:rejected,error:null}));assert.equal((await h.management.manageVoiceAppointment(h.state,B,PHONE,false)).verified,false);
  }
});
for(const action of ['cancel','reschedule']) test(`${action} successful SQL receipt projection satisfies application contract including replay`,async()=>{
  const h=conversation(action);await h.turn(action==='cancel'?'cancel my appointment':'move my appointment to October 7th at 3 PM');
  const result=projectedOutcome(action,true,true,'APPLIED');
  assert.equal(h.management.managementReceipt(result,h.state,B,false),true);
  assert.equal(h.management.managementReceipt({...result,replayed:true},h.state,B,false),true);
});
test('success and changed are independent in the receipt and ledger; lifecycle code is preserved',()=>{
  const result=projectedOutcome('cancel',true,false,'ALREADY_IN_TARGET_STATE');
  assert.equal(result.success,true);assert.equal(result.changed,false);assert.equal(result.code,'ALREADY_IN_TARGET_STATE');
  assert.match(bridgeSql,/v_success := \(v_result->>'success'\)::boolean/);
  assert.match(bridgeSql,/v_changed := \(v_result->>'changed'\)::boolean/);
  assert.match(bridgeSql,/v_code := v_result->>'code'/);
  assert.match(bridgeSql,/set success=v_success,changed=v_changed/);
  assert.doesNotMatch(bridgeSql,/success=v_changed|'success',v_changed/);
  assert.match(bridgeSql,/if v_changed and p_action_type='reschedule' then/);
});
test('fresh cancellation no-op is unreachable; parser remains conservative',async()=>{
  const h=conversation();await h.turn('cancel my appointment');
  assert.equal(h.management.managementReceipt(projectedOutcome('cancel',true,false,'ALREADY_IN_TARGET_STATE'),h.state,B,false),false);
  const guard=bridgeSql.indexOf("v_old.status not in ('Booked','Confirmed')");
  const call=bridgeSql.indexOf('v_result := anaai_private.appointment_lifecycle_core');
  const replay=bridgeSql.indexOf("return v_action.result || jsonb_build_object('replayed',true)");
  assert.ok(replay<guard && guard<call);
  assert.match(bridgeSql.slice(guard,call),/'TARGET_CHANGED'/);
});
test('failure finalization does not reference uninitialized v_row; success reread verifies all invariants',()=>{
  assert.doesNotMatch(baseProjection,/v_row/);
  const successfulBranch=bridgeSql.slice(bridgeSql.indexOf('  if v_success then\n    select * into v_row'),bridgeSql.indexOf("  if v_changed and p_action_type='reschedule' then"));
  assert.ok(successfulBranch.includes(successProjection));
  for(const field of ['id','business_id','customer_id','service_id','status','appointment_date','appointment_time','duration_minutes']) assert.ok(successfulBranch.includes(`v_row.${field}`),field);
  assert.match(successfulBranch,/v_row.status not in \('Booked','Confirmed'\)/);
  assert.match(successfulBranch,/v_row.duration_minutes is null or v_row.duration_minutes<=0/);
  const ledger=bridgeSql.slice(bridgeSql.indexOf('  update public.appointment_actions set success=v_success'));
  assert.match(ledger,/result=v_receipt,completed_at=clock_timestamp\(\)/);
  assert.match(ledger,/return v_receipt/);
  assert.ok(bridgeSql.indexOf('  end if;\n  update public.appointment_actions set success=v_success')>=0);
});
test('replayed controlled failure returns the stored outcome and remains a rejection',async()=>{
  const h=harness();let stored, firstRequest;
  h.rpc(async(name,args)=>{
    if(name==='voice_find_appointments_business')return {data:{success:true,business_id:B,customer_id:C,appointments:[target]},error:null};
    if(!stored) {firstRequest=args;stored=projectedOutcome('cancel',false,false,'TARGET_CHANGED');return {data:stored,error:null};}
    assert.equal(args.p_idempotency_key,firstRequest.p_idempotency_key);
    assert.equal(args.p_request_fingerprint,firstRequest.p_request_fingerprint);
    const replay={...stored,replayed:true};assert.deepEqual({...replay,replayed:false},stored);
    return {data:replay,error:null};
  });
  const token=stateToken(await h.run('cancel my appointment'));
  for(let i=0;i<2;i++) {const response=await h.run('yes',token);assert.match(response,/couldn&apos;t verify|couldn't verify/);assert.doesNotMatch(response,/has been cancelled|earlier appointment change succeeded/);}
  assert.match(bridgeSql,/return v_action.result \|\| jsonb_build_object\('replayed',true\)/);
});
test('check-only bypasses ledger claim and returns before receipt finalization, outbox and ledger completion',()=>{
  const claim=bridgeSql.slice(bridgeSql.indexOf('  if not p_check_only then'),bridgeSql.indexOf('  select appointment_date into v_source'));
  assert.match(claim,/insert into public.appointment_actions/);assert.match(claim,/\n  end if;\s*$/);
  const check=bridgeSql.indexOf('  if p_check_only then');
  const mapping=bridgeSql.indexOf('  v_success :=');
  assert.match(bridgeSql.slice(check,mapping),/return jsonb_build_object\('available'/);
  assert.ok(check<bridgeSql.indexOf('  update public.appointment_actions set success=v_success'));
  assert.equal((bridgeSql.match(/insert into public.appointment_actions/g)||[]).length,1);
});

async function recoveryConversation(stage) {
  const h = conversation(stage === 'cancel-confirm' ? 'cancel' : 'reschedule');
  if (stage === 'select') return h;
  await h.turn(stage === 'cancel-confirm' ? 'cancel my appointment' : 'reschedule my appointment', { opening: true });
  if (stage === 'reschedule-confirm') await h.turn('October 7th at 3 PM');
  if (stage === 'period') await h.turn('October 7th at 3');
  return h;
}
for (const stage of ['select', 'replacement', 'period', 'cancel-confirm', 'reschedule-confirm']) {
  for (const confidence of ['low', 'invalid']) test(`management ${stage}: ${confidence} recognition preserves state and is bounded`, async () => {
    const h = await recoveryConversation(stage);
    // Begin a fresh recovery episode after fixture setup.
    h.state.recovery = 0; h.state.silence = 0;
    const before = JSON.stringify(h.state.management), checks = h.checks.length;
    for (let n = 1; n <= 3; n++) {
      const result = await h.turn('yes', { confidence });
      assert.equal(result.done, n === 3);
      assert.equal(h.state.recovery, n);
      assert.equal(JSON.stringify(h.state.management), before);
    }
    assert.equal(h.checks.length, checks);
    assert.equal(h.commits.length, 0);
  });
  for (const confidence of ['low', 'invalid']) test(`management ${stage}: empty precedes ${confidence} and ends on second empty`, async () => {
    const h = await recoveryConversation(stage); h.state.recovery = 0; h.state.silence = 0;
    const before = JSON.stringify(h.state.management), checks = h.checks.length;
    const first = await h.turn(' \n\t ', { confidence });
    assert.equal(first.done, false);
    assert.equal(h.state.silence, 1);
    if (stage.endsWith('confirm')) assert.match(first.message, /Haircut.*Say yes or press 1/);
    if (stage === 'replacement') assert.match(first.message, /What day/);
    if (stage === 'period') assert.match(first.message, /AM or PM/);
    assert.equal((await h.turn('', { confidence })).done, true);
    assert.equal(JSON.stringify(h.state.management), before);
    assert.equal(h.checks.length, checks);
    assert.equal(h.commits.length, 0);
  });
  test(`management ${stage}: invalid digits and alternating input are bounded`, async () => {
    for (const inputs of [[{ digits: '9' }, { digits: '9' }, { digits: '9' }], [{}, { speech: '...' }, {}]]) {
      const h = await recoveryConversation(stage); h.state.recovery = 0; h.state.silence = 0;
      const before = JSON.stringify(h.state.management), checks = h.checks.length;
      for (const [index, input] of inputs.entries()) {
        const { speech = '', ...options } = input;
        assert.equal((await h.turn(speech, options)).done, index === 2);
      }
      assert.equal(JSON.stringify(h.state.management), before);
      assert.equal(h.checks.length, checks);
      assert.equal(h.commits.length, 0);
    }
  });
}
for (const stage of ['cancel-confirm', 'reschedule-confirm']) {
  for (const speech of ['no', 'yes', 'cancel my appointment', 'reschedule my appointment', 'actually October 9th at 6 PM']) {
    test(`management ${stage}: low-confidence control/correction ${speech} cannot change proposal`, async () => {
      const h = await recoveryConversation(stage); const before = JSON.stringify(h.state.management), checks = h.checks.length;
      const result = await h.turn(speech, { confidence: 'low' });
      assert.equal(result.done, false);
      assert.equal(JSON.stringify(h.state.management), before);
      assert.equal(h.checks.length, checks);
      assert.equal(h.commits.length, 0);
      assert.match(result.message, /Haircut.*Say yes or press 1/);
    });
  }
  test(`management ${stage}: mixed input rejected; missing-confidence speech confirms re-presented proposal`, async () => {
    const h = await recoveryConversation(stage); const before = JSON.stringify(h.state.management);
    const result = await h.turn('yes', { digits: '1', confidence: 'high' });
    assert.match(result.message, /Haircut.*Say yes or press 1/);
    assert.equal(JSON.stringify(h.state.management), before);
    assert.equal(h.commits.length, 0);
    assert.equal((await h.turn('yes', { confidence: 'missing' })).done, true);
    assert.equal(h.commits.length, 1);
  });
}
test('management repeated ambiguous time is bounded and does not repeat availability checks', async () => {
  const h = await recoveryConversation('replacement');
  for (let n = 1; n <= 3; n++) assert.equal((await h.turn('October 7th at 3')).done, n === 3);
  assert.equal(h.checks.length, 0);
  assert.equal(h.commits.length, 0);
});
test('management repeated ambiguous target is bounded without selecting one', async () => {
  const h = conversation('cancel', [target, { ...target, id: OTHER, time: '15:00' }]);
  for (let n = 1; n <= 3; n++) assert.equal((await h.turn('cancel my appointment', { opening: n === 1 })).done, n === 3);
  assert.equal(h.state.management.target, null);
  assert.equal(h.commits.length, 0);
});
test('unrelated replacement speech preserves verified schedule and avoids availability', async () => {
  const h = await recoveryConversation('reschedule-confirm');
  const before = JSON.stringify(h.state.management), checks = h.checks.length;
  for (let n = 1; n <= 3; n++) assert.equal((await h.turn('the television is loud')).done, n === 3);
  assert.equal(JSON.stringify(h.state.management), before);
  assert.equal(h.checks.length, checks);
  assert.equal(h.commits.length, 0);
});
test('management repeated unavailable replacements consume recovery despite new candidate extraction', async () => {
  const h = await recoveryConversation('replacement'); h.outcome({ verified: false, conflict: true });
  for (let n = 1; n <= 3; n++) assert.equal((await h.turn('October 7th at 3 PM')).done, n === 3);
  assert.equal(h.commits.length, 0);
});
for (const action of ['cancel', 'reschedule']) test(`actual handler ${action}: rejected callbacks preserve sealed proposal and Gather settings`, async () => {
  const h = harness(); const s = h.fresh(action);
  Object.assign(s.management, { target: { ...target }, stage: 'confirm',
    date: action === 'reschedule' ? '2026-10-07' : null,
    time: action === 'reschedule' ? '15:00' : null, verified: action === 'reschedule' });
  s.turns = 7;
  const before = JSON.stringify(s.management);
  let token = h.state.sealVoiceState(s, h.binding);
  for (const [index, confidence] of ['0.01', 'NaN', '2'].entries()) {
    const xml = await h.run('yes', token, '', confidence);
    if (index === 2) { assert.match(xml, /<Hangup/); break; }
    assert.equal((xml.match(/<Gather\b/g) || []).length, 1);
    assert.doesNotMatch(xml, /<Redirect|bargeIn=/);
    for (const attr of ['timeout="6"', 'speechTimeout="2"', 'input="speech dtmf"', 'numDigits="1"', 'method="POST"', 'actionOnEmptyResult="true"']) assert.ok(xml.includes(attr));
    const url = new URL(/action="([^"]+)"/.exec(xml)[1].replaceAll('&amp;', '&'));
    assert.equal(url.pathname, '/api/voice');
    assert.equal(url.searchParams.get('mode'), 'listen');
    token = url.searchParams.get('state');
    const next = h.state.openVoiceState(token, h.binding);
    assert.equal(next.turns, 8 + index);
    assert.equal(JSON.stringify(next.management), before);
  }
  assert.equal(h.calls.length, 0);
  const events = h.logs.filter(x => x[0] === 'AnaAI voice turn');
  assert.equal(events.length, 3);
  assert.equal(events[2][1].outcome, 'hangup');
});
test('menu to management retains total call turns and lifetime', async () => {
  const h = harness(); const s = h.state.initialVoiceState(); s.turns = 27; s.expires -= 60000;
  h.rpc(async () => ({ data: { success: true, business_id: B, customer_id: C, appointments: [target] }, error: null }));
  const xml = await h.run('cancel my appointment', h.state.sealVoiceState(s, h.binding));
  const token = new URL(/action="([^"]+)"/.exec(xml)[1].replaceAll('&amp;', '&')).searchParams.get('state');
  const next = h.state.openVoiceState(token, h.binding);
  assert.equal(next.turns, 28); assert.equal(next.expires, s.expires); assert.equal(next.mode, 'management');
});
