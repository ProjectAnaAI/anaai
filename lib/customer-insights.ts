/*
 * Read-only CRM insights derived from existing appointment snapshots.
 *
 * Appointment dates are stored as YYYY-MM-DD business-local values and
 * times as HH:MM(:SS). Everything here compares those strings directly
 * against "now" expressed in the business timezone, so nothing is ever
 * parsed through UTC and no appointment can drift to another day.
 */

export type CustomerAppointment = {
  id: string;
  customer_id: string | null;
  service: string | null;
  appointment_date: string | null;
  appointment_time: string | null;
  status: string | null;
  notes: string | null;
};

export type CustomerHistorySummary = {
  count: number;
  latest: CustomerAppointment | null;
  upcoming: CustomerAppointment | null;
  lastPast: CustomerAppointment | null;
  completedCount: number;
  cancelledCount: number;
  services: { name: string; count: number }[];
};

/* Statuses that still represent a scheduled visit. */
const SCHEDULED_STATUSES = new Set(["Booked", "Confirmed"]);

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^(\d{1,2}):(\d{2})/;

export function compareAppointmentsNewestFirst(
  first: CustomerAppointment,
  second: CustomerAppointment
) {
  const firstKey = `${
    first.appointment_date || ""
  }T${first.appointment_time || ""}`;

  const secondKey = `${
    second.appointment_date || ""
  }T${second.appointment_time || ""}`;

  return secondKey.localeCompare(
    firstKey
  );
}

function normalizeTime(value: string | null) {
  const match = value?.match(TIME_PATTERN);

  if (!match) {
    return null;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  if (hours > 23 || minutes > 59) {
    return null;
  }

  return `${String(hours).padStart(2, "0")}:${match[2]}`;
}

/*
 * Comparable local key. An appointment without a time counts as lasting
 * until the end of its day so a same-day booking is not treated as past.
 */
export function appointmentLocalKey(
  appointment: Pick<
    CustomerAppointment,
    "appointment_date" | "appointment_time"
  >
) {
  const date = appointment.appointment_date;

  if (!date || !DATE_PATTERN.test(date)) {
    return null;
  }

  return `${date}T${
    normalizeTime(appointment.appointment_time) || "23:59"
  }`;
}

/* Current wall-clock time in the business timezone as YYYY-MM-DDTHH:MM. */
export function businessNowKey(
  timezone: string,
  now = new Date()
) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);

    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((item) => item.type === type)?.value;

    const year = part("year");
    const month = part("month");
    const day = part("day");
    const hour = part("hour");
    const minute = part("minute");

    if (!year || !month || !day || !hour || !minute) {
      return null;
    }

    return `${year}-${month}-${day}T${hour}:${minute}`;
  } catch {
    return null;
  }
}

export function isScheduledStatus(status: string | null) {
  return SCHEDULED_STATUSES.has(status || "");
}

/*
 * Upcoming: Booked/Confirmed at or after now in the business timezone.
 * Cancelled and Completed appointments are never upcoming.
 */
export function isUpcomingAppointment(
  appointment: CustomerAppointment,
  nowKey: string | null
) {
  if (!nowKey || !isScheduledStatus(appointment.status)) {
    return false;
  }

  const key = appointmentLocalKey(appointment);

  return Boolean(key && key >= nowKey);
}

/* `history` must already be newest-first and linked by customer_id. */
export function summarizeCustomerHistory(
  history: CustomerAppointment[],
  nowKey: string | null
): CustomerHistorySummary {
  let upcoming: CustomerAppointment | null = null;
  let upcomingKey = "";
  let lastPast: CustomerAppointment | null = null;
  let completedCount = 0;
  let cancelledCount = 0;

  const serviceCounts = new Map<string, number>();

  for (const appointment of history) {
    if (appointment.status === "Completed") {
      completedCount += 1;
    }

    if (appointment.status === "Cancelled") {
      cancelledCount += 1;
      continue;
    }

    const service = appointment.service?.trim();

    if (service) {
      serviceCounts.set(
        service,
        (serviceCounts.get(service) || 0) + 1
      );
    }

    const key = appointmentLocalKey(appointment);

    if (isUpcomingAppointment(appointment, nowKey)) {
      /* Nearest upcoming, not furthest. */
      if (key && (!upcoming || key < upcomingKey)) {
        upcoming = appointment;
        upcomingKey = key;
      }

      continue;
    }

    /* Newest-first input: the first past, non-cancelled row. Without a
       business "now" nothing can be classified as past or upcoming. */
    if (!lastPast && nowKey && key && key < nowKey) {
      lastPast = appointment;
    }
  }

  const services = [...serviceCounts]
    .map(([name, count]) => ({ name, count }))
    .sort(
      (first, second) =>
        second.count - first.count ||
        first.name.localeCompare(second.name)
    );

  const mostRecent = history[0];

  return {
    count: history.length,
    latest: mostRecent || null,
    upcoming,
    lastPast,
    completedCount,
    cancelledCount,
    services,
  };
}

/* Local-calendar formatting: never `new Date("YYYY-MM-DD")`, which is UTC. */
export function formatAppointmentDate(
  value: string | null,
  options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    year: "numeric",
  }
) {
  if (!value) {
    return "Date unavailable";
  }

  const parts = value.split("-");

  if (parts.length !== 3) {
    return value;
  }

  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    return value;
  }

  const date = new Date(year, month - 1, day);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en-US", options).format(date);
}

export function formatAppointmentTime(value: string | null) {
  if (!value) {
    return "Time unavailable";
  }

  const normalized = normalizeTime(value);

  if (!normalized) {
    return value;
  }

  const [hours, minutes] = normalized.split(":").map(Number);
  const suffix = hours >= 12 ? "PM" : "AM";
  const displayHour = hours % 12 || 12;

  return `${displayHour}:${String(minutes).padStart(2, "0")} ${suffix}`;
}
