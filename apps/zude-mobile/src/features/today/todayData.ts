import type { Appointment, AppointmentStatus } from "../../types/today";

export function businessClock(timezone: string, now: Date) {
  if (!timezone?.trim()) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(now);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((p) => p.type === type)?.value;
    const date = `${part("year")}-${part("month")}-${part("day")}`;
    const minutes = Number(part("hour")) * 60 + Number(part("minute"));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(minutes)) return null;
    return {
      date, minutes,
      label: new Intl.DateTimeFormat("en-US", {
        timeZone: timezone, weekday: "long", month: "long", day: "numeric",
      }).format(now),
    };
  } catch {
    return null;
  }
}

export function formatTime(minutes: number | null) {
  if (minutes === null) return "Time unavailable";
  const hour = Math.floor(minutes / 60);
  return `${hour % 12 || 12}:${String(minutes % 60).padStart(2, "0")} ${hour >= 12 ? "PM" : "AM"}`;
}

export function formatDuration(duration: number | null) {
  return duration === null ? "Duration unavailable" : `${duration} min`;
}

export type AppointmentRow = {
  id: string;
  customer_name: string | null;
  service: string | null;
  appointment_time: string | null;
  status: string;
  duration_minutes: number | null;
};

export function mapAppointment(row: AppointmentRow): Appointment {
  const statuses: readonly string[] = ["Booked", "Confirmed", "Completed", "Cancelled"];
  if (!statuses.includes(row.status)) throw new Error("Unsupported appointment status");
  const time = row.appointment_time?.match(/^(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/);
  const start = time && Number(time[1]) < 24 && Number(time[2]) < 60
    ? Number(time[1]) * 60 + Number(time[2]) : null;
  return {
    id: row.id, customer: row.customer_name || "Customer",
    service: row.service || "Service", start,
    duration: row.duration_minutes,
    status: row.status as AppointmentStatus,
  };
}
