import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { randomUUID } from "expo-crypto";
import { Badge, Button, styles as ui } from "../../components/ui";
import { Feedback, PaneTitle, SplitWorkspace, WorkspaceHeader, workspaceStyles as ws } from "../../components/workspace";
import { getTimeClock, recordTimeAction, type BreakType, type TimeAction, type TimeClockView } from "../../lib/time-clock-api";
import { theme as t } from "../../theme/tokens";
import { useBusiness } from "../business/BusinessContext";
import { useEmployeeIdentity } from "../identity/EmployeeIdentityContext";
import { Notice } from "../appointments/controls";
import { BREAK_OPTIONS, actionsFor, breakLabel, formatDuration, formatTime, onBreak, outcomeUnknown, overIntended, requestKeyFor, running, stateLabel, timeMessage, type PendingRequest } from "./state";
import { useShiftAccess, type ShiftActionTicket } from "./ShiftAccessContext";
import { useTimeResource } from "./useTimeResource";

const DONE: Record<TimeAction, string> = {
  "clock-in": "You are clocked in.",
  "break-start": "Your break has started.",
  "break-end": "Your break has ended. You are working.",
  "clock-out": "You are clocked out.",
};

// "My clock" only: the PIN-verified employee on this registered device. PIN
// unlock never clocks in; Lock, background and sign-out never clock out.
export function TimeClockScreen() {
  const { business, userId } = useBusiness();
  const { sharedMode, identity, lock } = useEmployeeIdentity();
  const employee = sharedMode ? identity?.employee ?? null : null;
  const key = employee ? `${userId}:${business.id}:${employee.id}:${identity?.expiresAt}:time-clock` : null;
  const admission = useShiftAccess();
  const localClock = useTimeResource(admission.managed ? null : key, (signal) => getTimeClock(business.id, signal));
  const clock = admission.managed ? admission : localClock;
  const owner = useRef(key);
  useLayoutEffect(() => { owner.current = key; }, [key]);
  const [busy, setBusy] = useState<TimeAction | null>(null);
  const [chooser, setChooser] = useState(false);
  const [confirmOut, setConfirmOut] = useState(false);
  const [notice, setNotice] = useState<{ message: string; error?: boolean } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const submitting = useRef(false);
  const pending = useRef<PendingRequest | null>(null);
  const alive = useRef(true);
  const view = clock.data;
  const live = !!view && view.state !== "OFF_CLOCK";
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // Advances the running display only; totals stay the server's.
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, [live]);

  async function act(action: TimeAction, breakType?: BreakType) {
    if (submitting.current || !alive.current || owner.current !== key) return;
    const ticket: ShiftActionTicket | null = admission.managed ? admission.beginAction() : null;
    if (admission.managed && !ticket) return;
    submitting.current = true; setBusy(action); setNotice(null);
    const request = requestKeyFor(pending.current, `${action}:${breakType ?? ""}`, randomUUID);
    pending.current = request;
    try {
      const result = await recordTimeAction(business.id, action, request.key, breakType);
      if (!alive.current || owner.current !== key) return;
      pending.current = null;
      // Shared-device privacy: once the server confirms OFF_CLOCK, end this
      // employee's PIN session and return to the universal PIN keypad. The
      // device stays registered and the account stays signed in; Lock writes
      // no time events.
      if (action === "clock-out" && result.state === "OFF_CLOCK") {
        void lock("You are clocked out. Enter your PIN to continue.");
        return;
      }
      if (!alive.current) return;
      if (ticket) admission.finishAction(ticket, action, result);
      else localClock.replace(result); setNow(Date.now()); setChooser(false); setConfirmOut(false);
      setNotice({ message: DONE[action] });
    } catch (error) {
      if (!alive.current || owner.current !== key) return;
      if (ticket) admission.finishAction(ticket, action);
      // Keep the key only when the server may have recorded the action.
      if (!outcomeUnknown(error)) pending.current = null;
      if (!alive.current) return;
      setNotice({ message: timeMessage(error), error: true });
      if (!ticket) clock.refresh();
    } finally {
      submitting.current = false;
      if (alive.current) setBusy(null);
    }
  }

  const header = <WorkspaceHeader title="Time Clock" business={business.name} subtitle={employee ? employee.name : undefined}
    action={view ? <Button label="Refresh" icon="refresh-cw" secondary disabled={!!busy || clock.loading} onPress={clock.refresh} /> : undefined} />;
  if (!employee) return <View style={ws.page}>{header}
    <Feedback title="Unlock with your employee PIN" detail={sharedMode
      ? "Time Clock records time for the employee unlocked on this iPad."
      : "Time Clock works on a registered shared ZUDE device. Register this iPad in Device & PIN, then unlock with your employee PIN. An account sign-in never clocks time."} />
  </View>;
  if (!view) return <View style={ws.page}>{header}
    {clock.error ? <Feedback kind="error" title="Time Clock is unavailable" detail={timeMessage(clock.error)} retry={clock.refresh} />
      : <Feedback kind="loading" title="Loading your time clock" />}
  </View>;
  return <View style={ws.page}>{header}
    <SplitWorkspace main={<StatusPanel view={view} fetchedAt={clock.fetchedAt} now={now} busy={busy} chooser={chooser} confirmOut={confirmOut} notice={notice}
      stale={clock.error ? timeMessage(clock.error) : ""}
      checking={clock.loading || !!clock.error} requiredMessage={admission.requiredMessage} requiredAction={admission.managed ? admission.requiredAction : null}
      onAction={(action) => {
        if (busy || clock.loading) return;
        setNotice(null);
        if (action === "break-start") { setChooser(true); setConfirmOut(false); return; }
        if (action === "clock-out") { setConfirmOut(true); setChooser(false); return; }
        void act(action);
      }}
      onBreak={(type) => void act("break-start", type)} onCancelBreak={() => setChooser(false)}
      onClockOut={() => void act("clock-out")} onCancelClockOut={() => setConfirmOut(false)} />}
      rail={<TodayRail view={view} fetchedAt={clock.fetchedAt} now={now} />} />
  </View>;
}

function StatusPanel({ view, fetchedAt, now, busy, chooser, confirmOut, notice, stale, checking, requiredAction, requiredMessage, onAction, onBreak: chooseBreak, onCancelBreak, onClockOut, onCancelClockOut }: {
  view: TimeClockView; fetchedAt: number; now: number; busy: TimeAction | null; chooser: boolean; confirmOut: boolean;
  notice: { message: string; error?: boolean } | null; stale: string; checking: boolean; requiredAction: "clock-in" | "break-end" | null; requiredMessage?: string;
  onAction: (action: TimeAction) => void; onBreak: (type: BreakType) => void; onCancelBreak: () => void; onClockOut: () => void; onCancelClockOut: () => void;
}) {
  const shift = view.shift;
  const current = shift?.break ?? null;
  const breakMs = current ? running(current.durationMs, fetchedAt, now, true) : 0;
  const over = current ? overIntended(breakMs, current.intendedMinutes) : 0;
  const tone = view.state === "WORKING" ? "success" : onBreak(view.state) ? "warning" : "neutral";
  return <View style={s.panel}>
    <PaneTitle title="Your status" />
    <View style={s.identity}>
      <Text accessibilityRole="header" style={s.name}>{view.employee.name}</Text>
      <Badge label={stateLabel(view.state)} tone={tone} />
    </View>
    {requiredAction && <Text accessibilityLiveRegion="polite" style={ui.body}>{requiredMessage ?? (requiredAction === "clock-in" ? "Clock in to continue." : view.state === "ON_MEAL_BREAK" ? "End your meal break to continue." : "End your paid break to continue.")}</Text>}
    {!!stale && <Notice message={`Showing your last confirmed status. ${stale}`} error />}
    {shift ? <View style={s.metrics}>
      <Metric label="Clocked in" value={formatTime(shift.clockInAt, view.timezone)} />
      <Metric label="Shift elapsed" value={formatDuration(running(shift.elapsedMs, fetchedAt, now, true))} />
      <Metric label="Shift worked" value={formatDuration(running(shift.workedMs, fetchedAt, now, view.state !== "ON_MEAL_BREAK"))} />
    </View> : <Text style={ui.body}>You are not clocked in. Unlocking ZUDE with your PIN does not clock you in.</Text>}
    {current && <View style={[s.breakBox, over > 0 && s.over]} accessibilityLiveRegion="polite">
      <Text style={ui.strong}>{breakLabel(current.type)} · {current.intendedMinutes} minutes intended</Text>
      <Text style={ui.body}>Started {formatTime(current.startedAt, view.timezone)} · {formatDuration(breakMs)} so far · {current.type === "PAID" ? "paid" : "unpaid"}</Text>
      {over > 0 && <Text style={[ui.body, { color: t.colors.amber }]}>{formatDuration(over)} over the intended {current.intendedMinutes} minutes. Your break continues until you end it.</Text>}
    </View>}
    {!!notice && <Notice message={notice.message} error={notice.error} success={!notice.error} />}
    {chooser ? <View style={s.choice}>
      <Text style={ui.strong}>Choose your break</Text>
      {BREAK_OPTIONS.map((option) => <Pressable key={option.type} accessibilityRole="button" accessibilityLabel={`${option.label}, ${option.minutes} minutes, ${option.detail}`}
        accessibilityState={{ disabled: !!busy, busy: busy === "break-start" }} disabled={!!busy || checking} onPress={() => chooseBreak(option.type)}
        style={({ pressed }) => [s.option, !!busy && ui.disabled, pressed && ui.pressed]}>
        <View style={ui.grow}><Text style={ui.strong}>{option.label}</Text><Text style={ui.meta}>{option.minutes} minutes · {option.detail}</Text></View>
      </Pressable>)}
      <Button label="Cancel" secondary disabled={!!busy || checking} onPress={onCancelBreak} />
    </View> : confirmOut ? <View style={s.choice}>
      <Text style={ui.strong}>Clock out now?</Text>
      {current && <Text style={ui.body}>This also ends your {breakLabel(current.type)}.</Text>}
      <Button label="Yes, Clock Out" busy={busy === "clock-out"} disabled={!!busy || checking} onPress={onClockOut} />
      <Button label="Stay Clocked In" secondary disabled={!!busy || checking} onPress={onCancelClockOut} />
    </View> : <View style={s.actions}>
      {(requiredAction && view.state === "WORKING" ? [requiredAction] : actionsFor(view.state)).map((action) => <View key={action} style={s.action}>
        {action === "clock-in" ? <Button label="Clock In" icon="log-in" busy={busy === action} disabled={!!busy || checking} onPress={() => onAction(action)} />
          : action === "break-start" ? <Button label="Start Break" icon="coffee" secondary busy={busy === action} disabled={!!busy || checking} onPress={() => onAction(action)} />
          : action === "break-end" ? <Button label="End Break" icon="play" busy={busy === action} disabled={!!busy || checking} onPress={() => onAction(action)} />
          : <Button label="Clock Out" icon="log-out" secondary busy={busy === action} disabled={!!busy || checking} onPress={() => onAction(action)} />}
      </View>)}
    </View>}
    <Text style={ui.meta}>Times are recorded by ZUDE, not this iPad. Locking ZUDE does not clock you out.</Text>
  </View>;
}
function TodayRail({ view, fetchedAt, now }: { view: TimeClockView; fetchedAt: number; now: number }) {
  return <View style={ws.railSection}>
    <PaneTitle title="Today" />
    <Metric label="Worked" value={formatDuration(running(view.today.workedMs, fetchedAt, now, view.state === "WORKING" || view.state === "ON_PAID_BREAK"))} />
    <Metric label="Paid breaks" value={formatDuration(running(view.today.paidBreakMs, fetchedAt, now, view.state === "ON_PAID_BREAK"))} />
    <Metric label="Meal breaks" value={formatDuration(running(view.today.mealBreakMs, fetchedAt, now, view.state === "ON_MEAL_BREAK"))} />
    <Text style={ui.meta}>Worked time includes paid breaks and excludes meal breaks.</Text>
  </View>;
}
function Metric({ label, value }: { label: string; value: string }) {
  return <View style={s.metric}><Text style={ui.meta}>{label}</Text><Text style={s.metricValue}>{value}</Text></View>;
}
const s = StyleSheet.create({
  panel: { gap: t.space.lg, paddingBottom: t.space.xl, maxWidth: 640 },
  identity: { gap: t.space.sm },
  name: { fontSize: t.font.title, fontWeight: "700", color: t.colors.text, letterSpacing: -0.5 },
  metrics: { flexDirection: "row", flexWrap: "wrap", gap: t.space.lg },
  metric: { minWidth: 120, gap: 2 },
  metricValue: { fontSize: t.font.section, fontWeight: "600", color: t.colors.text },
  breakBox: { gap: t.space.xs, padding: t.space.md, borderWidth: t.border, borderColor: t.colors.border, borderRadius: t.radius.sm, backgroundColor: t.colors.amberSoft },
  over: { borderColor: t.colors.amber },
  choice: { gap: t.space.sm },
  option: { minHeight: 56, flexDirection: "row", alignItems: "center", padding: t.space.md, borderWidth: t.border, borderColor: t.colors.border, borderRadius: t.radius.sm, backgroundColor: t.colors.surface },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: t.space.md },
  action: { minWidth: 160, flexGrow: 1 },
});
