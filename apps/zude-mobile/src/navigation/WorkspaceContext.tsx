import { createContext, useContext } from "react";
export const WorkspaceContext = createContext<{ navigationLocked: boolean; setNavigationLocked: (locked: boolean) => void } | null>(null);
export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error("Workspace is unavailable.");
  return context;
}
