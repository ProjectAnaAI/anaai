const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const dashboardPath = path.join(
  process.cwd(),
  "app",
  "dashboard",
  "page.tsx"
);

const source = fs.readFileSync(
  dashboardPath,
  "utf8"
);

const compact = source
  .replace(/\s+/g, " ")
  .trim();

test("dashboard resolves the active business before loading operational data", () => {
  assert.match(
    compact,
    /fetch\( "\/api\/current-business"/
  );

  assert.match(
    compact,
    /activeBusinessHeaders\(\)/
  );

  assert.match(
    compact,
    /const businessId = context\.business\.id/
  );
});

test("dashboard derives today from the business timezone", () => {
  assert.match(
    compact,
    /timeZone: timezone/
  );

  assert.match(
    compact,
    /const businessTimezone = context\.business\.timezone/
  );

  assert.match(
    compact,
    /businessDate\( businessTimezone \)/
  );

  assert.doesNotMatch(
    compact,
    /toISOString\(\)\.split\("T"\)/
  );
});

test("dashboard appointment schedule is business and date scoped", () => {
  assert.match(
    compact,
    /\.from\("appointments"\) \.select\( "id, customer_name, service, appointment_time, status" \) \.eq\( "business_id", businessId \) \.eq\( "appointment_date", currentBusinessDate \)/
  );

  assert.match(
    compact,
    /\.order\( "appointment_time", \{ ascending: true, \} \)/
  );
});

test("dashboard counts only active customers and services", () => {
  assert.match(
    compact,
    /\.from\("customers"\)[\s\S]*?\.eq\( "business_id", businessId \)[\s\S]*?\.eq\( "is_active", true \)/
  );

  assert.match(
    compact,
    /\.from\("services"\)[\s\S]*?\.eq\( "business_id", businessId \)[\s\S]*?\.eq\( "is_active", true \)/
  );

  assert.match(
    compact,
    /title="Active customers"/
  );

  assert.match(
    compact,
    /title="Active services"/
  );
});

test("dashboard AI configuration is business scoped and does not claim runtime online status", () => {
  assert.match(
    compact,
    /\.from\("ai_settings"\) \.select\( "receptionist_name, greeting, tone" \) \.eq\( "business_id", businessId \) \.maybeSingle\(\)/
  );

  assert.match(
    compact,
    /"Configured"/
  );

  assert.match(
    compact,
    /"Needs setup"/
  );

  assert.doesNotMatch(
    compact,
    /value="Online"/
  );

  assert.doesNotMatch(
    compact,
    /AI status/
  );
});

test("dashboard provides schedule and status breakdown from today's appointments", () => {
  assert.match(
    compact,
    /Today&apos;s schedule/
  );

  assert.match(
    compact,
    /Today&apos;s breakdown/
  );

  assert.match(
    compact,
    /statusCounts\.Booked/
  );

  assert.match(
    compact,
    /statusCounts\.Confirmed/
  );

  assert.match(
    compact,
    /statusCounts\.Completed/
  );

  assert.match(
    compact,
    /statusCounts\.Cancelled/
  );
});