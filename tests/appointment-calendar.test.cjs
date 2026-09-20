const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const sourcePath = path.join(
  process.cwd(),
  "lib",
  "appointment-calendar.ts"
);

const source = fs.readFileSync(
  sourcePath,
  "utf8"
);

const compiled = ts.transpileModule(
  source,
  {
    compilerOptions: {
      module:
        ts.ModuleKind.CommonJS,
      target:
        ts.ScriptTarget.ES2020,
    },
  }
).outputText;

const moduleValue = {
  exports: {},
};

new Function(
  "module",
  "exports",
  compiled
)(
  moduleValue,
  moduleValue.exports
);

const {
  dateKey,
  parseDateKey,
  shiftDateKey,
  todayInTimezone,
  startOfWeek,
  weekDateKeys,
  monthDateKeys,
  shiftMonth,
  navigateCalendar,
  calendarTimeSlots,
  normalizeCalendarTime,
  minutesFromTime,
  appointmentEndTime,
  appointmentsForDate,
} = moduleValue.exports;

test("date keys validate real calendar dates", () => {
  assert.equal(
    dateKey(2026, 9, 5),
    "2026-09-05"
  );

  assert.deepEqual(
    parseDateKey("2026-09-20"),
    {
      year: 2026,
      month: 9,
      day: 20,
    }
  );

  assert.deepEqual(
    parseDateKey("2028-02-29"),
    {
      year: 2028,
      month: 2,
      day: 29,
    }
  );

  assert.equal(
    parseDateKey("2026-02-29"),
    null
  );

  assert.equal(
    parseDateKey("2026-13-01"),
    null
  );

  assert.equal(
    parseDateKey("not-a-date"),
    null
  );
});

test("calendar-day shifting crosses month and year boundaries", () => {
  assert.equal(
    shiftDateKey(
      "2026-09-30",
      1
    ),
    "2026-10-01"
  );

  assert.equal(
    shiftDateKey(
      "2026-01-01",
      -1
    ),
    "2025-12-31"
  );

  assert.equal(
    shiftDateKey(
      "2028-02-28",
      1
    ),
    "2028-02-29"
  );

  assert.equal(
    shiftDateKey(
      "2028-02-29",
      1
    ),
    "2028-03-01"
  );
});

test("today is derived in the business timezone", () => {
  const instant = new Date(
    "2026-09-20T06:30:00.000Z"
  );

  assert.equal(
    todayInTimezone(
      "America/Los_Angeles",
      instant
    ),
    "2026-09-19"
  );

  assert.equal(
    todayInTimezone(
      "Asia/Tokyo",
      instant
    ),
    "2026-09-20"
  );

  assert.equal(
    todayInTimezone(
      "Invalid/Timezone",
      instant
    ),
    null
  );
});

test("week starts Sunday and always contains seven consecutive dates", () => {
  assert.equal(
    startOfWeek(
      "2026-09-20"
    ),
    "2026-09-20"
  );

  assert.equal(
    startOfWeek(
      "2026-09-23"
    ),
    "2026-09-20"
  );

  assert.deepEqual(
    weekDateKeys(
      "2026-09-23"
    ),
    [
      "2026-09-20",
      "2026-09-21",
      "2026-09-22",
      "2026-09-23",
      "2026-09-24",
      "2026-09-25",
      "2026-09-26",
    ]
  );
});

test("month grid begins Sunday and ends Saturday", () => {
  const september =
    monthDateKeys(
      "2026-09-20"
    );

  assert.equal(
    september[0],
    "2026-08-30"
  );

  assert.equal(
    september[
      september.length - 1
    ],
    "2026-10-03"
  );

  assert.equal(
    september.length,
    35
  );

  const august =
    monthDateKeys(
      "2026-08-15"
    );

  assert.equal(
    august[0],
    "2026-07-26"
  );

  assert.equal(
    august[
      august.length - 1
    ],
    "2026-09-05"
  );

  assert.equal(
    august.length,
    42
  );
});

test("month navigation clamps the selected day safely", () => {
  assert.equal(
    shiftMonth(
      "2026-01-31",
      1
    ),
    "2026-02-28"
  );

  assert.equal(
    shiftMonth(
      "2028-01-31",
      1
    ),
    "2028-02-29"
  );

  assert.equal(
    shiftMonth(
      "2026-03-31",
      -1
    ),
    "2026-02-28"
  );

  assert.equal(
    shiftMonth(
      "2026-12-15",
      1
    ),
    "2027-01-15"
  );
});

test("calendar navigation follows the active view", () => {
  assert.equal(
    navigateCalendar(
      "2026-09-20",
      "month",
      1
    ),
    "2026-10-20"
  );

  assert.equal(
    navigateCalendar(
      "2026-09-20",
      "week",
      1
    ),
    "2026-09-27"
  );

  assert.equal(
    navigateCalendar(
      "2026-09-20",
      "week",
      -1
    ),
    "2026-09-13"
  );

  assert.equal(
    navigateCalendar(
      "2026-09-20",
      "day",
      1
    ),
    "2026-09-21"
  );

  assert.equal(
    navigateCalendar(
      "2026-09-20",
      "list",
      -1
    ),
    "2026-08-20"
  );
});

test("calendar slots are generated deterministically", () => {
  assert.deepEqual(
    calendarTimeSlots(
      9,
      11,
      30
    ),
    [
      "09:00",
      "09:30",
      "10:00",
      "10:30",
    ]
  );

  assert.deepEqual(
    calendarTimeSlots(
      9,
      10,
      15
    ),
    [
      "09:00",
      "09:15",
      "09:30",
      "09:45",
    ]
  );

  assert.deepEqual(
    calendarTimeSlots(
      20,
      9,
      30
    ),
    []
  );

  assert.deepEqual(
    calendarTimeSlots(
      9,
      17,
      0
    ),
    []
  );
});

test("calendar times normalize and reject malformed values", () => {
  assert.equal(
    normalizeCalendarTime(
      "9:05"
    ),
    "09:05"
  );

  assert.equal(
    normalizeCalendarTime(
      "14:30:00"
    ),
    "14:30"
  );

  assert.equal(
    normalizeCalendarTime(
      "23:59"
    ),
    "23:59"
  );

  assert.equal(
    normalizeCalendarTime(
      "24:00"
    ),
    null
  );

  assert.equal(
    normalizeCalendarTime(
      "12:60"
    ),
    null
  );

  assert.equal(
    normalizeCalendarTime(
      null
    ),
    null
  );

  assert.equal(
    minutesFromTime(
      "14:30"
    ),
    870
  );
});

test("appointment end time uses authoritative service duration data", () => {
  const services = [
    {
      id: "service-a",
      duration_minutes: 45,
    },
    {
      id: "service-b",
      duration_minutes: 90,
    },
  ];

  assert.equal(
    appointmentEndTime(
      {
        appointment_date:
          "2026-09-20",
        appointment_time:
          "09:30",
        service_id:
          "service-a",
      },
      services
    ),
    "10:15"
  );

  assert.equal(
    appointmentEndTime(
      {
        appointment_date:
          "2026-09-20",
        appointment_time:
          "22:45",
        service_id:
          "service-b",
      },
      services
    ),
    null
  );

  assert.equal(
    appointmentEndTime(
      {
        appointment_date:
          "2026-09-20",
        appointment_time:
          "09:30",
        service_id:
          "missing",
      },
      services
    ),
    null
  );
});

test("appointments are filtered by date and ordered by start time", () => {
  const appointments = [
    {
      id: "later",
      appointment_date:
        "2026-09-20",
      appointment_time:
        "14:00",
    },
    {
      id: "other-day",
      appointment_date:
        "2026-09-21",
      appointment_time:
        "08:00",
    },
    {
      id: "earlier",
      appointment_date:
        "2026-09-20",
      appointment_time:
        "09:30",
    },
    {
      id: "unknown-time",
      appointment_date:
        "2026-09-20",
      appointment_time:
        null,
    },
  ];

  assert.deepEqual(
    appointmentsForDate(
      appointments,
      "2026-09-20"
    ).map(
      (appointment) =>
        appointment.id
    ),
    [
      "earlier",
      "later",
      "unknown-time",
    ]
  );
});