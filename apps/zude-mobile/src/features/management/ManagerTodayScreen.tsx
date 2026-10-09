import { timesheetDestination } from "../../navigation/reviewContext";
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { router } from "expo-router";
import { Action, AttentionRow, EmptyState, SectionHeader, StatusSummary, Surface, o } from "../../components/operations";
import { design as d } from "../../theme/tokens";
import { getWorkforce, type WorkforceView } from "../../lib/workforce-api";
import { getIssues } from "../../lib/time-issues-api";
import { useEmployeeIdentity } from "../identity/EmployeeIdentityContext";
import { formatDuration } from "../time/state";
import { useTimeResource } from "../time/useTimeResource";
import { useManagementScope } from "./useManagementScope";

export type RosterFilter = "working" | "break" | "off";
export function stateGroup(state: string): RosterFilter {
  return state === "WORKING" ? "working" : state === "OFF_CLOCK" ? "off" : "break";
}
export function statusCounts(view: WorkforceView) {
  return view.employees.reduce((counts, row) => { counts[stateGroup(row.state)]++; return counts; }, { working: 0, break: 0, off: 0 });
}
export function localGreeting(now: number, timezone: string) {
  const hour = Number(new Intl.DateTimeFormat("en", { timeZone: timezone, hour: "numeric", hourCycle: "h23" }).format(now));
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}
export function ManagerTodayScreen() {
  const { scope, allowed, business } = useManagementScope();
  return scope ? <ManagerToday key={scope} businessId={business.id} timezone={business.timezone} />
    : <View style={o.page}><EmptyState title={allowed ? "Today is paused" : "Manager access required"} detail="Unlock and return to Today to load current information." /></View>;
}
function ManagerToday({ businessId, timezone }: { businessId: string; timezone: string }) {
  const { identity } = useEmployeeIdentity();
  const roster = useTimeResource(`${businessId}:today-working`, signal => getWorkforce(businessId, signal));
  const issues = useTimeResource(`${businessId}:today-issues`, signal => getIssues(businessId, "open", null, signal));
  const [filter, setFilter] = useState<RosterFilter | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const { width, fontScale } = useWindowDimensions();
  const split = width >= 1400 && fontScale < 1.3;
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);
  const view = roster.error ? undefined : roster.data;
  const page = issues.error ? undefined : issues.data;
  const refreshed = (at: number) => new Intl.DateTimeFormat("en", { timeZone: timezone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" }).format(at);
  const zone = view?.timezone ?? timezone;
  const date = new Intl.DateTimeFormat("en", { timeZone: zone, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }).format(now);
  const stamp = (value: string) => new Intl.DateTimeFormat("en", { timeZone: zone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
  const counts = view ? statusCounts(view) : null;
  const inactiveOpen = view?.employees.filter(row => (!row.isActive && row.open)) ?? [];
  const calm = !!view && !!page && !roster.loading && !issues.loading && !page.nextCursor && !page.issues.length && !inactiveOpen.length;
  function refresh() { roster.refresh(); issues.refresh(); }
  return <ScrollView style={o.page} contentContainerStyle={[s.content, !split && s.compact]}>
    <View style={s.greetingRow}><View style={o.grow}>
      <Text accessibilityRole="header" style={s.greeting}>{localGreeting(now, zone)}{identity?.employee.name ? `, ${identity.employee.name}` : ""}</Text>
      <Text style={o.body}>{date} · {zone}</Text>
    </View><Action quiet label="Refresh Today" disabled={roster.loading || issues.loading} onPress={refresh} /></View>
    <Text accessibilityLiveRegion="polite" style={o.meta}>{roster.error ? "Team refresh failed. Current team status is unavailable." : roster.loading ? "Refreshing team snapshot…" : `Team snapshot last refreshed ${refreshed(roster.fetchedAt)} · ${zone}`}</Text>
    <Text accessibilityLiveRegion="polite" style={o.meta}>{issues.error ? "Report refresh failed. Current reports are unavailable." : issues.loading ? "Refreshing reported issues…" : `Reports last refreshed ${refreshed(issues.fetchedAt)} · ${zone}`}</Text>
    {counts && <StatusSummary items={([
      ["working", "Working Now"], ["break", "On Break"], ["off", "Worked Earlier"],
    ] as const).map(([group, label]) => ({ label, count: counts[group], selected: filter === group, onPress: () => setFilter(filter === group ? null : group) }))} />}
    <View style={[s.columns, !split && s.stacked]}>
      <View style={s.roster}>
        <SectionHeader title="Today’s Workforce"
          detail={view ? `${view.date} · As of ${stamp(view.snapshotAt)} · tap a row to review time` : "Current employee states"}
          action={filter ? <Action quiet label="Show all" onPress={() => setFilter(null)} /> : undefined} />
        <Surface>
          <View style={s.workforceRow}>{['Employee','Role','Status','Active Work','Paid Break','Final Paid Hours'].map((label,i)=><Text key={label} style={[o.meta,i===0?s.nameCell:i===2?s.statusCell:s.hoursCell]}>{label}</Text>)}</View>
          {!view ? <EmptyState title={roster.error ? "Team is unavailable" : "Loading your team"} detail={roster.error ? "Refresh to load verified current states." : "Checking current states…"} />
            : !view.employees.length ? <EmptyState title="No recorded work today" detail="People appear when authorized time is recorded for this day." />
            : !view.employees.some(row => !filter || stateGroup(row.state) === filter) ? <EmptyState title="No employees in this state" detail="Choose another state or show all." />
            : view.employees.filter(row => !filter || stateGroup(row.state) === filter).map(row => {
              const status = row.state === 'WORKING' ? 'Working Now' : row.state === 'OFF_CLOCK' ? 'Worked Earlier' : 'On Break';
              const evidence = page?.issues.some(issue=>issue.employee_id===row.employeeId) ? 'Reported time issue' : '';
              const destination = row.employeeId===identity?.employee.id ? '/my-time' as const : timesheetDestination(row.employeeId,view.date+'T12:00:00Z','UTC');
              return <Action quiet key={row.employeeId} label={`${row.employee}, ${status}. View time`} onPress={()=>router.replace(destination)} style={s.workforceRow}>
                <View style={s.nameCell}><Text style={o.rowTitle}>{row.employee}</Text>{evidence&&<Text style={o.evidence}>{evidence}</Text>}</View>
                <Text style={[o.body,s.hoursCell]}>{row.employeeRole}</Text>
                <View style={s.statusCell}><Text style={o.body}>{status}</Text><Text style={o.meta}>{row.open?'Provisional':''}{!row.isActive?' · Former worker':''}</Text></View>
                <Text style={[o.body,s.hoursCell]}>{formatDuration(row.activeWorkMs)}</Text>
                <Text style={[o.body,s.hoursCell]}>{formatDuration(row.paidBreakMs)}</Text>
                <Text style={[o.rowTitle,s.hoursCell]}>{formatDuration(row.finalPaidMs)}</Text>
              </Action>;

            })}
        </Surface>
        {view?.exceptions.map(row=><Text key={row.employeeId} style={o.evidence}>{row.employee} · Needs Review · {row.message}</Text>)}
        {roster.loading && !!view && <Text accessibilityLiveRegion="polite" style={o.meta}>Refreshing team snapshot…</Text>}
      </View>
      <View style={[s.attention, !split && s.attentionStacked]}>
        <SectionHeader title="Needs attention" action={<Action quiet label="View all" onPress={() => router.replace("/time-issues")} />} />
        <Surface>
          {!page ? <EmptyState title={issues.error ? "Issues are unavailable" : "Checking time issues"} detail={issues.error ? "Refresh or open Attention to review reports." : "Loading reported issues…"} />
            : calm ? <EmptyState title="No unresolved employee reports" detail="No inactive employees with open shifts in this snapshot. Other time records may still need review." />
            : <>
              {page.issues.slice(0, 3).map(issue => <AttentionRow key={issue.id} name={issue.employee_name} detail={issue.note} label="Review reported issue" onPress={() => router.replace({ pathname: "/time-issues", params: { issueId: issue.id } })} />)}
              {inactiveOpen.slice(0, 2).map(row => <AttentionRow key={row.employeeId} name={row.employee} detail={`Inactive employee · shift still open${""}`} label="Review time" onPress={() => router.replace(timesheetDestination(row.employeeId, view?.date ? view.date+"T12:00:00Z" : undefined, "UTC"))} />)}
              {!page.issues.length && !inactiveOpen.length && <EmptyState title="Verifying attention" detail="A complete current team and issue check is required." />}
            </>}
        </Surface>
        {page && (page.nextCursor || page.issues.length > 3) && <Text style={o.meta}>Preview of reported issues. More reports are available in Attention.</Text>}
        {inactiveOpen.length > 2 && <Text style={o.meta}>More inactive employees have open shifts. Review Time.</Text>}
        {issues.loading && !!page && <Text accessibilityLiveRegion="polite" style={o.meta}>Refreshing reported issues…</Text>}
        <Action quiet label="View history" onPress={() => router.replace("/audit")} />
      </View>
    </View>
  </ScrollView>;
}
const s = StyleSheet.create({
  workforceRow:{flexDirection:'row',alignItems:'center',gap:d.space.md,padding:d.space.lg,minHeight:76,borderBottomWidth:1,borderColor:d.color.divider},nameCell:{flex:2,minWidth:0},statusCell:{flex:1.4,minWidth:0},hoursCell:{flex:1,minWidth:0},
  content: { padding: d.space.xxl, paddingBottom: d.space.xl }, compact: { padding: d.space.lg },
  greetingRow: { flexDirection: "row", alignItems: "center", gap: d.space.md },
  greeting: { fontSize: d.type.page, color: d.color.textPrimary, fontWeight: "500", marginBottom: d.space.sm },
  columns: { flexDirection: "row", gap: d.space.xl }, stacked: { flexDirection: "column" },
  roster: { flex: 1, minWidth: 0 }, attention: { width: d.layout.attentionWidth, gap: d.space.sm }, attentionStacked: { width: "100%" },
});
