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

const composerPath = path.join(
  process.cwd(),
  "components",
  "appointments",
  "AppointmentComposer.tsx"
);

const source = fs.readFileSync(
  dashboardPath,
  "utf8"
);

const composerSource = fs.readFileSync(
  composerPath,
  "utf8"
);

const compact = source
  .replace(/\s+/g, " ")
  .trim();

const compactComposer = composerSource
  .replace(/\s+/g, " ")
  .trim();

test("dashboard resolves the active business before loading operational data", () => {
  assert.match(
    compact,
    /fetch\("\/api\/current-business"/
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
    /const businessTimezone = context\.business\.timezone/
  );

  assert.match(
    compact,
    /todayInTimezone\(businessTimezone\)/
  );

  assert.doesNotMatch(
    compact,
    /toISOString\(\)\.split\("T"\)/
  );
});

test("dashboard schedule navigation shifts calendar days without mutating data", () => {
  assert.match(
    compact,
    /shiftDateKey\(current, -1\)/
  );

  assert.match(
    compact,
    /shiftDateKey\(current, 1\)/
  );

  assert.match(
    compact,
    /aria-label="Previous day"/
  );

  assert.match(
    compact,
    /aria-label="Next day"/
  );

  /* Today returns to the business date, never a browser-local date. */
  assert.match(
    compact,
    /function goToToday\(\) \{ if \(today\) \{ setSelectedDate\(today\); \} \}/
  );
});

test("dashboard appointment schedule is business and selected-date scoped", () => {
  assert.match(
    compact,
    /\.from\("appointments"\)[\s\S]*?\.eq\("business_id", businessId\)[\s\S]*?\.eq\("appointment_date", selectedDate\)/
  );

  assert.match(
    compact,
    /\.order\("appointment_time", \{ ascending: true \}\)/
  );
});

test("dashboard counts only active customers and services", () => {
  assert.match(
    compact,
    /\.from\("customers"\)[\s\S]*?\.eq\("business_id", businessId\)[\s\S]*?\.eq\("is_active", true\)/
  );

  assert.match(
    compact,
    /\.from\("services"\)[\s\S]*?\.eq\("business_id", businessId\)[\s\S]*?\.eq\("is_active", true\)/
  );

  assert.match(
    compact,
    /label="Active customers"/
  );

  assert.match(
    compact,
    /Active services/
  );
});

test("dashboard upcoming metric is derived from real appointment rows", () => {
  assert.match(
    compact,
    /\.gte\("appointment_date", upcomingStart\)[\s\S]*?\.lte\("appointment_date", upcomingEnd\)[\s\S]*?\.in\("status", \["Booked", "Confirmed"\]\)/
  );

  assert.match(
    compact,
    /label="Upcoming"/
  );
});

test("dashboard AI configuration is business scoped and does not claim runtime online status", () => {
  assert.match(
    compact,
    /\.from\("ai_settings"\)[\s\S]*?\.eq\("business_id", businessId\)[\s\S]*?\.maybeSingle\(\)/
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
    /Taking calls/i
  );

  assert.doesNotMatch(
    compact,
    /calls answered/i
  );

  assert.doesNotMatch(
    compact,
    /conversion rate/i
  );

  assert.doesNotMatch(
    compact,
    /revenue/i
  );
});

test("dashboard uses only real appointment statuses in the day summary", () => {
  assert.match(
    compact,
    /const counts = \{ Booked: 0, Confirmed: 0, Completed: 0, Cancelled: 0, \}/
  );

  for (const status of [
    "Booked",
    "Confirmed",
    "Completed",
    "Cancelled",
  ]) {
    assert.match(
      compact,
      new RegExp(`case "${status}": counts\\.${status} \\+= 1;`)
    );
  }

  assert.match(
    compact,
    /statusCounts\[status\]/
  );

  /* No invented status vocabulary. */
  assert.doesNotMatch(
    compact,
    /"(No show|No-show|Pending|Rescheduled|Waitlisted)"/
  );
});

test("dashboard booking reuses the shared composer instead of a second scheduling path", () => {
  assert.match(
    compact,
    /import AppointmentComposer/
  );

  assert.match(
    compact,
    /<AppointmentComposer/
  );

  /* Creation goes through the authoritative API, never a direct table write. */
  assert.doesNotMatch(
    compact,
    /\.from\("appointments"\)[\s\S]{0,200}\.insert\(/
  );

  assert.doesNotMatch(
    compact,
    /\.rpc\(/
  );
});

test("the shared composer keeps scheduling authority on the server", () => {
  assert.match(
    compactComposer,
    /onSubmit\(\{ creating: true, notificationType: "none", updates:/
  );

  /* No client-side hours, duration, capacity or conflict decisions. */
  assert.doesNotMatch(
    compactComposer,
    /appointment_capacity|business_hours|duration_minutes \*|overlap/i
  );

  assert.doesNotMatch(
    compactComposer,
    /\.from\("appointments"\)/
  );

  assert.doesNotMatch(
    compactComposer,
    /\.rpc\(/
  );
});
