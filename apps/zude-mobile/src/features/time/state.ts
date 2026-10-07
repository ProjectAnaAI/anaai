import { ZudeApiError } from "../../lib/api";
import type { BreakType, ClockState, TimeAction } from "../../lib/time-clock-api";

// Presentation rules for Time Clock and My Time. Every total comes from the
// server; the iPad only advances a running display between refreshes.

export const BREAK_OPTIONS: readonly { type: BreakType; label: string; minutes: number; detail: string }[] = [
  { type: "PAID", label: "Paid Break", minutes: 10, detail: "Paid time continues" },
  { type: "MEAL", label: "Meal Break", minutes: 30, detail: "Unpaid" },
];
export function breakLabel(type: BreakType) {
  return type === "PAID" ? "Paid Break" : "Meal Break";
}
export function stateLabel(state: ClockState) {
  return state === "WORKING" ? "Working" : state === "ON_PAID_BREAK" ? "On Paid Break" : state === "ON_MEAL_BREAK" ? "On Meal Break" : "Off the clock";
}
export function onBreak(state: ClockState) {
  return state === "ON_PAID_BREAK" || state === "ON_MEAL_BREAK";
}
// The one post-PIN routing decision, from the server's authoritative state.
// Not a calendar rule: OFF_CLOCK always needs a Clock In, WORKING (including
// overnight) always enters the workspace, and a break always returns to the
// Time Clock so it can be ended there. Nothing is inferred from role.
export type PostPinRoute = "clock-in" | "/" | "/time-clock";
export function postPinRoute(state: ClockState): PostPinRoute {
  if (state === "WORKING") return "/";
  if (state === "ON_PAID_BREAK" || state === "ON_MEAL_BREAK") return "/time-clock";
  return "clock-in";
}
export function formatNow(instant: number, timezone: string) {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(instant));
  } catch {
    return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(instant));
  }
}
// The contextual actions for each authoritative state.
export function actionsFor(state: ClockState): TimeAction[] {
  if (state === "OFF_CLOCK") return ["clock-in"];
  if (state === "WORKING") return ["break-start", "clock-out"];
  return ["break-end", "clock-out"];
}

export function formatDuration(ms: number) {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${String(minutes % 60).padStart(2, "0")}m` : `${minutes}m`;
}
// Server instants in the business timezone.
export function formatTime(value: string | null, timezone: string) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unavailable";
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(date);
  }
}
// A business-local calendar date (YYYY-MM-DD); never shifted by the iPad's zone.
export function formatDay(date: string, style: "short" | "long" = "short") {
  const [year, month, day] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: style, month: "short", day: "numeric" }).format(new Date(Date.UTC(year, month - 1, day)));
}
// Running display only: the server total plus local time since it was
// fetched. Never sent anywhere.
export function running(ms: number, fetchedAt: number, clock: number, active: boolean) {
  return active ? ms + Math.max(0, clock - fetchedAt) : ms;
}
export function overIntended(durationMs: number, intendedMinutes: number) {
  return Math.max(0, durationMs - intendedMinutes * 60_000);
}

// A retry of the same action after an unknown outcome reuses its request key,
// so the server records it at most once. A known outcome, or a different
// action, gets a fresh key.
export type PendingRequest = { intent: string; key: string };
export function requestKeyFor(pending: PendingRequest | null, intent: string, fresh: () => string): PendingRequest {
  return pending?.intent === intent ? pending : { intent, key: fresh() };
}
export function outcomeUnknown(error: unknown) {
  return !(error instanceof ZudeApiError) || error.status === 0 || error.status >= 500;
}

export function timeMessage(error: unknown) {
  if (error instanceof ZudeApiError) {
    if (error.code === "TIME_INVALID_TRANSITION") return "Your time clock status changed. ZUDE refreshed it — check your status and try again.";
    if (error.code === "TIME_REQUEST_CONFLICT") return "That request could not be matched. Refresh and try again.";
    if (error.code === "IDENTITY_REQUIRED" || error.code === "IDENTITY_UNAUTHORIZED") return "Your employee session ended. Unlock with your PIN to continue.";
    if (error.code === "DEVICE_INVALID" || error.code === "DEVICE_REVOKED") return "This iPad's registration is no longer valid.";
    if (error.code === "TIME_CONFIGURATION_UNAVAILABLE") return "The business timezone is not set up. Ask an owner to check business settings.";
    if (error.code === "CONFIGURATION_ERROR") return "ZUDE API configuration is unavailable. Contact your administrator.";
    if (error.code === "INVALID_REQUEST") return "ZUDE could not accept that request. Refresh and try again.";
    if (error.code === "INVALID_RESPONSE") return "ZUDE's reply could not be verified. Refresh to see your current status.";
    if (error.code === "NETWORK_ERROR") return "Unable to reach ZUDE. Your action was not confirmed — check your connection and try again.";
    if (error.status >= 500) return "The time clock is unavailable. Your action was not confirmed — try again.";
  }
  return "The time clock request did not complete. Refresh and try again.";
}
