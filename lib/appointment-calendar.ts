export type CalendarView =
  | "month"
  | "week"
  | "day"
  | "list";

export type CalendarAppointment = {
  appointment_date: string | null;
  appointment_time: string | null;
  service_id?: string | null;
};

export type CalendarService = {
  id: string;
  duration_minutes: number | null;
};

const DATE_KEY_PATTERN =
  /^\d{4}-\d{2}-\d{2}$/;

const TIME_PATTERN =
  /^(\d{1,2}):(\d{2})/;

function pad(value: number) {
  return String(value).padStart(
    2,
    "0"
  );
}

export function dateKey(
  year: number,
  month: number,
  day: number
) {
  return `${year}-${pad(
    month
  )}-${pad(day)}`;
}

export function parseDateKey(
  value: string
) {
  if (
    !DATE_KEY_PATTERN.test(
      value
    )
  ) {
    return null;
  }

  const [
    year,
    month,
    day,
  ] = value
    .split("-")
    .map(Number);

  const date = new Date(
    year,
    month - 1,
    day
  );

  if (
    date.getFullYear() !==
      year ||
    date.getMonth() !==
      month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }

  return {
    year,
    month,
    day,
  };
}

export function shiftDateKey(
  value: string,
  days: number
) {
  const parsed =
    parseDateKey(value);

  if (!parsed) {
    return value;
  }

  const date = new Date(
    parsed.year,
    parsed.month - 1,
    parsed.day + days
  );

  return dateKey(
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate()
  );
}

export function todayInTimezone(
  timezone: string,
  now = new Date()
) {
  try {
    const parts =
      new Intl.DateTimeFormat(
        "en-US",
        {
          timeZone: timezone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }
      ).formatToParts(now);

    const year = parts.find(
      (part) =>
        part.type === "year"
    )?.value;

    const month = parts.find(
      (part) =>
        part.type === "month"
    )?.value;

    const day = parts.find(
      (part) =>
        part.type === "day"
    )?.value;

    if (
      !year ||
      !month ||
      !day
    ) {
      return null;
    }

    return `${year}-${month}-${day}`;
  } catch {
    return null;
  }
}

export function startOfWeek(
  value: string
) {
  const parsed =
    parseDateKey(value);

  if (!parsed) {
    return value;
  }

  const date = new Date(
    parsed.year,
    parsed.month - 1,
    parsed.day
  );

  return shiftDateKey(
    value,
    -date.getDay()
  );
}

export function weekDateKeys(
  value: string
) {
  const start =
    startOfWeek(value);

  return Array.from(
    {
      length: 7,
    },
    (_, index) =>
      shiftDateKey(
        start,
        index
      )
  );
}

export function monthDateKeys(
  value: string
) {
  const parsed =
    parseDateKey(value);

  if (!parsed) {
    return [];
  }

  const first =
    dateKey(
      parsed.year,
      parsed.month,
      1
    );

  const firstVisible =
    startOfWeek(first);

  const lastOfMonth =
    new Date(
      parsed.year,
      parsed.month,
      0
    );

  const last =
    dateKey(
      lastOfMonth.getFullYear(),
      lastOfMonth.getMonth() +
        1,
      lastOfMonth.getDate()
    );

  const lastWeekStart =
    startOfWeek(last);

  const lastVisible =
    shiftDateKey(
      lastWeekStart,
      6
    );

  const dates: string[] =
    [];

  let cursor =
    firstVisible;

  while (true) {
    dates.push(cursor);

    if (
      cursor ===
      lastVisible
    ) {
      break;
    }

    cursor =
      shiftDateKey(
        cursor,
        1
      );

    if (
      dates.length > 42
    ) {
      return [];
    }
  }

  return dates;
}

export function shiftMonth(
  value: string,
  amount: number
) {
  const parsed =
    parseDateKey(value);

  if (!parsed) {
    return value;
  }

  const target =
    new Date(
      parsed.year,
      parsed.month - 1 +
        amount,
      1
    );

  const lastDay =
    new Date(
      target.getFullYear(),
      target.getMonth() + 1,
      0
    ).getDate();

  return dateKey(
    target.getFullYear(),
    target.getMonth() + 1,
    Math.min(
      parsed.day,
      lastDay
    )
  );
}

export function navigateCalendar(
  value: string,
  view: CalendarView,
  direction: -1 | 1
) {
  switch (view) {
    case "month":
      return shiftMonth(
        value,
        direction
      );

    case "week":
      return shiftDateKey(
        value,
        direction * 7
      );

    case "day":
      return shiftDateKey(
        value,
        direction
      );

    case "list":
      return shiftMonth(
        value,
        direction
      );
  }
}

export function calendarTimeSlots(
  startHour = 0,
  endHour = 24,
  intervalMinutes = 30
) {
  if (
    !Number.isInteger(
      startHour
    ) ||
    !Number.isInteger(
      endHour
    ) ||
    !Number.isInteger(
      intervalMinutes
    ) ||
    startHour < 0 ||
    startHour > 23 ||
    endHour < 1 ||
    endHour > 24 ||
    endHour <= startHour ||
    intervalMinutes <= 0 ||
    intervalMinutes > 60
  ) {
    return [];
  }

  const slots: string[] =
    [];

  for (
    let minutes =
      startHour * 60;
    minutes <
    endHour * 60;
    minutes +=
      intervalMinutes
  ) {
    const hour =
      Math.floor(
        minutes / 60
      );

    const minute =
      minutes % 60;

    slots.push(
      `${pad(hour)}:${pad(
        minute
      )}`
    );
  }

  return slots;
}

export function normalizeCalendarTime(
  value: string | null
) {
  if (!value) {
    return null;
  }

  const match =
    value.match(
      TIME_PATTERN
    );

  if (!match) {
    return null;
  }

  const hour =
    Number(match[1]);

  const minute =
    Number(match[2]);

  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(
      minute
    ) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  return `${pad(hour)}:${pad(
    minute
  )}`;
}

export function minutesFromTime(
  value: string | null
) {
  const normalized =
    normalizeCalendarTime(
      value
    );

  if (!normalized) {
    return null;
  }

  const [
    hour,
    minute,
  ] = normalized
    .split(":")
    .map(Number);

  return (
    hour * 60 +
    minute
  );
}

export function appointmentEndTime(
  appointment: CalendarAppointment,
  services: CalendarService[]
) {
  const start =
    minutesFromTime(
      appointment.appointment_time
    );

  if (start === null) {
    return null;
  }

  const service =
    services.find(
      (current) =>
        current.id ===
        appointment.service_id
    );

  const duration =
    service?.duration_minutes;

  if (
    typeof duration !==
      "number" ||
    !Number.isFinite(
      duration
    ) ||
    duration <= 0
  ) {
    return null;
  }

  const end =
    start + duration;

  if (end > 24 * 60) {
    return null;
  }

  const hour =
    Math.floor(
      end / 60
    );

  const minute =
    end % 60;

  return `${pad(hour)}:${pad(
    minute
  )}`;
}

export function appointmentsForDate<
  T extends CalendarAppointment,
>(
  appointments: T[],
  value: string
) {
  return appointments
    .filter(
      (appointment) =>
        appointment.appointment_date ===
        value
    )
    .sort((a, b) => {
      const aTime =
        normalizeCalendarTime(
          a.appointment_time
        ) || "99:99";

      const bTime =
        normalizeCalendarTime(
          b.appointment_time
        ) || "99:99";

      return aTime.localeCompare(
        bTime
      );
    });
}