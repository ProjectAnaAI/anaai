import { useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { randomUUID } from "expo-crypto";
import { Badge, Button, styles as ui } from "../../components/ui";
import { Feedback, Field, PaneTitle, WorkspaceHeader, workspaceStyles as ws } from "../../components/workspace";
import { getMyTime, reportTimeIssue, type DayShift, type MyTimeView, type TimeDay } from "../../lib/time-clock-api";
import { theme as t } from "../../theme/tokens";
import { useBusiness } from "../business/BusinessContext";
import { useEmployeeIdentity } from "../identity/EmployeeIdentityContext";
import { Notice } from "../appointments/controls";
import { breakLabel, formatDay, formatDuration, formatTime, outcomeUnknown, requestKeyFor, running, stateLabel, timeMessage, type PendingRequest } from "./state";
import { useTimeResource } from "./useTimeResource";

// Self only, current business-local workweek only. There is deliberately no
// employee picker, no week navigation and no way to edit time here.
export function MyTimeScreen({ initiallyReporting = false }: { initiallyReporting?: boolean } = {}) {
  const { business, userId } = useBusiness();
  const { sharedMode, identity } = useEmployeeIdentity();
  const employee = sharedMode ? identity?.employee ?? null : null;
  const key = employee ? `${userId}:${business.id}:${employee.id}:${identity?.expiresAt}:my-time` : null;
  const time = useTimeResource(key, (signal) => getMyTime(business.id, signal));
  const [now, setNow] = useState(() => Date.now());
  const [reporting, setReporting] = useState(initiallyReporting);
  const [workDate, setWorkDate] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ message: string; error?: boolean } | null>(null);
  const submitting = useRef(false);
  const pending = useRef<PendingRequest | null>(null);
  const alive = useRef(true);
  const view = time.data;
  const live = !!view && view.state !== "OFF_CLOCK";
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [live]);

  async function submit() {
    const text = note.trim();
    if (submitting.current || !text) return;
    submitting.current = true; setBusy(true); setNotice(null);
    const request = requestKeyFor(pending.current, `${workDate ?? ""}:${text}`, randomUUID);
    pending.current = request;
    try {
      await reportTimeIssue(business.id, request.key, { note: text, workDate });
      pending.current = null;
      if (!alive.current) return;
      setReporting(false); setNote(""); setWorkDate(null);
      setNotice({ message: "Reported. A manager will review it. Your time records were not changed." });
      time.refresh();
    } catch (error) {
      if (!outcomeUnknown(error)) pending.current = null;
      if (alive.current) setNotice({ message: timeMessage(error), error: true });
    } finally {
      submitting.current = false;
      if (alive.current) setBusy(false);
    }
  }

  const header = <WorkspaceHeader title="My Time" business={business.name} subtitle={employee ? employee.name : undefined}
    action={view ? <Button label="Refresh" icon="refresh-cw" secondary disabled={busy || time.loading} onPress={time.refresh} /> : undefined} />;
  if (!employee) return <View style={ws.page}>{header}
    <Feedback title="Unlock with your employee PIN" detail="My Time shows your own hours on a registered shared ZUDE device after you unlock with your PIN." />
  </View>;
  if (!view) return <View style={ws.page}>{header}
    {time.error ? <Feedback kind="error" title="My Time is unavailable" detail={timeMessage(time.error)} retry={time.refresh} />
      : <Feedback kind="loading" title="Loading this week" />}
  </View>;
  const advancing = view.state === "WORKING" || view.state === "ON_PAID_BREAK";
  const hasTime = view.days.some((day) => day.shifts.length > 0);
  return <View style={ws.page}>{header}
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={s.content}>
      <View style={s.summary}>
        <PaneTitle title="This Week" detail={`${formatDay(view.week.startDate)} – ${formatDay(view.week.endDate)}`} />
        {!!time.error && <Notice message={`Showing your last loaded week. ${timeMessage(time.error)}`} error />}
        <View style={s.metrics}>
          <Metric label="Worked" value={formatDuration(running(view.week.workedMs, time.fetchedAt, now, advancing))} />
          <Metric label="Paid breaks" value={formatDuration(running(view.week.paidBreakMs, time.fetchedAt, now, view.state === "ON_PAID_BREAK"))} />
          <Metric label="Meal breaks" value={formatDuration(running(view.week.mealBreakMs, time.fetchedAt, now, view.state === "ON_MEAL_BREAK"))} />
        </View>
        <Text style={ui.meta}>Worked time includes paid breaks and excludes meal breaks. Weeks run Monday to Sunday in the business’s time zone.</Text>
        {view.state !== "OFF_CLOCK" && <View style={ui.row}><Badge label={stateLabel(view.state)} tone={view.state === "WORKING" ? "success" : "warning"} /><Text style={ui.meta}>Your shift is in progress.</Text></View>}
      </View>
      {!!notice && <Notice message={notice.message} error={notice.error} success={!notice.error} />}
      {!hasTime && <Feedback title="No time recorded this week yet" detail="Clock in from Time Clock and your shifts will appear here." />}
      {[...view.days].reverse().map((day) => <DayRecord key={day.date} day={day} view={view} today={day.date === view.week.today} />)}
      <View style={s.report}>
        <PaneTitle title="Report a time issue" detail="Something wrong or missing? Tell a manager. You can’t edit time records yourself." />
        {reporting ? <>
          <Text style={ui.strong}>Which day?</Text>
          <View style={ui.wrap}>
            <Button label="General" secondary selected={workDate === null} disabled={busy} onPress={() => setWorkDate(null)} />
            {view.days.map((day) => <Button key={day.date} label={formatDay(day.date)} secondary selected={workDate === day.date} disabled={busy} onPress={() => setWorkDate(day.date)} />)}
          </View>
          <Field label="What should a manager check?" placeholder="For example: I forgot to clock out on Tuesday at 5:00 PM." value={note} onChangeText={setNote}
            multiline maxLength={1000} editable={!busy} />
          <View style={ui.wrap}>
            <Button label="Send Report" busy={busy} disabled={busy || !note.trim()} onPress={() => void submit()} />
            <Button label="Cancel" secondary disabled={busy} onPress={() => { setReporting(false); setNote(""); setWorkDate(null); }} />
          </View>
        </> : <View style={{ alignItems: "flex-start" }}><Button label="Report a time issue" icon="flag" secondary onPress={() => { setNotice(null); setReporting(true); }} /></View>}
        {view.issues.length > 0 && <View style={s.issues}>
          <Text style={ui.strong}>Your reports this week</Text>
          {view.issues.map((issue) => <View key={issue.id} style={s.issue}>
            <View style={ui.row}><Badge compact label={issue.status === "open" ? "Waiting for review" : "Resolved"} tone={issue.status === "open" ? "warning" : "success"} />
              {issue.work_date && <Text style={ui.meta}>{formatDay(issue.work_date)}</Text>}</View>
            <Text style={ui.body}>{issue.note}</Text>
          </View>)}
        </View>}
      </View>
    </ScrollView>
  </View>;
}

function DayRecord({ day, view, today }: { day: TimeDay; view: MyTimeView; today: boolean }) {
  return <View style={s.day}>
    <View style={ui.row}>
      <View style={ui.grow}><Text accessibilityRole="header" style={ui.strong}>{formatDay(day.date, "long")}{today ? " · Today" : ""}</Text></View>
      <Text style={ui.strong}>{day.shifts.length ? formatDuration(day.workedMs) : "—"}</Text>
    </View>
    {day.shifts.length === 0 ? <Text style={ui.meta}>No time recorded</Text>
      : day.shifts.map((shift) => <ShiftRecord key={shift.id} shift={shift} timezone={view.timezone} />)}
  </View>;
}
function ShiftRecord({ shift, timezone }: { shift: DayShift; timezone: string }) {
  const span = `${formatTime(shift.clockInAt, timezone)} – ${shift.open ? "In progress" : formatTime(shift.clockOutAt, timezone)}`;
  return <View style={s.shift}>
    <View style={ui.row}>
      <View style={ui.grow}><Text style={ui.body}>{span}</Text>
        {(shift.continuesFromPreviousDay || shift.continuesNextDay) && <Text style={ui.meta}>
          {[shift.continuesFromPreviousDay && "Started the previous day", shift.continuesNextDay && "Continues past midnight"].filter(Boolean).join(" · ")}</Text>}
      </View>
      {shift.open && <Badge compact label="Open" tone="success" />}
      <Text style={ui.meta}>{formatDuration(shift.workedMs)} worked</Text>
    </View>
    {shift.breaks.map((item) => <Text key={item.startedAt} style={ui.meta}>
      {breakLabel(item.type)} ({item.type === "PAID" ? "paid" : "unpaid"}) · {formatTime(item.startedAt, timezone)} – {item.open ? "in progress" : formatTime(item.endedAt, timezone)} · {formatDuration(item.durationMs)}
    </Text>)}
  </View>;
}
function Metric({ label, value }: { label: string; value: string }) {
  return <View style={s.metric}><Text style={ui.meta}>{label}</Text><Text style={s.metricValue}>{value}</Text></View>;
}
const s = StyleSheet.create({
  content: { padding: t.space.xl, gap: t.space.lg, maxWidth: 880, width: "100%" },
  summary: { gap: t.space.sm },
  metrics: { flexDirection: "row", flexWrap: "wrap", gap: t.space.xl },
  metric: { minWidth: 120, gap: 2 },
  metricValue: { fontSize: t.font.section, fontWeight: "600", color: t.colors.text },
  day: { gap: t.space.sm, paddingVertical: t.space.md, borderTopWidth: t.border, borderColor: t.colors.border },
  shift: { gap: t.space.xs, paddingLeft: t.space.md, borderLeftWidth: 2, borderColor: t.colors.border },
  report: { gap: t.space.md, paddingTop: t.space.md, borderTopWidth: t.border, borderColor: t.colors.border },
  issues: { gap: t.space.sm },
  issue: { gap: t.space.xs, padding: t.space.md, borderWidth: t.border, borderColor: t.colors.border, borderRadius: t.radius.sm, backgroundColor: t.colors.surface },
});
