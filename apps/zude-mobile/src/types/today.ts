export type AppointmentStatus =
  | "In progress"
  | "Checked in"
  | "Confirmed"
  | "Unconfirmed"
  | "Completed";
export type Appointment = {
  id: string;
  customer: string;
  service: string;
  start: number;
  duration: number;
  status: AppointmentStatus;
};
export type AvailableSlot = { id: string; start: number; duration: number };
export type AttentionItem = {
  id: string;
  title: string;
  detail: string;
  action: string;
  preview: string;
};
export type Preview = { title: string; detail: string };
