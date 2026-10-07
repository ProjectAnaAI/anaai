import { useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { randomUUID } from "expo-crypto";
import { Badge, Button, styles as ui } from "../../components/ui";
import { Brand, Feedback, PaneTitle } from "../../components/workspace";
import { ZudeApiError } from "../../lib/api";
import { getMyTime, recordTimeAction, type TimeClockView } from "../../lib/time-clock-api";
import { theme as t } from "../../theme/tokens";
import { workspaceLayout } from "../../theme/layout";
import { useBusiness } from "../business/BusinessContext";
import { Notice } from "../appointments/controls";
import { formatDay, formatDuration, formatNow, outcomeUnknown, requestKeyFor, timeMessage, type PendingRequest } from "./state";
import { useTimeResource } from "./useTimeResource";

// Shown after a PIN unlock while the employee is OFF_CLOCK. The workspace is
// not reachable from here; only a server-confirmed Clock In (or Lock) leaves.
// The week summary is the employee's own current week from My Time.
export function ClockInLanding({ view, onDecision, onRefresh, onLock }: {
  view: TimeClockView; onDecision: (view: TimeClockView) => void; onRefresh: () => void; onLock: () => void;
}) {
  const { business } = useBusiness();
  const { width, height, fontScale } = useWindowDimensions();
  const { split } = workspaceLayout(width, height, fontScale);
  const week = useTimeResource(`${business.id}:${view.employee.id}:clock-in-landing`, (signal) => getMyTime(business.id, signal));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const submitting = useRef(false);
  const pending = useRef<PendingRequest | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  // One Clock In at a time. An unknown outcome keeps its request key, so the
  // retry is recorded at most once. The server's returned state decides what
  // happens next; WORKING is never assumed.
  async function clockIn() {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setNotice("");
    const request = requestKeyFor(pending.current, "clock-in:", randomUUID);
    pending.current = request;
    try {
      const result = await recordTimeAction(business.id, "clock-in", request.key);
      pending.current = null;
      if (alive.current) onDecision(result);
    } catch (error) {
      if (!outcomeUnknown(error)) pending.current = null;
      if (!alive.current) return;
      setNotice(timeMessage(error));
      // The status changed elsewhere (for example on another iPad): reconcile.
      if (error instanceof ZudeApiError && error.code === "TIME_INVALID_TRANSITION") onRefresh();
    } finally {
      submitting.current = false;
      if (alive.current) setBusy(false);
    }
  }

  const summary = week.data;
  const days = summary ? [...summary.days].reverse() : [];
  return <View style={[s.page, split && s.row]}>
    <ScrollView style={[s.identity, split && s.identitySplit]} contentContainerStyle={s.identityContent}>
      <Brand compact />
      <View style={s.who}>
        <Text style={s.date}>{formatNow(now, view.timezone)}</Text>
        <Text accessibilityRole="header" style={s.name}>{view.employee.name}</Text>
        <Badge label="Not clocked in" />
      </View>
      <Text style={s.lead}>Clock in to start working. Unlocking ZUDE with your PIN does not clock you in.</Text>
      {!!notice && <Notice message={notice} error />}
      <Button label="Clock In" icon="log-in" busy={busy} disabled={busy} onPress={() => void clockIn()} />
      {!!notice && <Button label="Check Status" icon="refresh-cw" secondary disabled={busy} onPress={onRefresh} />}
      <Button label="Lock" icon="lock" secondary disabled={busy} onPress={onLock} />
    </ScrollView>
    <ScrollView style={s.week} contentContainerStyle={s.weekContent}>
      <PaneTitle title="This Week" detail={summary ? `${formatDay(summary.week.startDate)} – ${formatDay(summary.week.endDate)}` : undefined} />
      {summary ? <>
        <View style={s.total}><Text style={ui.meta}>Worked this week</Text><Text style={s.totalValue}>{formatDuration(summary.week.workedMs)}</Text></View>
        <Text style={ui.meta}>Paid breaks {formatDuration(summary.week.paidBreakMs)} · Meal breaks {formatDuration(summary.week.mealBreakMs)}</Text>
        {days.map((day) => <View key={day.date} style={s.day}>
          <Text style={[ui.body, ui.grow]}>{formatDay(day.date, "long")}{day.date === summary.week.today ? " · Today" : ""}</Text>
          <Text style={ui.strong}>{day.shifts.length ? formatDuration(day.workedMs) : "—"}</Text>
        </View>)}
        {!summary.days.some((day) => day.shifts.length) && <Text style={ui.meta}>No time recorded this week yet.</Text>}
      </> : week.error ? <Feedback kind="error" title="This week is unavailable" detail={timeMessage(week.error)} retry={week.refresh} />
        : <Feedback kind="loading" title="Loading this week" />}
    </ScrollView>
  </View>;
}
const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: t.colors.workspace },
  row: { flexDirection: "row" },
  identity: { flexGrow: 0, backgroundColor: t.colors.shell },
  identitySplit: { width: 400, flexGrow: 0 },
  identityContent: { padding: t.space.xl, gap: t.space.lg },
  who: { gap: t.space.sm, paddingTop: t.space.lg },
  date: { color: t.colors.shellMuted, fontSize: t.font.body },
  name: { color: t.colors.surface, fontSize: 32, fontWeight: "700", letterSpacing: -0.5 },
  lead: { color: t.colors.shellText, fontSize: t.font.body, lineHeight: 21 },
  week: { flex: 1, minWidth: 0 },
  weekContent: { padding: t.space.xl, gap: t.space.md, maxWidth: 640, width: "100%" },
  total: { gap: 2 },
  totalValue: { fontSize: t.font.title, fontWeight: "700", color: t.colors.text },
  day: { flexDirection: "row", alignItems: "center", minHeight: t.layout.touch, borderTopWidth: t.border, borderColor: t.colors.border, gap: t.space.md },
});
