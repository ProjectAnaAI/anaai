const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const migration = fs.readFileSync('supabase/migrations/202609280001_authenticated_reschedule_check.sql','utf8');
const body = migration.split('as $function$')[1].split('$function$')[0];
const core = fs.readFileSync('supabase/migrations/202609210008_voice_appointment_management.sql','utf8').split('create or replace function anaai_private.reschedule_appointment_core')[1].split('$function$;')[0];
test('check wrapper is authenticated SECURITY INVOKER with pinned search path and explicit member guard', () => {
  assert.match(migration,/volatile security invoker/i); assert.match(migration,/set search_path = pg_catalog, public/);
  assert.match(body,/auth.uid\(\) is null/); assert.match(body,/public.is_business_member\(p_business_id\)/);
  assert.match(migration,/from public, anon, service_role/); assert.match(migration,/to authenticated/);
});
test('wrapper has a fixed check-only delegation and no scheduling/write/phone path', () => {
  assert.match(body,/return anaai_private.reschedule_appointment_core\(\s*p_business_id, p_appointment_id, p_customer_id, p_service_id,\s*p_appointment_date, p_appointment_time, null, true\s*\)/);
  const statements = body.replace(/--[^\n]*/g,'');
  assert.doesNotMatch(statements,/\b(insert|update|delete|phone|voice_|capacity|hours)\b/i);
  assert.equal((statements.match(/reschedule_appointment_core/g)||[]).length,1);
});
test('existing core scopes appointment, customer and active service and excludes only target', () => {
  assert.match(core,/where id = p_appointment_id\s+and business_id = p_business_id/);
  assert.match(core,/where id = p_customer_id\s+and business_id = p_business_id/);
  assert.match(core,/where id = p_service_id\s+and business_id = p_business_id\s+and is_active = true/);
  assert.match(core,/check_appointment_capacity_business\(\s*p_business_id,\s*p_appointment_date,\s*p_appointment_time,\s*v_service.duration_minutes,\s*p_appointment_id/);
});
test('core check returns before mutation and has no phone requirement', () => {
  const check = core.indexOf('if p_check_only then'); const write = core.indexOf('update public.appointments');
  assert.ok(check>0 && write>check); assert.match(core.slice(check,write),/'AVAILABLE'/); assert.doesNotMatch(core.slice(0,check),/\.phone|voice_customer/);
});
test('existing actual reschedule still delegates false; new booking still excludes nothing', () => {
  const file = fs.readFileSync('supabase/migrations/202609210008_voice_appointment_management.sql','utf8');
  const actual = file.split('create or replace function public.reschedule_appointment_atomic_business')[1].split('$function$;')[0];
  assert.match(actual,/p_notes, false/);
  const voice = fs.readFileSync('supabase/migrations/202609210004_voice_capacity_availability.sql','utf8');
  assert.match(voice,/v_duration_minutes,\s*null\s*\)/); assert.match(voice,/to service_role/);
});
