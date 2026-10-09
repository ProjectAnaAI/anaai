import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { usePathname } from "expo-router";
import { ZudeApiError } from "../../lib/api";
import { getTimeClock, type TimeClockView } from "../../lib/time-clock-api";
import { defaultWorkspaceRoute } from "../../navigation/items";
import { useBusiness } from "../business/BusinessContext";
import { useEmployeeIdentity } from "../identity/EmployeeIdentityContext";
import { ShiftAccessContext, type AdmissionAction, type ShiftAccess, type ShiftActionTicket } from "./ShiftAccessContext";

type Read = {
  owner: object; scope: string; path: string; revision: number;
  status: "ready" | "error"; data?: TimeClockView; error?: unknown; at: number;
};
// One server-backed decision for the whole shared workspace and its clock screen.
// Route changes and explicit actions invalidate admission synchronously. Polls
// observe changes on mounted screens without resetting an unchanged WORKING UI.
// A poll failure withdraws admission; no local display timer can grant it.
export function ShiftGate({ children }: { children: ReactNode }) {
  const { business, userId } = useBusiness();
  const { sharedMode, identity, managementRole } = useEmployeeIdentity();
  const path = usePathname();
  const scope = sharedMode && identity
    ? `${userId}:${business.id}:${identity.employee.id}:${identity.expiresAt}:${managementRole}` : null;
  const live = useRef({ scope, owner: identity });
  useLayoutEffect(() => { live.current = { scope, owner: identity }; }, [scope, identity]);
  const [read, setRead] = useState<Read | null>(null);
  const [request, setRequest] = useState({ revision: 0, background: false });
  const [action, setAction] = useState<ShiftActionTicket | null>(null);
  const sequence = useRef(0);
  const activeRead = useRef<AbortController | null>(null);
  const activeAction = useRef<ShiftActionTicket | null>(null);
  const [mandatory, setMandatory] = useState<{ owner: object; action: AdmissionAction; message: string } | null>(null);
  const successfulAdmission = useRef<object | null>(null);
  const [landed, setLanded] = useState<object | null>(null);
  const current = read?.scope === scope && read.owner === identity ? read : null;
  const actionCurrent = action?.owner === identity && action?.scope === scope;
  const ready = !!current && current.path === path && current.status === "ready" &&
    (current.revision === request.revision || request.background) && !actionCurrent;
  const requiredAction = mandatory?.owner === identity ? mandatory.action : null;
  const working = ready && current?.data?.state === "WORKING" && !requiredAction;
  const landing = defaultWorkspaceRoute(managementRole);
  const needsLanding = landed !== identity;
  const allowed = scope === null || (working && (!needsLanding || path === landing));

  function refresh(background = false) {
    if (scope === null || live.current.scope !== scope || live.current.owner !== identity || actionCurrent) return;
    sequence.current++;
    activeRead.current?.abort();
    setRequest(value => ({ revision: value.revision + 1, background }));
  }

  useEffect(() => {
    if (scope === null || !identity || actionCurrent) return;
    const owner = identity;
    const controller = new AbortController();
    const version = ++sequence.current;
    activeRead.current = controller;
    const valid = () => !controller.signal.aborted && version === sequence.current &&
      live.current.scope === scope && live.current.owner === owner && !(activeAction.current?.owner === owner && activeAction.current.scope === scope);
    const timeout = setTimeout(() => {
      if (!valid()) return;
      controller.abort();
      setRead(previous => ({ owner, scope, path, revision: request.revision, status: "error",
        error: new ZudeApiError(0, "NETWORK_ERROR", "Unable to verify your time clock. Retry."),
        data: previous?.owner === owner ? previous.data : undefined, at: previous?.owner === owner ? previous.at : 0 }));
    }, 20_000);
    void getTimeClock(business.id, controller.signal).then(data => {
      if (!valid()) return;
      if (data.state !== "WORKING") {
        setMandatory({ owner, action: data.state === "OFF_CLOCK" ? "clock-in" : "break-end",
          message: data.state === "OFF_CLOCK" ? "Clock in to continue." : data.state === "ON_MEAL_BREAK" ? "End your meal break to continue." : "End your paid break to continue." });
        successfulAdmission.current = null;
      } else if (successfulAdmission.current === owner) {
        setMandatory(null);
        successfulAdmission.current = null;
      }
      if (data.state === "WORKING" && path === defaultWorkspaceRoute(managementRole)) setLanded(owner);
      setRead({ owner, scope, path, revision: request.revision, status: "ready", data, at: Date.now() });
    }, error => {
      if (valid()) setRead(previous => ({ owner, scope, path, revision: request.revision, status: "error", error,
        data: previous?.owner === owner ? previous.data : undefined, at: previous?.owner === owner ? previous.at : 0 }));
    }).finally(() => clearTimeout(timeout));
    return () => { controller.abort(); clearTimeout(timeout); };
  }, [scope, identity, path, request.revision, request.background, business.id, actionCurrent, managementRole]);

  // Remote changes are re-read, never inferred from elapsed break/display time.
  useEffect(() => {
    if (!scope || !identity || !ready || current?.revision !== request.revision) return;
    const timer = setTimeout(() => {
      if (live.current.owner !== identity || live.current.scope !== scope || activeAction.current?.owner === identity && activeAction.current.scope === scope) return;
      sequence.current++;
      setRequest(value => ({ revision: value.revision + 1, background: true }));
    }, 30_000);
    return () => clearTimeout(timer);
  }, [scope, identity, ready, current?.revision, request.revision]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", state => {
      if (state === "active" && scope && live.current.owner === identity && !(activeAction.current?.owner === identity && activeAction.current.scope === scope)) {
        sequence.current++;
        activeRead.current?.abort();
        setRequest(value => ({ revision: value.revision + 1, background: false }));
      }
    });
    return () => subscription.remove();
  }, [scope, identity]);

  useEffect(() => () => { sequence.current++; activeRead.current?.abort(); }, []);

  const access: ShiftAccess = {
    managed: scope !== null, allowed, data: current?.data, error: current?.revision === request.revision && current.path === path ? current.error : undefined,
    loading: scope !== null && (!current || current.path !== path ||
      current.revision !== request.revision && !request.background || !!actionCurrent), fetchedAt: current?.at ?? 0,
    target: scope === null ? null : current?.status === "error" || requiredAction || ready && !working
      ? "/time-clock" : working && needsLanding ? landing : null,
    requiredAction, requiredMessage: mandatory?.owner === identity ? mandatory.message : undefined,
    refresh: () => refresh(),
    beginAction() {
      if (!scope || !identity || live.current.owner !== identity || live.current.scope !== scope || !ready || activeAction.current?.owner === identity && activeAction.current.scope === scope) return null;
      const ticket = { owner: identity, scope };
      sequence.current++;
      activeRead.current?.abort();
      activeAction.current = ticket;
      setAction(ticket);
      return ticket;
    },
    finishAction(ticket, action, result) {
      if (activeAction.current !== ticket || live.current.owner !== ticket.owner || live.current.scope !== ticket.scope) return;
      if (result && (action === "clock-in" || action === "break-end") && result.state === "WORKING") {
        successfulAdmission.current = ticket.owner;
        setLanded(null);
      }
      activeAction.current = null;
      setAction(null);
      sequence.current++;
      // Mutation responses can update neither admission nor its source of truth:
      // only this subsequent GET may confirm WORKING and release the gate.
      setRequest(value => ({ revision: value.revision + 1, background: false }));
    },
  };
  // AppShell always mounts its navigator, but never renders an operational Slot
  // without this decision. This also permits safe cold/deep-link replacement.
  return <ShiftAccessContext.Provider value={access}>{children}</ShiftAccessContext.Provider>;
}
