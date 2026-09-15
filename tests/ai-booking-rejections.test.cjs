// SQL contract checks only; no PostgreSQL or production calls.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const old=fs.readFileSync('supabase/migrations/202609150003_appointment_action_foundation.sql','utf8');
const sql=fs.readFileSync('supabase/migrations/202609150004_classify_ai_booking_rejections.sql','utf8');
const expected=[
 ['Authentication is required.','UNAUTHORIZED'],
 ['Business context is required.','INVALID_REQUEST'],
 ['You do not have access to this business.','FORBIDDEN'],
 ['Customer name is required.','INVALID_CUSTOMER'],
 ['Customer phone number is required.','INVALID_CUSTOMER'],
 ['Service is required.','INVALID_SERVICE'],
 ['Appointment date is required.','INVALID_SCHEDULE'],
 ['Appointment time is required.','INVALID_SCHEDULE'],
 ['The selected service could not be found.','INVALID_SERVICE'],
 ['The selected service does not have a valid duration.','INVALID_DURATION'],
 ['Business hours have not been configured.','INVALID_HOURS'],
 ['Business hours are not stored in a valid format.','INVALID_HOURS'],
 ['Business hours are not configured for that day.','INVALID_HOURS'],
 ['The business is closed on that day.','CLOSED'],
 ['Business hours for that day are invalid.','INVALID_HOURS'],
 ['The requested appointment starts before opening time.','OUTSIDE_HOURS'],
 ['The requested appointment would finish after closing time.','OUTSIDE_HOURS'],
 ['An existing appointment does not have a valid service duration, so availability cannot be checked safely.','INVALID_EXISTING_SCHEDULE'],
 ['That time overlaps an existing appointment.','SLOT_CONFLICT'],
];
const mapping=sql.slice(sql.indexOf('v_rejection_code := case'),sql.indexOf('if v_rejection_code is null'));
const found=Array.from(mapping.matchAll(/when '([^']+)' then '([^']+)'/g),m=>[m[1],m[2]]);
for(const [reason,code] of expected)test(`exact legacy mapping: ${code} — ${reason}`,()=>assert.deepEqual(found.find(pair=>pair[0]===reason),[reason,code]));
test('allowlist has no extra or fuzzy mappings',()=>{assert.deepEqual(found,expected);assert.match(mapping,/case v_result ->> 'reason'/);assert.doesNotMatch(mapping,/trim|lower|like|regexp/i);assert.match(mapping,/else null/);});
test('forward migration replaces only scheduler, preserves deployed source and public grants',()=>{
 assert.equal((sql.match(/create or replace function /g)||[]).length,1);
 assert.match(sql,/create or replace function public.schedule_appointment_idempotent_business/);
 assert.doesNotMatch(sql,/create table|create policy|alter table|create trigger/);
 assert.match(old,/if p_operation='ai_book' then raise exception 'ai booking rejected'/);
 assert.match(sql,/revoke all on function public.schedule_appointment_idempotent_business\(uuid,uuid,text,text,jsonb\) from public,anon/);
});
function section(text,start,end){return text.slice(text.indexOf(start),text.indexOf(end,text.indexOf(start)));}
test('success re-read, mutation delegation, manual/reschedule semantics and key binding unchanged',()=>{
 for(const [start,end] of [
 ['  if p_operation = \'reschedule\' then','  if v_result -> \'success\''],
 ["  if v_result -> 'success' = 'true'::jsonb then",'  else\n    -- Unknown/legacy'],
 ['  insert into public.appointment_actions\n    (business_id,actor_user_id',"  if p_operation = 'reschedule' then"],
 ["when v_result ->> 'code' in",'  end if;\n  v_receipt :='],
 ['  v_receipt := v_receipt ||','commit;']
 ]){
 let before=section(old,start,end),after=section(sql,start,end);
 // The old file continues with notification functions; compare only the scheduler tail.
 if(start==='  v_receipt := v_receipt ||'){before=before.slice(0,before.indexOf('-- Mark uncertain BEFORE'));}
 assert.equal(after.trim(),before.trim());
 }
});
test('recognized rejection completes ledger, no notification, replay precedes legacy call',()=>{
 assert.match(sql,/case when p_operation = 'ai_book' then v_rejection_code/);
 assert.match(sql,/v_changed := false;\s+v_receipt := jsonb_build_object\('success',false,'changed',false,'code'/);
 assert.match(sql,/if v_changed and v_notify then\s+insert into public.appointment_notifications/);
 assert.match(sql,/result=v_receipt,completed_at=/);
 assert.ok(sql.indexOf("return v_action.result || jsonb_build_object('replayed',true)")<sql.indexOf('v_result := public.book_appointment_atomic_business'));
 assert.doesNotMatch(sql.slice(sql.indexOf('v_changed := false;',sql.indexOf('-- Unknown/legacy')),sql.indexOf('exception when others then\n  raise log')),/jsonb_build_object\([^;]*'reason'/);
});
test('unknown/malformed failures throw into rollback handler, never complete a false terminal record',()=>{
 assert.match(sql,/v_result -> 'success' is distinct from 'false'::jsonb/);
 assert.match(sql,/jsonb_typeof\(v_result\) is distinct from 'object'/);
 assert.match(sql,/jsonb_typeof\(v_result -> 'reason'\) is distinct from 'string'/);
 assert.match(sql,/\(v_result - 'success' - 'reason'\) <> '\{\}'::jsonb/);
 assert.match(sql,/if v_rejection_code is null then raise exception 'unknown legacy rejection'/);
 assert.match(sql,/exception when others then\s+raise log[^;]+;\s+return jsonb_build_object\('success',false,'code','INTERNAL_ERROR'\)/);
});
