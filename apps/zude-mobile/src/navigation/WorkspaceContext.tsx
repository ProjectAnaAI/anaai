import { createContext, useContext } from "react";
import type { Customer } from "../lib/appointments-api";
export type WorkspaceValue = {
  navigationLocked: boolean;
  setNavigationLocked: (locked: boolean) => void;
  // Opens the existing appointment composer with this customer preselected.
  startAppointment: (customer: Customer) => void;
  // Pure lookup of that handoff: it must match the business and the route token.
  appointmentCustomer: (businessId: string, token: string | undefined) => Customer | null;
};
export const WorkspaceContext = createContext<WorkspaceValue | null>(null);
export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error("Workspace is unavailable.");
  return context;
}
