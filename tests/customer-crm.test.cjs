const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const ts = require("typescript");

const insightsPath = path.join(
  process.cwd(),
  "lib",
  "customer-insights.ts"
);

const insightsSource = fs.readFileSync(
  insightsPath,
  "utf8"
);

const compiled = ts.transpileModule(
  insightsSource,
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }
).outputText;

const moduleValue = { exports: {} };

new Function(
  "module",
  "exports",
  compiled
)(moduleValue, moduleValue.exports);

const insights = moduleValue.exports;

const page = fs.readFileSync(
  path.join(process.cwd(), "app", "customers", "page.tsx"),
  "utf8"
);

const compactPage = page.replace(/\s+/g, " ");

const css = fs.readFileSync(
  path.join(process.cwd(), "app", "design-system.css"),
  "utf8"
);

function appointment(overrides = {}) {
  return {
    id: overrides.id || "appointment",
    customer_id: "customer",
    service: "Haircut",
    appointment_date: "2026-10-05",
    appointment_time: "10:00:00",
    status: "Booked",
    notes: null,
    ...overrides,
  };
}

function newestFirst(rows) {
  return [...rows].sort(
    insights.compareAppointmentsNewestFirst
  );
}

test("business now key uses the business timezone, not UTC", () => {
  const instant = new Date("2026-03-01T02:30:00Z");

  assert.equal(
    insights.businessNowKey("America/Los_Angeles", instant),
    "2026-02-28T18:30"
  );

  assert.equal(
    insights.businessNowKey("Asia/Tokyo", instant),
    "2026-03-01T11:30"
  );

  assert.equal(
    insights.businessNowKey("UTC", new Date("2026-03-01T00:05:00Z")),
    "2026-03-01T00:05"
  );

  assert.equal(
    insights.businessNowKey("Not/AZone", instant),
    null
  );
});

test("upcoming appointment is the nearest Booked or Confirmed visit and ignores Cancelled", () => {
  const history = newestFirst([
    appointment({ id: "far", appointment_date: "2026-12-01", status: "Confirmed" }),
    appointment({ id: "cancelled-soon", appointment_date: "2026-10-02", status: "Cancelled" }),
    appointment({ id: "near", appointment_date: "2026-10-03", status: "Booked" }),
    appointment({ id: "past", appointment_date: "2026-09-01", status: "Completed" }),
  ]);

  const summary = insights.summarizeCustomerHistory(
    history,
    "2026-10-01T09:00"
  );

  assert.equal(summary.upcoming.id, "near");
  assert.equal(summary.lastPast.id, "past");
  assert.equal(summary.count, 4);
  assert.equal(summary.latest.id, "far");
  assert.equal(summary.cancelledCount, 1);
  assert.equal(summary.completedCount, 1);
});

test("only cancelled future appointments means no upcoming appointment", () => {
  const summary = insights.summarizeCustomerHistory(
    [appointment({ status: "Cancelled", appointment_date: "2026-11-01" })],
    "2026-10-01T09:00"
  );

  assert.equal(summary.upcoming, null);
  assert.equal(summary.lastPast, null);
  assert.equal(summary.count, 1);
});

test("completed and unrecognized statuses are never upcoming", () => {
  for (const status of ["Completed", "Cancelled", null, "Unknown"]) {
    assert.equal(
      insights.isUpcomingAppointment(
        appointment({ status, appointment_date: "2026-11-01" }),
        "2026-10-01T09:00"
      ),
      false
    );
  }
});

test("same-day boundary compares business-local wall-clock time", () => {
  const nowKey = "2026-10-05T10:30";

  assert.equal(
    insights.isUpcomingAppointment(
      appointment({ appointment_time: "10:00:00" }),
      nowKey
    ),
    false
  );

  assert.equal(
    insights.isUpcomingAppointment(
      appointment({ appointment_time: "11:00:00" }),
      nowKey
    ),
    true
  );

  /* Single-digit hours are normalized so 9:00 is not treated as after 10:30. */
  assert.equal(
    insights.isUpcomingAppointment(
      appointment({ appointment_time: "9:00" }),
      nowKey
    ),
    false
  );

  /* A dated appointment without a time stays upcoming for its whole day. */
  assert.equal(
    insights.isUpcomingAppointment(
      appointment({ appointment_time: null }),
      nowKey
    ),
    true
  );
});

test("missing business time never classifies appointments as upcoming or past", () => {
  const history = newestFirst([
    appointment({ id: "future", appointment_date: "2099-01-01" }),
    appointment({ id: "cancelled", status: "Cancelled", appointment_date: "2098-01-01" }),
  ]);

  const summary = insights.summarizeCustomerHistory(history, null);

  assert.equal(summary.upcoming, null);
  assert.equal(summary.lastPast, null);
  assert.equal(summary.latest.id, "future");
  assert.equal(summary.count, 2);
});

test("service history counts non-cancelled snapshots, most frequent first", () => {
  const summary = insights.summarizeCustomerHistory(
    newestFirst([
      appointment({ id: "a", service: "Color", appointment_date: "2026-01-01" }),
      appointment({ id: "b", service: "Haircut", appointment_date: "2026-02-01" }),
      appointment({ id: "c", service: "Haircut", appointment_date: "2026-03-01" }),
      appointment({ id: "d", service: "Facial", status: "Cancelled", appointment_date: "2026-04-01" }),
      appointment({ id: "e", service: "  ", appointment_date: "2026-05-01" }),
    ]),
    "2026-10-01T09:00"
  );

  assert.deepEqual(
    summary.services.map((item) => [item.name, item.count]),
    [["Haircut", 2], ["Color", 1]]
  );
});

test("appointment dates format without UTC drift in any host timezone", () => {
  const script = `
    const m = { exports: {} };
    new Function("module", "exports", ${JSON.stringify(compiled)})(m, m.exports);
    process.stdout.write(JSON.stringify([
      m.exports.formatAppointmentDate("2026-01-01"),
      m.exports.formatAppointmentDate("2026-12-31"),
    ]));
  `;

  for (const zone of ["Pacific/Honolulu", "UTC", "Pacific/Kiritimati"]) {
    const output = execFileSync(process.execPath, ["-e", script], {
      env: { ...process.env, TZ: zone },
    }).toString();

    assert.deepEqual(
      JSON.parse(output),
      ["Jan 1, 2026", "Dec 31, 2026"],
      zone
    );
  }

  assert.doesNotMatch(insightsSource, /new Date\(\s*value\s*\)|Date\.parse|toISOString/);
});

test("appointment times format as 12-hour clock", () => {
  assert.equal(insights.formatAppointmentTime("13:05:00"), "1:05 PM");
  assert.equal(insights.formatAppointmentTime("00:00"), "12:00 AM");
  assert.equal(insights.formatAppointmentTime(null), "Time unavailable");
});

test("customer page reads appointments only and never mutates history", () => {
  const appointmentQueries = page.match(/\.from\("appointments"\)/g) || [];

  assert.equal(appointmentQueries.length, 1);

  assert.doesNotMatch(
    compactPage,
    /\.from\("appointments"\)[\s\S]{0,400}\.(insert|update|upsert|delete)\(/
  );
});

test("no hard-delete customer UI or query is introduced", () => {
  assert.doesNotMatch(page, /Delete customer|\.delete\(/i);
  assert.match(compactPage, /is_active: nextActive/);
  assert.match(page, /Archive customer/);
  assert.match(page, /Reactivate customer/);
});

test("add and edit still go through the shared customer mutation authority", () => {
  assert.match(
    compactPage,
    /import \{ saveCustomer, type CustomerRecord, \} from "@\/lib\/customer-mutations"/
  );

  assert.match(compactPage, /await saveCustomer\( businessId,/);
  assert.doesNotMatch(compactPage, /\.from\("customers"\)[^;]*\.insert\(/);
});

test("archive and reactivate use the shared confirmation dialog", () => {
  assert.doesNotMatch(page, /window\.confirm/);
  assert.match(compactPage, /const confirmed = await confirm\(/);
  assert.match(compactPage, /if \(!confirmed\) \{ return; \}/);
  assert.match(page, /\{confirmation\}/);
  assert.match(page, /appointment history will be preserved/i);
});

test("customer detail opens as an accessible responsive drawer", () => {
  assert.match(
    compactPage,
    /<DialogSurface aria-labelledby="customer-details-title" className="customer-drawer"/
  );

  assert.match(page, /id="customer-details-title"/);
  assert.match(page, /aria-haspopup="dialog"/);

  for (const label of [
    "Close customer details",
    "Clear search",
    "Dismiss message",
    "Close customer editor",
  ]) {
    assert.match(page, new RegExp(`aria-label="${label}"`));
  }

  /* Side drawer from tablet width; the shared phone rule turns it into a bottom sheet. */
  assert.match(
    css,
    /@media \(min-width: 768px\) \{\s*\.dialog-surface\.customer-drawer \{[^}]*height: 100dvh;/
  );

  /* Directory adapts to its own width (sidebar or not) instead of the viewport. */
  assert.match(css, /\.customer-directory \{\s*container-type: inline-size;/);
  assert.match(css, /@container \(min-width: 620px\)/);
  assert.match(css, /@container \(min-width: 960px\)/);
});

test("directory rows and filters keep 44px touch targets", () => {
  assert.match(css, /\.customer-filter button \{[^}]*min-height: 44px;/);
  assert.match(css, /\.customer-directory-row \{[^}]*min-height: 64px;/);
  assert.match(css, /\.customer-icon-button \{[^}]*width: 44px;[^}]*height: 44px;/);
  assert.match(css, /\.customer-contact-link \{[^}]*min-height: 44px;/);
});

test("contact details offer direct call and email links", () => {
  assert.match(page, /href=\{`tel:\$\{customer\.phone\}`\}/);
  assert.match(page, /href=\{`mailto:\$\{customer\.email\}`\}/);
});
