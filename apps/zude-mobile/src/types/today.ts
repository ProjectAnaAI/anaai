export type AppointmentStatus = "Booked" | "Confirmed" | "Completed" | "Cancelled";
export type Appointment = {
  id: string;
  customer: string;
  service: string;
  start: number | null;
  duration: number | null;
  status: AppointmentStatus;
};
