const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const analyticsPagePath =
  path.join(
    process.cwd(),
    "app",
    "analytics",
    "page.tsx"
  );

const analyticsHelperPath =
  path.join(
    process.cwd(),
    "lib",
    "analytics.ts"
  );

const pageSource =
  fs.readFileSync(
    analyticsPagePath,
    "utf8"
  );

const helperSource =
  fs.readFileSync(
    analyticsHelperPath,
    "utf8"
  );

const compactPage =
  pageSource
    .replace(/\s+/g, " ")
    .trim();

const compactHelper =
  helperSource
    .replace(/\s+/g, " ")
    .trim();

test("analytics resolves active business before reporting queries", () => {
  assert.match(
    compactPage,
    /fetch\( "\/api\/current-business"/
  );

  assert.match(
    compactPage,
    /activeBusinessHeaders\(\)/
  );

  assert.match(
    compactPage,
    /const businessId = context\.business\.id/
  );
});

test("analytics reporting window uses the business timezone and exactly 30 dates", () => {
  assert.match(
    compactPage,
    /reportingWindow\( context\.business\.timezone, 30 \)/
  );

  assert.match(
    compactHelper,
    /timeZone: timezone/
  );

  assert.match(
    compactHelper,
    /start\.setUTCDate\( start\.getUTCDate\(\) - \(days - 1\) \)/
  );
});

test("analytics appointment period query is tenant and date scoped", () => {
  assert.match(
    compactPage,
    /\.from\("appointments"\) \.select\( "id, service, appointment_date, status" \) \.eq\( "business_id", businessId \) \.gte\( "appointment_date", window\.startDate \) \.lte\( "appointment_date", window\.endDate \)/
  );
});

test("analytics operational counts use active customers and services", () => {
  assert.match(
    compactPage,
    /\.from\("customers"\)[\s\S]*?\.eq\( "business_id", businessId \)[\s\S]*?\.eq\( "is_active", true \)/
  );

  assert.match(
    compactPage,
    /\.from\("services"\)[\s\S]*?\.eq\( "business_id", businessId \)[\s\S]*?\.eq\( "is_active", true \)/
  );

  assert.match(
    compactPage,
    /title="Active customers"/
  );

  assert.match(
    compactPage,
    /title="Active services"/
  );
});

test("analytics status calculations include booking lifecycle states", () => {
  for (const status of [
    "Booked",
    "Confirmed",
    "Completed",
    "Cancelled",
  ]) {
    assert.match(
      compactHelper,
      new RegExp(
        `case "${status}"`
      )
    );
  }

  assert.match(
    compactPage,
    /statusCounts\.Booked/
  );

  assert.match(
    compactPage,
    /statusCounts\.Confirmed/
  );

  assert.match(
    compactPage,
    /statusCounts\.Completed/
  );

  assert.match(
    compactPage,
    /statusCounts\.Cancelled/
  );
});

test("analytics rates state their denominator and avoid unsupported revenue and call claims", () => {
  assert.match(
    compactPage,
    /Completed appointments divided by all appointments in this 30-day period\./
  );

  assert.match(
    compactPage,
    /Cancelled appointments divided by all appointments in this 30-day period\./
  );

  assert.doesNotMatch(
    compactPage,
    /revenue/i
  );

  assert.doesNotMatch(
    compactPage,
    /missed calls/i
  );

  assert.doesNotMatch(
    compactPage,
    /call volume/i
  );

  assert.doesNotMatch(
    compactPage,
    /AI performance/i
  );
});

test("analytics builds daily trend including zero-appointment dates", () => {
  assert.match(
    compactHelper,
    /for \( let index = 0; index < days; index \+= 1 \)/
  );

  assert.match(
    compactHelper,
    /count: counts\.get\(value\) \|\| 0/
  );

  assert.match(
    compactPage,
    /Appointment trend/
  );
});

test("analytics service mix uses appointment service snapshots", () => {
  assert.match(
    compactHelper,
    /appointment\.service\?\.trim\(\) \|\| "Unknown service"/
  );

  assert.match(
    compactPage,
    /serviceAppointmentCounts\( appointments \)/
  );

  assert.match(
    compactPage,
    /Service mix/
  );
});