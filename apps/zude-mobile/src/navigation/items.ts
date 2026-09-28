import type { BusinessRole } from "../lib/today-api";
import type { IconName } from "../components/ui";
export type CapabilityState = "AVAILABLE_NATIVE" | "EXISTING_WEB_CAPABILITY" | "PLANNED_NATIVE" | "ROLE_RESTRICTED" | "PHASE_2";
type Destination =
  | { state: "AVAILABLE_NATIVE"; route: "/" | "/appointments"; webRoute?: string }
  | { state: Exclude<CapabilityState, "AVAILABLE_NATIVE">; route?: never; webRoute?: string };
export type NavItem = Destination & { label: string; icon: IconName; roles?: readonly BusinessRole[] };
export const navigationGroups: { title: string; icon: IconName; items: NavItem[] }[] = [
  { title: "Operations", icon: "grid", items: [
    { label: "Today", icon: "calendar", state: "AVAILABLE_NATIVE", route: "/", webRoute: "/dashboard" },
    { label: "Appointments", icon: "calendar", state: "AVAILABLE_NATIVE", route: "/appointments", webRoute: "/appointments" },
    { label: "Customers", icon: "users", state: "EXISTING_WEB_CAPABILITY", webRoute: "/customers" },
    { label: "Services", icon: "scissors", state: "EXISTING_WEB_CAPABILITY", webRoute: "/services" },
  ] },
  { title: "My Work", icon: "clock", items: [
    { label: "Time Clock", icon: "clock", state: "PLANNED_NATIVE" },
    { label: "My Time", icon: "watch", state: "PLANNED_NATIVE" },
  ] },
  { title: "Manage", icon: "briefcase", items: [
    { label: "Team", icon: "user-check", state: "ROLE_RESTRICTED" },
    { label: "Timesheets", icon: "clipboard", state: "ROLE_RESTRICTED" },
    { label: "Corrections", icon: "edit-3", state: "ROLE_RESTRICTED" },
    { label: "Reports", icon: "bar-chart-2", state: "ROLE_RESTRICTED" },
    { label: "Analytics", icon: "trending-up", state: "EXISTING_WEB_CAPABILITY", webRoute: "/analytics" },
  ].map((item) => ({ ...item, state: item.state as Exclude<CapabilityState, "AVAILABLE_NATIVE">, icon: item.icon as IconName, roles: ["owner", "manager"] as const })) },
  { title: "Ana AI", icon: "mic", items: [
    { label: "Voice Assistant", icon: "mic", state: "PHASE_2", webRoute: "/ai" },
    // The web Calls route is itself unavailable; it is not a working history capability.
    { label: "Calls", icon: "phone", state: "PHASE_2" },
    { label: "Knowledge", icon: "book-open", state: "PHASE_2", webRoute: "/knowledge" },
  ] },
  { title: "Business", icon: "home", items: [
    { label: "Business & Availability", icon: "sliders", state: "EXISTING_WEB_CAPABILITY", webRoute: "/business" },
    { label: "Settings", icon: "settings", state: "EXISTING_WEB_CAPABILITY", webRoute: "/settings" },
  ] },
  { title: "System", icon: "lock", items: [{ label: "Lock", icon: "lock", state: "PLANNED_NATIVE" }] },
];
export function capabilityLabel(state: CapabilityState) {
  return state === "AVAILABLE_NATIVE" ? "" : state === "EXISTING_WEB_CAPABILITY" ? "Web" : state === "PHASE_2" ? "Phase 2" : "Later";
}
// Current Supabase membership uses "staff"; future employee identity is separate.
// This only filters presentation. It never grants API access or implements RBAC.
export function visibleNavigation(role: BusinessRole) {
  return navigationGroups.map((group) => ({ ...group,
    items: group.items.filter((item) => !item.roles || item.roles.includes(role)),
  })).filter((group) => group.items.length);
}
