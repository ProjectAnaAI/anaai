import { createContext, useContext, type ReactNode } from "react";
import type { Preview } from "../types/today";
export const WorkspaceContext = createContext<{ wide: boolean; compact: boolean; currentUser?: ReactNode; onPreview: (preview: Preview) => void } | null>(null);
export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error("Workspace is unavailable.");
  return context;
}
