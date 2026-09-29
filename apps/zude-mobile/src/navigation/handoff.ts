import type { Customer } from "../lib/appointments-api";

// Customers → New Appointment. The customer is held in memory (never in the
// route) and is released only to the Appointments screen opened with the same
// token for the same business. Reading is pure, so re-renders are safe.
export function appointmentHandoff() {
  let pending: { businessId: string; customer: Customer; token: string } | null = null;
  let count = 0;
  return {
    start(businessId: string, customer: Customer) {
      const token = String(++count);
      pending = { businessId, customer: { id: customer.id, full_name: customer.full_name, phone: customer.phone }, token };
      return token;
    },
    customer(businessId: string, token: string | undefined) {
      return pending && token && pending.token === token && pending.businessId === businessId ? pending.customer : null;
    },
  };
}
