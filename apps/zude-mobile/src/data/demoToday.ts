import type { AttentionItem, AvailableSlot } from "../types/today";

// Local fixture only. All time values are minutes after midnight on this demo day.
// Capacity belongs to the business; appointments deliberately have no staff assignment.
export const demoDay = {
  business: "Juniper Studio",
  location: "Oakland",
  date: "Saturday, September 26",
  shortDate: "September 26, 2026",
  now: 10 * 60 + 20,
  open: "9:00 AM – 6:00 PM",
  user: "Alex Morgan",
  initials: "AM",
  clockedInAt: "8:52 AM",
};
export const availableSlots: readonly AvailableSlot[] = [
  { id: "s1", start: 705, duration: 30 },
  { id: "s2", start: 750, duration: 30 },
  { id: "s3", start: 885, duration: 30 },
  { id: "s4", start: 975, duration: 30 },
];
export const attentionItems: readonly AttentionItem[] = [
  {
    id: "r1",
    title: "Awaiting confirmation",
    detail: "Sofia Martinez · 11:30 AM",
    action: "Review",
    preview:
      "Sofia’s demo appointment is unconfirmed. Confirmation and customer messaging will be available in a future milestone.",
  },
  {
    id: "r2",
    title: "Missing contact information",
    detail: "Ethan Brooks · 1:00 PM · No phone number",
    action: "View customer",
    preview:
      "Ethan’s sample customer record has no phone number. Customer editing and outreach are not connected in this preview.",
  },
];
export const voiceDemo = {
  title: "AnaAI Voice Assistant",
  detail: "A future home for call summaries and follow-ups.",
};

export function formatTime(minutes: number) {
  const hour = Math.floor(minutes / 60);
  return `${hour % 12 || 12}:${String(minutes % 60).padStart(2, "0")} ${hour >= 12 ? "PM" : "AM"}`;
}
