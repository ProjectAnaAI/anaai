import { ZudeApiError } from "../../lib/api";
import type { BusinessRole } from "../../lib/today-api";
import type { EmployeeRole, TeamEmployee } from "../../lib/team-api";
import { safeMessage } from "../appointments/state";

// Presentation of server rules (server/handlers/team.ts, m04_write_employee).
// The server remains the authority; these only decide what to offer.
export function canManageTeam(role: BusinessRole) {
  return role === "owner" || role === "manager";
}
export function canManageEmployee(accountRole: BusinessRole, employeeRole: EmployeeRole) {
  return accountRole === "owner" || (accountRole === "manager" && employeeRole === "employee");
}
// Roles offered when creating or changing roles. Creating owner-role employees
// is an open product decision, so it is not offered here.
export function assignableRoles(accountRole: BusinessRole): EmployeeRole[] {
  return accountRole === "owner" ? ["employee", "manager"] : accountRole === "manager" ? ["employee"] : [];
}
export function roleLabel(role: EmployeeRole) {
  return role === "owner" ? "Owner" : role === "manager" ? "Manager" : "Employee";
}

export function validName(name: string) {
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed.length <= 100;
}
// Client-side convenience only; the server re-validates every PIN.
export function pinProblem(pin: string, confirm: string) {
  if (!/^\d{4,6}$/.test(pin)) return "Enter a 4–6 digit PIN.";
  if (pin !== confirm) return "The PIN confirmation does not match.";
  return null;
}
// Only changed fields are sent, so an unchanged role is never re-asserted.
export function employeeChanges(employee: TeamEmployee, draft: { name: string; role: EmployeeRole }) {
  const changes: { name?: string; role?: EmployeeRole } = {};
  if (draft.name.trim() !== employee.display_name) changes.name = draft.name.trim();
  if (draft.role !== employee.role) changes.role = draft.role;
  return changes;
}

export function teamMessage(error: unknown) {
  if (error instanceof ZudeApiError) {
    if (error.code === "PIN_IN_USE") return "That PIN is already assigned to another active employee. Choose a different PIN.";
    if (error.code === "ROLE_FORBIDDEN") return "Your business role does not allow this Team change.";
    if (error.code === "EMPLOYEE_NOT_FOUND") return "This employee is no longer available. Refresh Team.";
    if (error.code === "EMPLOYEE_INACTIVE") return "This employee is inactive, so their PIN cannot be reset.";
    if (error.code === "INVALID_REQUEST") return "Check the name, role and PIN, then try again.";
    if (error.code === "INVALID_RESPONSE") return "The Team change could not be verified. Refresh Team.";
    if (error.status === 0 && error.code === "NETWORK_ERROR") return "Unable to reach ZUDE. The change was not confirmed. Check your connection, refresh Team and retry.";
    if (error.status >= 500) return "Unable to update Team. Refresh Team, then retry.";
  }
  return safeMessage(error);
}
