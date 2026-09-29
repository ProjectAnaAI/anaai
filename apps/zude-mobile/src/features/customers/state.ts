import { ZudeApiError } from "../../lib/api";
import type { CustomerDetail, CustomerFields, CustomerRecord } from "../../lib/customers-api";
import { safeMessage } from "../appointments/state";

export const emptyCustomerFields: CustomerFields = { name: "", phone: "", email: "", notes: "" };
export function customerFields(customer: CustomerRecord): CustomerFields {
  return { name: customer.full_name, phone: customer.phone || "", email: customer.email || "", notes: customer.notes || "" };
}

// Validation happens on the server with the web rules; the typed code tells
// the device what to explain. Server text is never displayed.
export function customerMessage(error: unknown) {
  if (error instanceof ZudeApiError) {
    if (error.code === "CUSTOMER_NAME_INVALID") return "Enter a customer name (up to 200 characters).";
    if (error.code === "CUSTOMER_PHONE_INVALID") return "Enter a valid phone number with 7–15 digits.";
    if (error.code === "CUSTOMER_EMAIL_INVALID") return "Enter a valid email address.";
    if (error.code === "DUPLICATE_PHONE") return "A customer with this phone number already exists. Select or edit the existing customer.";
    if (error.code === "CUSTOMER_NOT_FOUND") return "This customer is no longer available. Refresh the list.";
    if (error.code === "INVALID_REQUEST" || error.code === "INVALID_RESPONSE") return "The customer could not be verified. Refresh and try again.";
    if (error.status === 0 && error.code === "NETWORK_ERROR") return "Unable to reach ZUDE. Your changes were not confirmed. Check your connection and retry.";
    if (error.status >= 500) return "Unable to save the customer. Refresh the list before retrying.";
  }
  return safeMessage(error);
}

export function customerLoadMessage(error: string | undefined) {
  return error || "Customers could not be loaded.";
}

// Upcoming uses the server's authoritative classification (business timezone,
// Booked/Confirmed only). History lists every other linked appointment, newest first.
export function historyPresentation(detail: CustomerDetail) {
  const upcoming = detail.appointments.find((appointment) => appointment.id === detail.summary.upcomingId) || null;
  const history = detail.appointments.filter((appointment) => appointment.id !== upcoming?.id);
  return { upcoming, history };
}

export function historyCountLabel(detail: CustomerDetail) {
  const { total, completed, cancelled } = detail.summary;
  if (!total) return "No appointments yet";
  return [`${total} appointment${total === 1 ? "" : "s"}`, completed ? `${completed} completed` : "", cancelled ? `${cancelled} cancelled` : ""]
    .filter(Boolean).join(" · ");
}

export function appointmentCustomer(customer: CustomerRecord) {
  return { id: customer.id, full_name: customer.full_name, phone: customer.phone };
}

export function canBook(customer: CustomerRecord) {
  return customer.is_active;
}
