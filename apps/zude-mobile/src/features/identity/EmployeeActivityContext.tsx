import { createContext, useContext } from "react";

// Shared input primitives may report real edits without importing identity or
// owning a timer. Outside the employee provider (e.g. Login), this is a no-op.
export const EmployeeActivityContext = createContext<() => boolean>(() => true);
export function useEmployeeActivity() { return useContext(EmployeeActivityContext); }
