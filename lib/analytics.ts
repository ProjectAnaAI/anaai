export type AnalyticsAppointment = {
  id: string;
  service: string | null;
  appointment_date: string | null;
  status: string | null;
};

export type DailyAppointmentCount = {
  date: string;
  count: number;
};

export type ServiceAppointmentCount = {
  service: string;
  count: number;
};

export type AppointmentStatusCounts = {
  Booked: number;
  Confirmed: number;
  Completed: number;
  Cancelled: number;
  Other: number;
};

function datePartsInTimezone(
  date: Date,
  timezone: string
) {
  const parts =
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }
    ).formatToParts(date);

  const year = parts.find(
    (part) => part.type === "year"
  )?.value;

  const month = parts.find(
    (part) => part.type === "month"
  )?.value;

  const day = parts.find(
    (part) => part.type === "day"
  )?.value;

  if (!year || !month || !day) {
    throw new Error(
      "Unable to determine the business date."
    );
  }

  return {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    value: `${year}-${month}-${day}`,
  };
}

function isoDateFromUtcParts(
  year: number,
  month: number,
  day: number
) {
  return new Date(
    Date.UTC(
      year,
      month - 1,
      day
    )
  )
    .toISOString()
    .slice(0, 10);
}

export function businessDate(
  timezone: string,
  now = new Date()
) {
  return datePartsInTimezone(
    now,
    timezone
  ).value;
}

export function reportingWindow(
  timezone: string,
  days = 30,
  now = new Date()
) {
  if (
    !Number.isInteger(days) ||
    days < 1
  ) {
    throw new Error(
      "Reporting days must be a positive integer."
    );
  }

  const current =
    datePartsInTimezone(
      now,
      timezone
    );

  const endDate =
    isoDateFromUtcParts(
      current.year,
      current.month,
      current.day
    );

  const start = new Date(
    Date.UTC(
      current.year,
      current.month - 1,
      current.day
    )
  );

  start.setUTCDate(
    start.getUTCDate() -
      (days - 1)
  );

  const startDate =
    start.toISOString().slice(0, 10);

  return {
    startDate,
    endDate,
    days,
  };
}

export function countStatuses(
  appointments: AnalyticsAppointment[]
): AppointmentStatusCounts {
  const counts: AppointmentStatusCounts = {
    Booked: 0,
    Confirmed: 0,
    Completed: 0,
    Cancelled: 0,
    Other: 0,
  };

  for (const appointment of appointments) {
    switch (appointment.status) {
      case "Booked":
        counts.Booked += 1;
        break;

      case "Confirmed":
        counts.Confirmed += 1;
        break;

      case "Completed":
        counts.Completed += 1;
        break;

      case "Cancelled":
        counts.Cancelled += 1;
        break;

      default:
        counts.Other += 1;
        break;
    }
  }

  return counts;
}

export function percentage(
  count: number,
  total: number
) {
  if (
    total <= 0 ||
    count <= 0
  ) {
    return 0;
  }

  return Math.round(
    (count / total) * 100
  );
}

export function dailyAppointmentCounts(
  appointments: AnalyticsAppointment[],
  startDate: string,
  days: number
): DailyAppointmentCount[] {
  const counts = new Map<
    string,
    number
  >();

  for (const appointment of appointments) {
    if (!appointment.appointment_date) {
      continue;
    }

    counts.set(
      appointment.appointment_date,
      (counts.get(
        appointment.appointment_date
      ) || 0) + 1
    );
  }

  const start = new Date(
    `${startDate}T00:00:00Z`
  );

  const result: DailyAppointmentCount[] =
    [];

  for (
    let index = 0;
    index < days;
    index += 1
  ) {
    const date = new Date(start);

    date.setUTCDate(
      start.getUTCDate() +
        index
    );

    const value =
      date.toISOString().slice(0, 10);

    result.push({
      date: value,
      count:
        counts.get(value) || 0,
    });
  }

  return result;
}

export function serviceAppointmentCounts(
  appointments: AnalyticsAppointment[]
): ServiceAppointmentCount[] {
  const counts = new Map<
    string,
    number
  >();

  for (const appointment of appointments) {
    const service =
      appointment.service?.trim() ||
      "Unknown service";

    counts.set(
      service,
      (counts.get(service) || 0) +
        1
    );
  }

  return [...counts.entries()]
    .map(([service, count]) => ({
      service,
      count,
    }))
    .sort((first, second) => {
      if (
        first.count !==
        second.count
      ) {
        return (
          second.count -
          first.count
        );
      }

      return first.service.localeCompare(
        second.service
      );
    });
}