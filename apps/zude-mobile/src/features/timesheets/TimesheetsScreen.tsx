import { useCallback, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { Badge, Button, styles as ui } from "../../components/ui";
import { RecordRow, recordStyles as rs } from "../../components/records";
import { Feedback, MasterDetail, PaneTitle, WorkspaceHeader, workspaceStyles as ws } from "../../components/workspace";
import { ZudeApiError } from "../../lib/api";
import { getTimesheet, getTimesheetDirectory, timesheetMessage, type LedgerEvent } from "../../lib/timesheets-api";
import { CorrectionPanel } from "./CorrectionPanel";
import { correctionMessage, mayCorrect } from "./correction";
import { useBusiness } from "../business/BusinessContext";
import { useEmployeeIdentity } from "../identity/EmployeeIdentityContext";
import { useTimeResource } from "../time/useTimeResource";
import { formatDay, formatDuration } from "../time/state";
import { theme as t } from "../../theme/tokens";
import { Notice } from "../appointments/controls";

// Corrected entries are labelled in text (not by colour alone); ordinary
// entries carry no extra label.
const provenance = (event: LedgerEvent) => event.origin === 'inserted' ? 'Added by correction' : event.corrected ? 'Corrected' : null;
const eventLabel = (event: LedgerEvent) => event.type === 'CLOCK_IN' ? 'Clock in' : event.type === 'CLOCK_OUT' ? 'Clock out'
  : `${event.breakType === 'PAID' ? 'Paid' : 'Meal'} break ${event.type === 'BREAK_START' ? 'started' : 'ended'}`;
// `correcting` opens the correction panel for the selected day. Every other
// selection change creates a new object without it, closing the panel.
type Selection = { scope: string; employeeId: string; week: string | null; day: string | null; correcting?: boolean };
export function TimesheetsScreen({ initialContext = null, invalidContext = false }: { initialContext?: { employeeId: string; week: string | null; day: string | null } | null; invalidContext?: boolean } = {}) {
  const { business, userId } = useBusiness();
  const { managementRole, sharedMode, identity } = useEmployeeIdentity();
  const allowed = !!userId && (managementRole === 'manager' || managementRole === 'owner') && (!sharedMode || !!identity);
  const generation = useRef(0);
  const [focus, setFocus] = useState<number | null>(null);
  useFocusEffect(useCallback(() => { setFocus(++generation.current); return () => setFocus(null); }, []));
  const scope = allowed && !invalidContext && focus !== null ? `${userId}:${business.id}:${managementRole}:${sharedMode ? `${identity!.employee.id}:${identity!.expiresAt}` : 'account'}:${focus}` : null;
  const [appliedScope, setAppliedScope] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [denied, setDenied] = useState<{ scope: string; message: string } | null>(null);
  const [saved, setSaved] = useState<{ key: string; message: string } | null>(null);
  // Key checks hide old state in the render itself, before cleanup effects.
  if (scope && initialContext && appliedScope !== scope) {
    setAppliedScope(scope); setSelection({ scope, ...initialContext });
  }
  const selected = selection?.scope === scope ? selection : null;
  const directory = useTimeResource(scope ? `${scope}:targets` : null, signal => getTimesheetDirectory(business.id, signal));
  const targets = !directory.loading && !directory.error ? directory.data?.employees : undefined;
  const target = targets?.find(e => e.id === selected?.employeeId);
  const sheet = useTimeResource(scope && target && selected ? `${scope}:${target.id}:${selected.week ?? 'current'}` : null,
    signal => getTimesheet(business.id, target!.id, selected!.week, signal));
  const view = !sheet.loading && !sheet.error ? sheet.data : undefined;
  // Adjust state during render only when its identity no longer matches.
  // React discards this render before committing any old employee selection.
  if (selection && selection.scope !== scope) setSelection(null);
  if (denied && denied.scope !== scope) setDenied(null);
  const error = directory.error ?? sheet.error;
  if (scope && error instanceof ZudeApiError && [401,403,404].includes(error.status)) {
    const message = timesheetMessage(error);
    if (selection) setSelection(null);
    if (denied?.scope !== scope || denied.message !== message) setDenied({ scope, message });
  }
  if (scope && selected && targets && !target) {
    setSelection(null);
    setDenied({ scope, message: 'This employee is no longer available in your timesheet list.' });
  }
  const notice = denied?.scope === scope ? denied?.message : null;
  const choose = (employeeId: string) => {
    if (!scope) return;
    setDenied(null); setSelection({ scope, employeeId, week: null, day: null });
  };
  const week = (value: string | null) => { if (selected) setSelection({ ...selected, week: value, day: null }); };
  const refresh = () => { setDenied(null); directory.refresh(); sheet.refresh(); };
  const when = (stamp: string) => new Intl.DateTimeFormat(undefined, { timeZone: view!.timezone, year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit' }).format(new Date(stamp));
  const day = view?.days.find(d => d.date === selected?.day);
  const dayShiftIds = new Set(day?.shifts.map(s => s.id));
  const events = view?.events.filter(e => dayShiftIds.has(e.shiftId)) ?? [];
  // Visibility mirrors the server hierarchy; the server re-checks every request.
  const canCorrect = !!view && !!managementRole && mayCorrect(managementRole, view.employee.role);
  const correctionKey = `${scope}:${selected?.employeeId}:${view?.week.startDate}:${selected?.day}`;
  const savedNotice = saved?.key === correctionKey ? saved.message : null;
  return <View style={ws.page}>
    <WorkspaceHeader title="Timesheets" business={business.name} subtitle="Employee time · corrections are previewed and recorded"
      action={allowed ? <Button label="Refresh" secondary icon="refresh-cw" disabled={!scope || directory.loading || sheet.loading} onPress={refresh} /> : undefined} />
    {!allowed ? <Feedback title="Timesheets are for managers and owners" detail="Unlock with an authorized employee PIN to continue." />
      : invalidContext ? <Feedback kind="error" title="Invalid timesheet link" detail="Open Time and choose an authorized employee." />
      : <>{notice && <Feedback kind="error" title="Timesheet access changed" detail={notice} retry={refresh} />}
      <MasterDetail fixed={{ side:'master',width:280 }} showDetail={!!selected} onBack={() => setSelection(null)} backLabel="Employees"
        master={<>
          <PaneTitle title="Employees" detail={managementRole === 'manager' ? 'Regular employees · Active and inactive' : 'Active and inactive team members'} />
          {directory.error ? <Feedback kind="error" title="Employee list unavailable" detail={timesheetMessage(directory.error)} retry={refresh} />
            : !targets ? <Feedback kind="loading" title="Loading employees" />
            : !targets.length ? <Feedback title="No employees to show" detail="There are no timesheet targets available to your role." />
            : targets.map(e => <RecordRow key={e.id} label={`View timesheet for ${e.name}`} selected={selected?.employeeId === e.id} onPress={() => choose(e.id)}
                trailing={!e.isActive ? <Badge label="Inactive" tone="neutral" /> : undefined}>
                <Text style={rs.name}>{e.name}</Text><Text style={ui.meta}>{e.role}</Text>
              </RecordRow>)}
        </>}
        detail={!selected ? <Feedback title="Choose an employee" detail="View a business week, then select a day for shift and event detail." />
          : directory.error ? <Feedback kind="error" title="Employee list unavailable" detail={timesheetMessage(directory.error)} retry={refresh} />
          : sheet.error ? <><Feedback kind="error" title="Timesheet unavailable" detail={timesheetMessage(sheet.error)} retry={sheet.refresh} /><Button label="Current week" secondary onPress={() => week(null)} /></>
          : !view ? <Feedback kind="loading" title="Loading timesheet" />
          : <>
            <PaneTitle title={view.employee.name} detail={`${view.employee.role} · ${view.employee.isActive ? 'Active' : 'Inactive'} · ${view.timezone}`} />
            {!view.employee.isActive && <Text style={s.attention}>Inactive employee{view.totals.hasOpenShift ? ' · Shift still open. No clock-out has been recorded.' : ' · Historical time retained.'}</Text>}
            <View style={rs.actions}>
              <Button label="Previous week" icon="chevron-left" secondary onPress={() => week(view.previousWeekStart)} />
              <Button label="Current week" secondary disabled={view.week.startDate === view.currentWeekStart} onPress={() => week(null)} />
              <Button label="Next week" icon="chevron-right" secondary disabled={!view.nextWeekStart} onPress={() => week(view.nextWeekStart)} />
            </View>
            <View style={rs.block}>
              <Text style={ws.heading}>{formatDay(view.week.startDate)}, {view.week.startDate.slice(0,4)} – {formatDay(view.week.endDate)}, {view.week.endDate.slice(0,4)}</Text>
              <Text style={ui.strong}>{formatDuration(view.totals.workedMs)} worked</Text>
              <Text style={ui.meta}>Paid breaks {formatDuration(view.totals.paidBreakMs)} · Meal breaks {formatDuration(view.totals.mealBreakMs)}</Text>
              {view.totals.hasOpenShift && <Text style={s.attention}>Includes an open shift · Calculated through the snapshot, within this week.</Text>}
              <Text style={ui.meta}>Snapshot {when(view.snapshotAt)}</Text>
            </View>
            {!view.days.some(d => d.shifts.length) && <Feedback title="No time in this week" detail="No recorded shifts overlap this business week." />}
            <PaneTitle title="Days" detail="Choose a day to inspect its shifts" />
            {view.days.map(d => <RecordRow key={d.date} label={`View ${formatDay(d.date)}`} selected={selected.day === d.date}
                onPress={() => setSelection({ ...selected, day: d.date })} trailing={<Text style={ui.strong}>{formatDuration(d.workedMs)}</Text>}>
                <Text style={rs.name}>{formatDay(d.date)}</Text><Text style={ui.meta}>{d.shifts.length} shifts{d.shifts.some(s => s.open) ? ' · Open shift' : ''}</Text>
              </RecordRow>)}
            {day && <View style={rs.block}>
              <PaneTitle title={formatDay(day.date)} detail="Time allocated to this business day" />
              <Text style={ui.strong}>{formatDuration(day.workedMs)} worked</Text>
              <Text style={ui.meta}>Paid breaks {formatDuration(day.paidBreakMs)} · Meal breaks {formatDuration(day.mealBreakMs)}</Text>
              {!day.shifts.length && <Feedback title="No shifts this day" />}
              {day.shifts.map(shift => <View key={shift.id} style={rs.block}>
                <Text style={ui.strong}>{when(shift.clockInAt)} – {shift.clockOutAt ? when(shift.clockOutAt) : 'Still open'}</Text>
                <Text style={ui.meta}>{formatDuration(shift.workedMs)} worked this day{shift.continuesFromPreviousDay ? ' · Started earlier' : ''}{shift.continuesNextDay ? ' · Continues next day' : ''}</Text>
                {shift.breaks.map((b,i) => <Text key={`${b.startedAt}:${i}`} style={ui.body}>{b.type === 'PAID' ? 'Paid' : 'Meal'} break · {when(b.startedAt)} – {b.endedAt ? when(b.endedAt) : 'Still open'} · {formatDuration(b.durationMs)} full break</Text>)}
              </View>)}
              {!!events.length && <><PaneTitle title="Shift events" detail="Original sequence order · Dates outside this day provide shift context" />
                {events.map(e => <View key={e.id} style={s.event}>
                  <View style={rs.actions}><Text style={ui.strong}>{eventLabel(e)}</Text>{provenance(e) && <Badge label={provenance(e)!} tone="warning" compact />}</View>
                  <Text style={ui.meta}>{when(e.occurredAt)}</Text>
                </View>)}
              </>}
              {savedNotice && <Notice message={savedNotice} success />}
              {canCorrect && !selected.correcting && <View style={rs.actions}>
                <Button label="Correct time" icon="edit-3" secondary onPress={() => { setSaved(null); setSelection({ ...selected, correcting: true }); }} />
              </View>}
              {canCorrect && selected.correcting && <CorrectionPanel key={`${correctionKey}`} businessId={business.id} userId={userId!} sheet={view} day={day}
                onClose={() => setSelection({ ...selected, correcting: false })}
                onCommitted={(fresh, replayed) => {
                  // The server's fresh authoritative timesheet replaces the old one.
                  sheet.replace(fresh); setSelection({ ...selected, correcting: false });
                  setSaved({ key: correctionKey, message: replayed ? 'This correction was already saved. The timesheet shows the saved result.' : 'Correction saved. The timesheet shows the updated time.' });
                }}
                onStale={() => sheet.refresh()}
                onAuthorityLost={error => { setSelection(null); setDenied({ scope: scope!, message: correctionMessage(error) }); directory.refresh(); }} />}
            </View>}
          </>} /></>}
  </View>;
}
const s = StyleSheet.create({
  attention: { color:t.colors.amber,fontSize:t.font.body,paddingVertical:t.space.sm },
  event: { paddingVertical:t.space.sm,gap:t.space.xs,borderBottomWidth:t.border,borderBottomColor:t.colors.border },
});
