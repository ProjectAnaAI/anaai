// A business-local calendar date is not an instant in the device timezone.
// UTC is used only as a stable formatting anchor; ISO values stay in API/state.
export function dateLabel(value: string, compact = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return "Choose a date";
  const date = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return "Choose a date";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC", ...(compact ? {} : { weekday: "long" }),
    month: compact ? "short" : "long", day: "numeric", year: "numeric",
  }).format(date);
}
