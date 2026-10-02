import { apiGet, apiWrite, ZudeApiError } from "./api";
import { operationalRequest } from "./operational-identity";

export type EmployeeRole = "employee" | "manager" | "owner";
export type TeamEmployee = { id: string; display_name: string; role: EmployeeRole; is_active: boolean };
export type TeamStatus = "active" | "inactive";

function invalid(): never { throw new ZudeApiError(0, "INVALID_RESPONSE", "Unable to verify Team data."); }
// Only public fields are kept, so PIN material could never reach UI state
// even if a response carried it.
function employee(value: unknown): TeamEmployee {
  const row = value as Record<string, unknown> | null;
  if (!row || typeof row.id !== "string" || typeof row.display_name !== "string" || typeof row.is_active !== "boolean" ||
      !["employee", "manager", "owner"].includes(row.role as string)) invalid();
  return { id: row.id, display_name: row.display_name, role: row.role as EmployeeRole, is_active: row.is_active };
}
function scoped<T extends { businessId?: unknown }>(data: T, businessId: string) {
  if (data.businessId !== businessId) invalid();
  return data;
}

// Account authority (business membership) is verified by the server; on a
// shared device the PIN-verified employee further narrows it.
export async function getTeam(businessId: string, status: TeamStatus, signal: AbortSignal) {
  const data = scoped(await operationalRequest(businessId, (headers) =>
    apiGet<{ businessId: string; employees: unknown[] }>(`/api/team?status=${status}`, { businessId, signal, headers })), businessId);
  if (!Array.isArray(data.employees)) invalid();
  const employees = data.employees.map(employee);
  if (employees.some((row) => row.is_active !== (status === "active"))) invalid();
  return employees;
}
async function write(businessId: string, userId: string, path: string, method: "POST" | "PATCH", body: Record<string, unknown>) {
  const data = scoped(await operationalRequest(businessId, (headers) =>
    apiWrite<{ businessId: string; employee: unknown }>(path, body, { businessId, expectedUserId: userId, method, headers })), businessId);
  return employee(data.employee);
}
const employeePath = (id: string) => `/api/team/${encodeURIComponent(id)}`;

export function createEmployee(businessId: string, userId: string, input: { name: string; role: EmployeeRole; pin: string }) {
  return write(businessId, userId, "/api/team", "POST", { name: input.name.trim(), role: input.role, pin: input.pin });
}
export async function updateEmployee(businessId: string, userId: string, id: string, changes: { name?: string; role?: EmployeeRole }) {
  const result = await write(businessId, userId, employeePath(id), "PATCH", changes);
  if (result.id !== id) invalid();
  return result;
}
export async function deactivateEmployee(businessId: string, userId: string, id: string) {
  const result = await write(businessId, userId, employeePath(id), "PATCH", { isActive: false });
  if (result.id !== id || result.is_active) invalid();
  return result;
}
// The existing Team contract: reactivation always sets a fresh PIN; the old
// PIN is never restored (server/handlers/team.ts, m04_write_employee).
export async function reactivateEmployee(businessId: string, userId: string, id: string, pin: string) {
  const result = await write(businessId, userId, employeePath(id), "PATCH", { isActive: true, pin });
  if (result.id !== id || !result.is_active) invalid();
  return result;
}
export async function resetEmployeePin(businessId: string, userId: string, id: string, pin: string) {
  const result = await write(businessId, userId, `${employeePath(id)}/pin`, "POST", { pin });
  if (result.id !== id) invalid();
  return result;
}
