import type { Appointment, AppointmentStatus } from "../../types/today";
export function statusTone(status: AppointmentStatus): "success" | "warning" | "neutral" {
  return status === "Confirmed" ? "success" : status === "Booked" ? "warning" : "neutral";
}
export function timelinePresentation(appointments: readonly Appointment[], now: number | null) {
  const ordered = [...appointments].sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity) || a.id.localeCompare(b.id));
  const nextIndex = now === null ? -1 : ordered.findIndex((a) => a.start === null || a.start > now);
  return { ordered, nowIndex: now === null ? -1 : nextIndex < 0 ? ordered.length : nextIndex };
}
export function upcomingAppointment(appointments: readonly Appointment[], now: number | null) {
  if (now === null) return undefined;
  return timelinePresentation(appointments, now).ordered.find((a) =>
    (a.status === "Booked" || a.status === "Confirmed") && a.start !== null && a.start >= now);
}
export function appointmentTiming(a: Appointment, now: number | null) {
  const terminal = a.status === "Completed" || a.status === "Cancelled";
  const end = a.start !== null && a.duration !== null ? a.start + a.duration : null;
  return {
    current: !terminal && now !== null && a.start !== null && end !== null && a.start <= now && now < end,
    past: terminal || (now !== null && end !== null && end <= now),
  };
}

// Display-only context derived from the same business-local clock as the timeline.
export function upcomingTimingLabel(start: number | null, now: number | null) {
  if (start === null || now === null || start < now) return "Upcoming appointment";
  const minutes = Math.ceil(start - now);
  return minutes === 0 ? "Starting now" : `Starts in ${minutes} ${minutes === 1 ? "min" : "mins"}`;
}
