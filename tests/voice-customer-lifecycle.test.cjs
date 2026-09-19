const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const migrationPath = path.join(
  process.cwd(),
  "supabase",
  "migrations",
  "202609190003_voice_customer_lifecycle.sql"
);

const sql = fs.readFileSync(migrationPath, "utf8");

function compact(value) {
  return value.replace(/\s+/g, " ").trim();
}

const normalizedSql = compact(sql);

test("voice customer lifecycle migration replaces only the booking RPC", () => {
  assert.match(
    normalizedSql,
    /create or replace function public\.voice_book_appointment_business\s*\(/
  );

  assert.doesNotMatch(
    normalizedSql,
    /create or replace function public\.voice_claim_appointment_notification\s*\(/
  );

  assert.doesNotMatch(
    normalizedSql,
    /create or replace function public\.voice_finish_appointment_notification\s*\(/
  );

  assert.match(
    normalizedSql,
    /security definer set search_path = pg_catalog, public/
  );

  assert.match(
    normalizedSql,
    /revoke all on function public\.voice_book_appointment_business\s*\([^;]+?\) from public, anon, authenticated;/
  );

  assert.match(
    normalizedSql,
    /grant execute on function public\.voice_book_appointment_business\s*\([^;]+?\) to service_role;/
  );
});

test("voice customer lookup remains tenant and phone scoped", () => {
  assert.match(
    normalizedSql,
    /from public\.customers c where c\.business_id = p_business_id and c\.phone = btrim\(p_customer_phone\) order by c\.is_active desc, c\.created_at asc limit 1;/
  );
});

test("voice booking prefers active duplicate identity before archived identity", () => {
  assert.match(
    normalizedSql,
    /order by c\.is_active desc, c\.created_at asc limit 1;/
  );
});

test("new voice customer is explicitly active", () => {
  assert.match(
    normalizedSql,
    /insert into public\.customers\s*\(\s*business_id,\s*user_id,\s*full_name,\s*phone,\s*email,\s*notes,\s*is_active\s*\)/
  );

  assert.match(
    normalizedSql,
    /'Created by AnaAI phone booking',\s*true\s*\)/
  );
});

test("returning archived voice customer is reactivated and reused", () => {
  assert.match(
    normalizedSql,
    /update public\.customers set full_name = btrim\(p_customer_name\), email = v_email, is_active = true where id = v_customer_id and business_id = p_business_id;/
  );

  assert.match(
    normalizedSql,
    /insert into public\.appointments\s*\([^)]*customer_id[^)]*\)[\s\S]*?values\s*\([^;]*v_customer_id/
  );
});

test("voice lifecycle migration preserves durable booking safeguards", () => {
  assert.match(
    normalizedSql,
    /on conflict \(business_id, idempotency_key\) do nothing/
  );

  assert.match(
    normalizedSql,
    /pg_advisory_xact_lock\s*\(\s*hashtext\(p_business_id::text \|\| ':' \|\| p_appointment_date::text\)\s*\)/
  );

  assert.match(
    normalizedSql,
    /and s\.is_active = true/
  );

  assert.match(
    normalizedSql,
    /and a\.status in \('Booked', 'Confirmed'\)/
  );

  assert.match(
    normalizedSql,
    /v_appointment\.customer_id is distinct from v_customer_id/
  );
});