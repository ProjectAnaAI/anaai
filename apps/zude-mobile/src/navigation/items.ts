import type { BusinessRole } from "../lib/today-api";
import type { IconName } from "../components/ui";
export type CapabilityState = "AVAILABLE_NATIVE" | "EXISTING_WEB_CAPABILITY" | "PLANNED_NATIVE" | "ROLE_RESTRICTED" | "PHASE_2";
export type NativeRoute = "/reports" | "/audit" | "/time-issues" | "/timesheets" | "/working" | "/" | "/appointments" | "/customers" | "/services" | "/device" | "/team" | "/devices" | "/time-clock" | "/my-time";
type Destination =
  | { state: "AVAILABLE_NATIVE"; route: NativeRoute; webRoute?: string }
  | { state: Exclude<CapabilityState, "AVAILABLE_NATIVE">; route?: never; webRoute?: string };
// `permission`: on a shared device, the PIN-verified employee must also hold it.
export type NavItem = Destination & { label: string; icon: IconName; roles?: readonly BusinessRole[]; permission?: string };
export const navigationGroups: { title: string; icon: IconName; items: NavItem[] }[] = [
  { title: "Operations", icon: "grid", items: [
    { label: "Today", icon: "calendar", state: "AVAILABLE_NATIVE", route: "/", webRoute: "/dashboard" },
    { label: "Appointments", icon: "calendar", state: "AVAILABLE_NATIVE", route: "/appointments", webRoute: "/appointments" },
    { label: "Customers", icon: "users", state: "AVAILABLE_NATIVE", route: "/customers", webRoute: "/customers" },
    { label: "Services", icon: "scissors", state: "AVAILABLE_NATIVE", route: "/services", webRoute: "/services" },
  ] },
  // Every PIN role (employee, manager, owner) uses their own clock. The time
  // API derives the employee from the device + PIN session only.
  { title: "My Work", icon: "clock", items: [
    { label: "Time Clock", icon: "clock", state: "AVAILABLE_NATIVE", route: "/time-clock" },
    { label: "My Time", icon: "watch", state: "AVAILABLE_NATIVE", route: "/my-time" },
  ] },
  // Presentation filter only; the Team API enforces owner/manager authority.
  { title: "Manage", icon: "briefcase", items: [
    { label: "Who’s Working", icon: "users", state: "AVAILABLE_NATIVE", route: "/working", roles: ["owner", "manager"], permission: "team:manage-employees" },
    { label: "Team", icon: "user-check", state: "AVAILABLE_NATIVE", route: "/team", roles: ["owner", "manager"], permission: "team:manage-employees" },
    { label: "Timesheets", icon: "clipboard", state: "AVAILABLE_NATIVE", route: "/timesheets", roles: ["owner", "manager"], permission: "team:manage-employees" },
    { label: "Reported Issues", icon: "flag", state: "AVAILABLE_NATIVE", route: "/time-issues", roles: ["owner", "manager"], permission: "team:manage-employees" },
    { label: "Audit History", icon: "list", state: "AVAILABLE_NATIVE", route: "/audit", roles: ["owner", "manager"], permission: "team:manage-employees" },
    { label: "Reports", icon: "bar-chart-2", state: "AVAILABLE_NATIVE", route: "/reports", roles: ["owner", "manager"], permission: "team:manage-employees" },
    ...[
      { label: "Corrections", icon: "edit-3", state: "ROLE_RESTRICTED" },
      { label: "Analytics", icon: "trending-up", state: "EXISTING_WEB_CAPABILITY", webRoute: "/analytics" },
    ].map((item) => ({ ...item, state: item.state as Exclude<CapabilityState, "AVAILABLE_NATIVE">, icon: item.icon as IconName, roles: ["owner", "manager"] as const })),
  ] },
  { title: "Ana AI", icon: "mic", items: [
    { label: "Voice Assistant", icon: "mic", state: "PHASE_2", webRoute: "/ai" },
    // The web Calls route is itself unavailable; it is not a working history capability.
    { label: "Calls", icon: "phone", state: "PHASE_2" },
    { label: "Knowledge", icon: "book-open", state: "PHASE_2", webRoute: "/knowledge" },
  ] },
  { title: "Business", icon: "home", items: [
    { label: "Business & Availability", icon: "sliders", state: "EXISTING_WEB_CAPABILITY", webRoute: "/business" },
    { label: "Settings", icon: "settings", state: "EXISTING_WEB_CAPABILITY", webRoute: "/settings" },
    { label: "Registered Devices", icon: "tablet", state: "AVAILABLE_NATIVE", route: "/devices", roles: ["owner", "manager"], permission: "devices:manage" },
  ] },
  { title: "System", icon: "lock", items: [{ label: "Device & PIN", icon: "lock", state: "AVAILABLE_NATIVE", route: "/device" }, { label: "Lock", icon: "lock", state: "AVAILABLE_NATIVE", route: "/device" }] },
];
export function activeNavigationLabel(pathname: string) {
  return pathname === "/reports" ? "Reports" : pathname === "/audit" ? "Audit History" : pathname === "/time-issues" ? "Reported Issues" : pathname === "/timesheets" ? "Timesheets" : pathname === "/working" ? "Who’s Working" : pathname === "/time-clock" ? "Time Clock" : pathname === "/my-time" ? "My Time" : pathname === "/devices" ? "Registered Devices" : pathname === "/team" ? "Team" : pathname === "/device" ? "Device & PIN" : pathname === "/appointments" ? "Appointments" : pathname === "/customers" ? "Customers" : pathname === "/services" ? "Services" : "Today";
}
export function capabilityLabel(state: CapabilityState) {
  return state === "AVAILABLE_NATIVE" ? "" : state === "EXISTING_WEB_CAPABILITY" ? "Web" : state === "PHASE_2" ? "Phase 2" : "Later";
}
// Current Supabase membership uses "staff"; future employee identity is separate.
// This only filters presentation. It never grants API access or implements RBAC.
export function visibleNavigation(role: BusinessRole, sharedDevicePermissions: readonly string[] | null = null) {
  // Presentation only. On a shared device (permissions given) management
  // destinations also need the PIN-verified employee's permission.
  return navigationGroups.map((group) => ({ ...group,
    items: group.items.filter((item) => (!item.roles || item.roles.includes(role)) &&
      (!item.permission || sharedDevicePermissions === null || sharedDevicePermissions.includes(item.permission))),
  })).filter((group) => group.items.length);
}
