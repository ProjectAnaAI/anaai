// Static migration contracts only: these do not execute PostgreSQL or prove RLS/concurrency.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const sql=fs.readFileSync('supabase/migrations/202609150003_appointment_action_foundation.sql','utf8');
test('business/key uniqueness and exact action/fingerprint/target binding',()=>{
 assert.match(sql,/unique \(business_id, idempotency_key\)/);
 for(const field of ['action_type','request_fingerprint','appointment_id'])assert.match(sql,new RegExp(`v_action.${field} is distinct from p_${field}`));
 assert.match(sql,/IDEMPOTENCY_CONFLICT/);
});
test('concurrent claim precedes mutation; replay returns original persisted receipt',()=>{
 const claim=sql.indexOf('insert into public.appointment_actions');
 const replay=sql.indexOf("return v_action.result || jsonb_build_object('replayed',true)");
 const mutation=sql.indexOf('update public.appointments set');
 assert.ok(claim<replay&&replay<mutation);
 assert.match(sql,/on conflict \(business_id,idempotency_key\) do nothing/);
 assert.match(sql,/current_setting\('transaction_isolation'\) <> 'read committed'/);
 assert.match(sql,/v_action.completed_at is null/);
});
test('transition allowlist rejects NULL, unknown, Completed and terminal confirmation',()=>{
 assert.match(sql,/p_action_type = 'confirm' and v_previous_status = 'Booked'/);
 assert.match(sql,/p_action_type = 'cancel' and v_previous_status in \('Booked','Confirmed'\)/);
 assert.match(sql,/else\s+v_code := 'INVALID_TRANSITION'/);
 assert.doesNotMatch(sql,/set status = 'Completed'|set status = 'Booked'/);
});
test('already target state is successful no-op without notification',()=>{
 assert.match(sql,/v_changed boolean := false/);
 assert.match(sql,/if v_previous_status = v_target_status then\s+v_success := true;\s+v_code := 'ALREADY_IN_TARGET_STATE';/);
 assert.match(sql,/if v_changed then\s+insert into public.appointment_notifications/);
 assert.match(sql,/unique \(appointment_action_id, channel, notification_kind\)/);
});
test('row lock follows date lock and source date is revalidated',()=>{
 const lock=sql.indexOf('perform pg_advisory_xact_lock');
 const row=sql.indexOf('select * into v_appointment');
 assert.ok(lock<row);
 assert.match(sql,/hashtext\(p_business_id::text \|\| ':' \|\| v_source_date::text\)/);
 assert.match(sql,/v_appointment.appointment_date is distinct from v_source_date/);
 assert.match(sql,/where id = p_appointment_id and business_id = p_business_id for update/);
});
test('authentication, membership and tenant-bound update precede successful receipt',()=>{
 assert.match(sql,/v_user_id uuid := auth.uid\(\)/);
 assert.match(sql,/public.is_business_member\(p_business_id\)/);
 assert.match(sql,/where id = p_appointment_id and business_id = p_business_id\s+returning \* into v_appointment/);
 assert.match(sql,/if not found then raise exception 'missing updated appointment'/);
 assert.match(sql,/result = v_receipt, completed_at/);
 assert.match(sql,/exception when others then[\s\S]*'INTERNAL_ERROR'/);
});
test('clients cannot forge ledger/outbox and private executor cannot be called',()=>{
 assert.match(sql,/revoke all on public.appointment_actions, public.appointment_notifications from public, anon, authenticated/);
 assert.match(sql,/grant select on public.appointment_actions to authenticated/);
 assert.match(sql,/grant select \(id,business_id,[\s\S]*?on public.appointment_notifications to authenticated/);
 assert.doesNotMatch(sql,/grant select \([^;]*claim_token/);
 assert.match(sql,/_appointment_lifecycle_action\(uuid,uuid,uuid,text,text\) from public, anon, authenticated/);
 for(const table of ['appointment_actions','appointment_notifications'])assert.match(sql,new RegExp(`alter table public.${table} enable row level security`));
 for(const action of ['confirm','cancel']){
 assert.match(sql,new RegExp(`revoke all on function public.${action}_appointment_atomic_business\\(uuid,uuid,uuid,text\\) from public, anon`));
 assert.match(sql,new RegExp(`grant execute on function public.${action}_appointment_atomic_business\\(uuid,uuid,uuid,text\\) to authenticated`));
 }
 assert.ok((sql.match(/set search_path\s*=\s*pg_catalog,\s*public/g)||[]).length>=6);
});
test('notification business cannot differ from action; actor deletion preserves history',()=>{
 assert.match(sql,/foreign key \(appointment_action_id, business_id\)/);
 assert.match(sql,/references auth.users\(id\) on delete set null/);
 assert.match(sql,/channel = 'sms'/);
 assert.match(sql,/status in \('pending','accepted','failed','uncertain'\)/);
});
test('no version, existing RPC replacement, provider calls or service role dependency',()=>{
 assert.doesNotMatch(sql,/add.*version|service_role|http_post|net\.http|create or replace/i);
 assert.doesNotMatch(sql,/create function public\.(book|create|reschedule)_appointment/);
 assert.doesNotMatch(sql,/SQLERRM/);
});

test('notification history blocks action deletion without cascading',()=>{
 assert.match(sql,/foreign key \(appointment_action_id, business_id\)\s+references public.appointment_actions\(id, business_id\) on delete no action/);
 assert.doesNotMatch(sql,/references public.appointment_actions\(id, business_id\) on delete cascade/);
});
test('unfinished claim and completed receipt have distinct constrained states',()=>{
 assert.match(sql,/result jsonb,/);
 assert.doesNotMatch(sql,/result jsonb not null|result jsonb default/);
 assert.match(sql,/completed_at is null and not success and not changed and result is null/);
 assert.match(sql,/completed_at is not null and result is not null\s+and jsonb_typeof\(result\) = 'object' and result <> '\{\}'::jsonb/);
 assert.match(sql,/check \(not changed or success\)/);
 // The existing completion update changes every constrained field together.
 assert.match(sql,/set success = v_success, changed = v_changed,\s+result = v_receipt, completed_at =/);
});
test('unexpected error handler cannot persist a terminal internal failure',()=>{
 const handler=sql.slice(sql.indexOf('exception when others then'),sql.indexOf('$function$;',sql.indexOf('exception when others then')));
 assert.match(handler,/'INTERNAL_ERROR'/);
 assert.doesNotMatch(handler,/insert into|update public/);
});

test('idempotent scheduling delegates proven RPCs and binds typed structured intent',()=>{
 assert.match(sql,/v_action.request_payload is distinct from v_request/);
 for(const name of ['book','create','reschedule'])assert.match(sql,new RegExp(`public.${name}_appointment_atomic_business\\(`));
 assert.match(sql,/select distinct d from \(values\(v_source\),\(v_date\)\) dates\(d\) order by d/);
 assert.match(sql,/v_old.appointment_date is distinct from v_source/);
 assert.match(sql,/v_old.status not in \('Booked','Confirmed'\)/);
 assert.match(sql,/if not found then raise exception 'missing authoritative appointment'/);
});
test('notification is marked uncertain before provider handoff and cannot be reclaimed',()=>{
 assert.match(sql,/set status='uncertain',claim_token=gen_random_uuid\(\)/);
 assert.match(sql,/appointment_action_id=p_action_id and status='pending'/);
 assert.match(sql,/claim_token=p_claim_token and status='uncertain'/);
 assert.match(sql,/claim_token=null,updated_at/);
 assert.doesNotMatch(sql,/set status='pending'/);
});
