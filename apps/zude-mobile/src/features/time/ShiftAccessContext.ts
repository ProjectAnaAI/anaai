import { createContext, useContext } from "react";
import type { NativeRoute } from "../../navigation/items";
import type { TimeAction, TimeClockView } from "../../lib/time-clock-api";

export type ShiftActionTicket = { owner: object; scope: string };
export type AdmissionAction = "clock-in" | "break-end";
export type ShiftAccess = {
  managed: boolean;
  allowed: boolean;
  data?: TimeClockView;
  error?: unknown;
  loading: boolean;
  fetchedAt: number;
  target: NativeRoute | null;
  requiredAction: AdmissionAction | null;
  requiredMessage?: string;
  refresh: () => void;
  beginAction: () => ShiftActionTicket | null;
  finishAction: (ticket: ShiftActionTicket, action: TimeAction, result?: TimeClockView) => void;
};
// Account-only installations keep their existing setup/personal workspace.
const unmanaged: ShiftAccess = {
  managed: false, allowed: true, loading: false, fetchedAt: 0, target: null,
  requiredAction: null, refresh() {}, beginAction: () => null, finishAction() {},
};
export const ShiftAccessContext = createContext<ShiftAccess>(unmanaged);
export function useShiftAccess() { return useContext(ShiftAccessContext); }
