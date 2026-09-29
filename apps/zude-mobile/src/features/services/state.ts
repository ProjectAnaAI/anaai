import { ZudeApiError } from "../../lib/api";
import type { CatalogService, ServiceFields } from "../../lib/services-api";
import { safeMessage } from "../appointments/state";

// Same presentation as the web Services page.
export function serviceDuration(duration: number | null) {
  if (duration == null) return "Not set";
  if (duration === 60) return "1 hour";
  if (duration > 60 && duration % 60 === 0) return `${duration / 60} hours`;
  return `${duration} min`;
}
export function servicePrice(price: number | null) {
  return price == null ? "Not set" : `$${Number(price).toFixed(2)}`;
}

export const emptyServiceFields: ServiceFields = { name: "", duration: "", price: "", description: "", active: true };
export function serviceFields(service: CatalogService): ServiceFields {
  return {
    name: service.name, duration: service.duration_minutes == null ? "" : String(service.duration_minutes),
    price: service.price == null ? "" : String(service.price), description: service.description || "", active: service.is_active,
  };
}

export const durationLockedExplanation =
  "Duration cannot be changed for an existing service because appointments may already depend on it. Create a new service with the new duration, then deactivate this one.";

export function serviceMessage(error: unknown) {
  if (error instanceof ZudeApiError) {
    if (error.code === "SERVICE_NAME_INVALID") return "Enter a service name (up to 200 characters).";
    if (error.code === "SERVICE_DURATION_INVALID") return "Duration must be a whole number from 1 to 1440 minutes.";
    if (error.code === "SERVICE_PRICE_INVALID") return "Price must be a nonnegative number.";
    if (error.code === "SERVICE_DESCRIPTION_INVALID") return "Description must be 2000 characters or fewer.";
    if (error.code === "DURATION_LOCKED") return durationLockedExplanation;
    if (error.code === "ROLE_FORBIDDEN") return "Your business role does not allow service changes.";
    if (error.code === "SERVICE_NOT_FOUND") return "This service is no longer available. Refresh the list.";
    if (error.code === "INVALID_REQUEST" || error.code === "INVALID_RESPONSE") return "The service could not be verified. Refresh and try again.";
    if (error.status === 0 && error.code === "NETWORK_ERROR") return "Unable to reach ZUDE. Your changes were not confirmed. Check your connection and retry.";
    if (error.status >= 500) return "Unable to save service. Refresh the list before retrying.";
  }
  return safeMessage(error);
}
