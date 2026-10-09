import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { Action as Button } from '../../components/operations';
import {
  Feedback,
  workspaceStyles as ws,
} from '../../components/workspace';
import {
  getTimeReport,
  getReportDirectory,
  exportTimeReport,
  reportMessage,
  type ReportFilters,
  type ExportFormat,
} from '../../lib/time-reports-api';
import { ZudeApiError } from '../../lib/api';
import { shareTimeReport } from '../../lib/share-time-report';
import { useManagementScope } from './useManagementScope';
import { useTimeResource } from '../time/useTimeResource';
import { ReportDateField } from './ReportDateField';
import { businessToday, periodRange, periods, type Period } from './reportPeriods';
import { formatDuration } from '../time/state';
import { design as d } from '../../theme/tokens';

export function ReportsScreen() {
  const management = useManagementScope();

  return (
    <View style={ws.page}>
      {management.scope ? (
        <Reports
          key={management.scope}
          businessId={management.business.id}
          userId={management.userId!} timezone={management.business.timezone}
        />
      ) : (
        <Feedback
          title="Management access required"
          detail="Unlock to view and export time reports."
        />
      )}
    </View>
  );
}

function Reports({
  businessId,
  userId, timezone,
}: {
  businessId: string;
  userId: string; timezone:string;
}) {
  const [period,setPeriod]=useState<Period>('Custom');
  const [appliedPeriod,setAppliedPeriod]=useState<Period>('Custom');
  const [exportOpen,setExportOpen]=useState(false);
  const [detailsOpen,setDetailsOpen]=useState(false);
  const [datesOpen,setDatesOpen]=useState(false);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [employee, setEmployee] = useState('');
  const grouping = 'employee' as const;
  const [filters, setFilters] = useState<ReportFilters>({});
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const alive = useRef(true);
  const submitting = useRef(false);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    alive.current = true;

    return () => {
      alive.current = false;
      controller.current?.abort();
    };
  }, []);

  const directory = useTimeResource(
    businessId + ':report-employees',
    (signal) => getReportDirectory(businessId, signal),
  );

  const report = useTimeResource(
    businessId + JSON.stringify(filters),
    (signal) => getTimeReport(businessId, filters, signal),
  );

  const view = !report.loading && !report.error ? report.data : null;
  const people = view?.summaryRows ?? [];
  const visiblePage = Math.min(page, Math.max(0, Math.ceil(people.length / 50) - 1));
  const incomplete = (view?.provisionalPeople ?? 0) + (view?.exceptions?.length ?? 0);
  const exportFile = async (format: ExportFormat) => {
    if (submitting.current) {
      return;
    }

    setExportOpen(false);
    submitting.current = true;
    setBusy(true);
    setMessage(null);

    const currentController = new AbortController();
    controller.current = currentController;

    try {
      const result = await exportTimeReport(
        businessId,
        userId,
        filters,
        currentController.signal, format,
      );

      if (!alive.current || currentController.signal.aborted) {
        return;
      }

      setPage(0);
      report.replace(result.report);

      await shareTimeReport(
        result.csv,
        result.filename,
        currentController.signal,
      );

      if (alive.current) {
        setMessage(
          'Report prepared. Save or share it using the share sheet.',
        );
      }
    } catch (error) {
      if (alive.current) {
        setMessage(reportMessage(error));

        if (
          error instanceof ZudeApiError &&
          [401, 403, 404].includes(error.status)
        ) {
          setStart('');
          setEnd('');
          setEmployee('');
          report.refresh();
          directory.refresh();
        }
      }
    } finally {
      if (alive.current) {
        submitting.current = false;
        setBusy(false);
      }
    }
  };

  function applyPeriod(value: Period = period) {
    try {
      const range = periodRange(value, businessToday(timezone), start || (value==='Custom'?view?.range.startDate:'') || '', end || (value==='Custom'?view?.range.endDate:'') || '');
      setStart(range.startDate); setEnd(range.endDate); setPage(0);
      setAppliedPeriod(value); setExportOpen(false);
      setMessage(range.capped ? 'This period runs through today.' : null);
      setFilters({ startDate: range.startDate, endDate: range.endDate, employeeId: employee || undefined, grouping });
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Choose a valid reporting period.'); }
  }
  const periodLabel = (value: Period) => value === 'Every two weeks' ? '2 Weeks' : value === 'Twice monthly' ? 'Twice Monthly' : value;
  const roleLabel = (role: string) => role.charAt(0).toUpperCase() + role.slice(1);
  return <ScrollView style={s.page} contentContainerStyle={s.content}>
    <View style={s.heading}><View style={s.grow}>
      <Text accessibilityRole="header" style={s.title}>Employee Hours</Text>
      <Text style={s.body}>{view ? `${view.range.startDate} – ${view.range.endDate}` : filters.startDate && filters.endDate ? `${filters.startDate} – ${filters.endDate}` : 'Last 30 days'}</Text>
      <Text style={s.meta}>{view?.timezone ?? timezone}</Text>
    </View><Button label="Refresh" quiet disabled={busy} onPress={()=>{setPage(0);setMessage(null);report.refresh();directory.refresh();}}/></View>
    <View style={s.controls}>{periods.map(value=><Button key={value} label={periodLabel(value)} quiet selected={appliedPeriod===value} disabled={busy} onPress={()=>{setPeriod(value);if(value==='Custom'||value==='Every two weeks')setDatesOpen(true);else applyPeriod(value);}}/>)}</View>
    <Button label={datesOpen?'Hide dates':'Choose dates'} quiet disabled={busy} onPress={()=>setDatesOpen(!datesOpen)}/>
    {datesOpen&&<View style={s.datePanel}>
      <Text style={s.meta}>Choose dates for {periodLabel(period)}. The report changes when you apply them.</Text>
      {period==='Every two weeks'&&<Text style={s.meta}>Choose the first day of your 14-day window. This is not a saved payroll schedule.</Text>}
      <ReportDateField timezone={timezone} disabled={busy} label="Start date (YYYY-MM-DD)" value={start} onChangeText={setStart}/>
      <ReportDateField timezone={timezone} disabled={busy} label="End date (YYYY-MM-DD)" value={end} onChangeText={setEnd}/>
      <Button label="Apply dates" disabled={busy} onPress={()=>applyPeriod()}/>
    </View>}
    {view?.employeeFilter&&<Text style={s.status}>Showing one person · change the person filter in Report Details to include everyone.</Text>}
    {message&&<Text accessibilityRole="alert" style={s.body}>{message}</Text>}
    {report.error?<Feedback kind="error" title="Report unavailable" detail={reportMessage(report.error)} retry={report.refresh}/>:!view?<Feedback kind="loading" title="Loading reports"/>:<>
      <View style={s.cards}>
        <View style={[s.card,s.paidCard]}><Text style={s.meta}>FINAL PAID HOURS</Text><Text style={s.paidTotal}>{formatDuration(view.totals.workedMs)}</Text></View>
        <View style={s.card}><Text style={s.meta}>PEOPLE WORKED</Text><Text style={s.count}>{people.length}</Text></View>
        {incomplete>0&&<View style={s.card}><Text style={s.meta}>INCOMPLETE RECORDS</Text><Text style={s.count}>{incomplete}</Text></View>}
      </View>
      {incomplete>0&&<View style={s.warning}><Text style={s.rowName}>Review incomplete records</Text><Text style={s.body}>Open records include time through the report snapshot and may change.</Text>
        {view.exceptions?.map(row=><Text key={row.employeeId} style={s.body}>{row.employee} · Needs Review · {row.message}</Text>)}
      </View>}
      <Text accessibilityRole="header" style={s.section}>Employee breakdown</Text>
      {!people.length?<Feedback title="No recorded work for this period." detail={incomplete?'Review the incomplete records above.':undefined}/>:<View style={s.table} accessibilityLabel="Employee hours table">
        <View style={s.tableRow}>{['Employee','Role','Active Work','Paid Breaks','Unpaid Meals','Final Paid Hours','Status'].map((label,i)=><Text key={label} style={[s.column,i===0&&s.nameColumn,s.columnHeading]}>{label}</Text>)}</View>
        {people.slice(visiblePage*50,(visiblePage+1)*50).map(row=><View key={row.employeeId} style={s.tableRow}>
          <View style={[s.column,s.nameColumn]}><Text style={s.rowName}>{row.employee}</Text></View>
          {[roleLabel(row.employeeRole),formatDuration(row.activeWorkMs),formatDuration(row.paidBreakMs),formatDuration(row.mealBreakMs),formatDuration(row.finalPaidMs)].map((value,i)=><Text key={i} style={[s.column,s.body,i===4&&s.finalPaid]}>{value}</Text>)}
          <Text style={[s.column,s.recordStatus,row.open&&s.status]}>{row.open?'Provisional':'Complete'}</Text>
        </View>)}
      </View>}
      {people.length>50&&<View style={s.controls}><Text style={s.meta}>{`${visiblePage*50+1}–${Math.min((visiblePage+1)*50,people.length)} of ${people.length}`}</Text>
        {visiblePage>0&&<Button label="Previous rows" quiet onPress={()=>setPage(visiblePage-1)}/>}{(visiblePage+1)*50<people.length&&<Button label="Next rows" quiet onPress={()=>setPage(visiblePage+1)}/>}
      </View>}
    </>}
    <View style={s.export}><Button label={busy?'Preparing report…':'Export Report'} disabled={busy||!view} onPress={()=>setExportOpen(!exportOpen)}/>
      {exportOpen&&!!view&&<View style={s.controls}><Button label="Employee Hours Summary CSV" disabled={busy} onPress={()=>void exportFile('summary-v1')}/><Button label="Detailed Timesheet CSV" quiet disabled={busy} onPress={()=>void exportFile('shifts-v1')}/></View>}
    </View>
    <Button label="Report Details" quiet onPress={()=>setDetailsOpen(!detailsOpen)}/>
    {detailsOpen&&<View style={s.details}>
      <Text style={s.meta}>Recorded hours are not payroll approval. Paid breaks are included in final paid hours; unpaid meals are excluded.</Text>
      {view&&<><Text style={s.meta}>Snapshot: {view.snapshotAt}</Text><Text style={s.meta}>{view.integrityCoverage}</Text>{view.totals.corrected&&<Text style={s.meta}>Correction history is employee-wide. Totals use current effective records.</Text>}</>}
      <Text style={s.meta}>Filter by person</Text><Button label="All authorized employees" quiet disabled={!employee||busy} onPress={()=>setEmployee('')}/>
      {directory.error?<Feedback title="Employee filters unavailable" retry={directory.refresh}/>:directory.data?.employees.map(entry=><Button key={entry.id} label={entry.name} quiet disabled={employee===entry.id||busy} onPress={()=>setEmployee(entry.id)}/>)}
      {view&&<Text style={s.meta}>Report grouping: {view.grouping}</Text>}
      <Button label="Apply filters" disabled={busy} onPress={()=>applyPeriod()}/>
      {view?.employeeFilter&&<Text style={s.body}>This report is filtered to one person. Select All authorized employees and apply filters to include everyone.</Text>}
    </View>}
  </ScrollView>;
}
const s = StyleSheet.create({
  page:{flex:1,backgroundColor:d.color.canvas},content:{padding:d.space.xl,gap:d.space.lg},
  heading:{flexDirection:'row',alignItems:'center',gap:d.space.lg},grow:{flex:1,minWidth:0},
  title:{fontSize:d.type.page,color:d.color.textPrimary,fontWeight:'600'},body:{fontSize:d.type.body,color:d.color.textPrimary},meta:{fontSize:d.type.metadata,color:d.color.textMuted},
  controls:{flexDirection:'row',flexWrap:'wrap',gap:d.space.sm,alignItems:'center'},datePanel:{gap:d.space.md,padding:d.space.lg,backgroundColor:d.color.surfaceSubtle,borderRadius:d.radius.md},
  cards:{flexDirection:'row',flexWrap:'wrap',gap:d.space.md},card:{padding:d.space.lg,gap:d.space.sm,borderRadius:d.radius.md,backgroundColor:d.color.surface,minWidth:150},paidCard:{backgroundColor:d.color.surfaceSubtle},paidTotal:{fontSize:36,fontWeight:'600',color:d.color.actionPrimary},count:{fontSize:d.type.display,color:d.color.textPrimary},
  section:{fontSize:d.type.section,fontWeight:'600',color:d.color.textPrimary},table:{backgroundColor:d.color.surface,borderRadius:d.radius.md,overflow:'hidden'},tableRow:{flexDirection:'row',padding:d.space.lg,gap:d.space.md,borderBottomWidth:1,borderColor:d.color.divider,alignItems:'center',minHeight:76},column:{flex:1,minWidth:0},nameColumn:{flex:2.2},columnHeading:{fontSize:d.type.supporting,color:d.color.textMuted,fontWeight:'600'},rowName:{fontSize:d.type.row,fontWeight:'500',color:d.color.textPrimary},finalPaid:{fontWeight:'700',color:d.color.actionPrimary},status:{fontSize:d.type.metadata,color:d.color.statusAttention},recordStatus:{fontSize:d.type.supporting,color:d.color.textMuted},
  warning:{padding:d.space.lg,gap:d.space.sm,backgroundColor:d.color.attentionSubtle,borderRadius:d.radius.md},export:{alignItems:'flex-start',gap:d.space.md},details:{gap:d.space.md,padding:d.space.lg,backgroundColor:d.color.surfaceSubtle,borderRadius:d.radius.md},
});
