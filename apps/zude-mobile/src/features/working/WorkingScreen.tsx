import { useCallback, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { Badge, Button, styles as ui } from "../../components/ui";
import { Feedback, WorkspaceHeader, workspaceStyles as ws } from "../../components/workspace";
import { ZudeApiError } from "../../lib/api";
import { getWorking } from "../../lib/working-api";
import { useBusiness } from "../business/BusinessContext";
import { useEmployeeIdentity } from "../identity/EmployeeIdentityContext";
import { useTimeResource } from "../time/useTimeResource";
import { formatDuration } from "../time/state";
import { theme as t } from "../../theme/tokens";

const labels = { OFF_CLOCK: "Off clock", WORKING: "Working", ON_PAID_BREAK: "Paid break", ON_MEAL_BREAK: "Meal break" };
function workingMessage(error: unknown) {
  if (error instanceof ZudeApiError) {
    if (error.code === 'WORKING_LIMIT_EXCEEDED') return 'The complete roster is too large to load. Contact your ZUDE administrator.';
    if (error.code === 'TIME_CONFIGURATION_UNAVAILABLE') return 'The business timezone is not configured. Ask an owner to check business settings.';
    if (error.code === 'IDENTITY_REQUIRED' || error.code === 'IDENTITY_UNAUTHORIZED') return 'Your employee session ended. Unlock with your PIN to continue.';
    if (error.code === 'DEVICE_INVALID' || error.code === 'DEVICE_REVOKED') return 'This iPad’s registration is no longer valid.';
    if (error.status === 403) return 'Your current permissions do not allow access to this team.';
    if (error.code === 'NETWORK_ERROR') return 'Unable to reach ZUDE. Check your connection and refresh.';
  }
  return 'Unable to load the team snapshot. Please refresh and try again.';
}
export function WorkingScreen() {
  const { business, userId } = useBusiness();
  const { managementRole, sharedMode, identity } = useEmployeeIdentity();
  const allowed = !!userId && (managementRole === 'owner' || managementRole === 'manager') && (!sharedMode || !!identity);
  const generation = useRef(0);
  const [focus, setFocus] = useState<number | null>(null);
  useFocusEffect(useCallback(() => { setFocus(++generation.current); return () => setFocus(null); }, []));
  const key = allowed && focus !== null ? `${userId}:${business.id}:${managementRole}:${sharedMode ? `${identity!.employee.id}:${identity!.expiresAt}` : 'account'}:working:${focus}` : null;
  const roster = useTimeResource(key, signal => getWorking(business.id, signal));
  const view = roster.data;
  const when = (stamp: string) => new Intl.DateTimeFormat(undefined, {timeZone:view!.timezone,month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(stamp));
  return <View style={ws.page}>
    <WorkspaceHeader operational title="Who’s Working" business={business.name}
      subtitle={view ? `Snapshot ${when(view.snapshotAt)} · ${view.timezone}` : 'Current team status'}
      action={allowed ? <Button label="Refresh" icon="refresh-cw" secondary disabled={roster.loading || focus === null} onPress={roster.refresh} /> : undefined} />
    {!allowed ? <Feedback title="Who’s Working is for managers and owners" detail="Unlock with an authorized employee PIN to view the team." />
      : roster.error ? <Feedback kind="error" title="Who’s Working is unavailable" detail={workingMessage(roster.error)} retry={roster.refresh} />
      : !view ? <Feedback kind="loading" title="Loading Who’s Working" />
      : <ScrollView contentContainerStyle={s.content}>
        {roster.loading && <Text style={ui.meta}>Refreshing the snapshot…</Text>}
        {!view.employees.length && <Feedback title="No employees to show" detail="Active employees and inactive employees with an open shift appear here." />}
        {view.employees.map(row => <View key={row.employee.id} style={s.row}>
          <View style={s.identity}><Text style={ui.strong}>{row.employee.name}</Text><Text style={ui.meta}>{row.employee.role}</Text>
            {row.inactiveOpenShift && <Text style={s.warning}>Inactive · Shift still open. No clock-out has been recorded.</Text>}</View>
          <View style={s.state}><Badge label={labels[row.state]} tone={row.state === 'WORKING' ? 'success' : row.state === 'OFF_CLOCK' ? 'neutral' : 'warning'} />
            {row.stateStartedAt && <Text style={ui.meta}>Since {when(row.stateStartedAt)}</Text>}</View>
          <View style={s.duration}>{row.shift ? <>
            <Text style={ui.strong}>{formatDuration(row.shift.workedMs)} worked</Text>
            <Text style={ui.meta}>Shift {formatDuration(row.shift.elapsedMs)} · Started {when(row.shift.clockInAt)}</Text>
            {row.shift.break && <Text style={ui.meta}>Break {formatDuration(row.shift.break.durationMs)} · Since {when(row.shift.break.startedAt)}</Text>}
          </> : <Text style={ui.meta}>No open shift</Text>}</View>
        </View>)}
        {!!view.employees.length && <Text style={ui.meta}>Times are as of this snapshot. Refresh for the latest status.</Text>}
      </ScrollView>}
  </View>;
}
const s = StyleSheet.create({
  content: {padding:t.space.lg,gap:t.space.sm},
  row: {flexDirection:'row',flexWrap:'wrap',alignItems:'center',gap:t.space.lg,paddingVertical:t.space.lg,borderBottomWidth:t.border,borderBottomColor:t.colors.border,minHeight:t.layout.touch},
  identity: {flexGrow:1,flexBasis:200,gap:t.space.xs},state:{flexBasis:200,gap:t.space.sm},duration:{flexGrow:1,flexBasis:240,gap:t.space.xs},
  warning:{color:t.colors.amber,fontSize:t.font.caption},
});
