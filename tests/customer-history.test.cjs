const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const pagePath = path.join(
  process.cwd(),
  "app",
  "customers",
  "page.tsx"
);

const source = fs.readFileSync(
  pagePath,
  "utf8"
);

const compact = source
  .replace(/\s+/g, " ")
  .trim();

test("customer CRM defaults to active records and supports archived and all filters", () => {
  assert.match(
    compact,
    /useState<CustomerFilter>\( "active" \)/
  );

  assert.match(
    compact,
    /customerFilter === "active"/
  );

  assert.match(
    compact,
    /customerFilter === "archived"/
  );

  assert.match(
    compact,
    /customerFilter === "all"/
  );
});

test("customer CRM search covers name phone and email", () => {
  assert.match(
    compact,
    /customer\.full_name, customer\.phone \|\| "", customer\.email \|\| ""/
  );

  assert.match(
    compact,
    /Search name, phone, or email/
  );
});

test("customer history query is business scoped and preserves appointment snapshots", () => {
  assert.match(
    compact,
    /\.from\("appointments"\) \.select\( "id, customer_id, service, appointment_date, appointment_time, status, notes" \) \.eq\( "business_id", activeBusinessId \)/
  );

  assert.doesNotMatch(
    compact,
    /\.from\("appointments"\)[\s\S]{0,500}\.delete\(/
  );

  assert.doesNotMatch(
    compact,
    /\.from\("appointments"\)[\s\S]{0,500}\.update\(/
  );
});

test("customer appointment history is linked by customer id and newest first", () => {
  assert.match(
    compact,
    /if \( !appointment\.customer_id \)/
  );

  assert.match(
    compact,
    /map\.get\( appointment\.customer_id \)/
  );

  assert.match(
    compact,
    /compareAppointmentsNewestFirst/
  );

  assert.match(
    compact,
    /return secondKey\.localeCompare\( firstKey \)/
  );
});

test("customer CRM exposes appointment count recent appointment and history", () => {
  assert.match(
    compact,
    /history\.length/
  );

  assert.match(
    compact,
    /const mostRecent = history\[0\]/
  );

  assert.match(
    compact,
    /toggleHistory/
  );

  assert.match(
    compact,
    /Appointment history/
  );
});

test("archived customer lifecycle remains reversible without hard delete", () => {
  assert.match(
    compact,
    /is_active: nextActive/
  );

  assert.match(
    compact,
    /Customer reactivated\./
  );

  assert.match(
    compact,
    /Customer archived\. Appointment history was preserved\./
  );

  assert.doesNotMatch(
    compact,
    /\.from\("customers"\)[\s\S]{0,500}\.delete\(/
  );
});