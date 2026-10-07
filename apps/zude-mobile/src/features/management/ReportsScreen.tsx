import { useEffect,useRef,useState } from 'react';
import { Text,View } from 'react-native';
import { Button,styles as ui } from '../../components/ui';
import { LabeledField,recordStyles as rs } from '../../components/records';
import { Feedback,SplitWorkspace,PaneTitle,WorkspaceHeader,workspaceStyles as ws } from '../../components/workspace';
import { getTimeReport,exportTimeReport,reportMessage,type ReportFilters } from '../../lib/time-reports-api';
import { ZudeApiError } from '../../lib/api';
import { shareTimeReport } from '../../lib/share-time-report';
import { getTimesheetDirectory } from '../../lib/timesheets-api';
import { useManagementScope } from './useManagementScope';
import { useTimeResource } from '../time/useTimeResource';
import { formatDuration } from '../time/state';
export function ReportsScreen(){const a=useManagementScope();return <View style={ws.page}><WorkspaceHeader title="Time Reports" business={a.business.name} subtitle="Recorded time · No payroll calculations"/>{a.scope?<Reports key={a.scope} businessId={a.business.id} userId={a.userId!}/>:<Feedback title="Management access required" detail="Unlock to view and export time reports."/>}</View>;}
function Reports({businessId,userId}:{businessId:string;userId:string}){
 const [start,setStart]=useState(''),[end,setEnd]=useState(''),[employee,setEmployee]=useState(''),[grouping,setGrouping]=useState<NonNullable<ReportFilters['grouping']>>('employee'),[filters,setFilters]=useState<ReportFilters>({}),[page,setPage]=useState(0),[busy,setBusy]=useState(false),[message,setMessage]=useState<string|null>(null);
 const alive=useRef(true),submitting=useRef(false),controller=useRef<AbortController|null>(null);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;controller.current?.abort();};},[]);
 const directory=useTimeResource(businessId+':report-employees',signal=>getTimesheetDirectory(businessId,signal));
 const report=useTimeResource(businessId+JSON.stringify(filters),signal=>getTimeReport(businessId,filters,signal));
 const view=!report.loading&&!report.error?report.data:null;
 const exportFile=async()=>{if(submitting.current)return;submitting.current=true;setBusy(true);setMessage(null);const c=new AbortController();controller.current=c;
 try{const result=await exportTimeReport(businessId,userId,filters,c.signal);if(!alive.current||c.signal.aborted)return;setPage(0);report.replace(result.report);await shareTimeReport(result.csv,result.filename,c.signal);if(alive.current)setMessage('Export prepared and audited. The share dialog may be saved or dismissed.');}
 catch(e){if(alive.current){setMessage(reportMessage(e));if(e instanceof ZudeApiError&&[401,403,404].includes(e.status)){setStart('');setEnd('');setEmployee('');report.refresh();directory.refresh();}}}finally{if(alive.current){submitting.current=false;setBusy(false);}}};
 return <SplitWorkspace main={<><PaneTitle title="Report summary" detail={view?`${view.range.startDate} – ${view.range.endDate} · ${view.timezone}`:'Default: last 30 business-local days'}/>
 <View style={rs.actions}><Button label="Refresh" secondary disabled={busy} onPress={()=>{setPage(0);setMessage(null);report.refresh();directory.refresh();}}/><Button label={busy?'Preparing CSV…':'Export / share CSV'} disabled={busy||!view} onPress={()=>void exportFile()}/></View>{message&&<Text accessibilityRole="alert" style={ui.body}>{message}</Text>}
 {report.error?<Feedback kind="error" title="Report unavailable" detail={reportMessage(report.error)} retry={report.refresh}/>:!view?<Feedback kind="loading" title="Loading authoritative time"/>:<>
 <Text style={ui.strong}>{formatDuration(view.totals.workedMs)} worked</Text><Text style={ui.meta}>Paid breaks: {formatDuration(view.totals.paidBreakMs)} · Meal breaks: {formatDuration(view.totals.mealBreakMs)}</Text><Text style={ui.meta}>Snapshot: {new Date(view.snapshotAt).toLocaleString()}{view.totals.open?' · Includes open intervals':''}</Text>
 {view.totals.corrected&&<Text style={ui.meta}>Includes employees with correction history. Totals use current effective time.</Text>}
 <Text style={ui.meta}>Rows {view.rows.length?`${page*100+1}–${Math.min((page+1)*100,view.rows.length)}`:'0'} of {view.rows.length}. CSV includes every row.</Text>
 {view.rows.slice(page*100,(page+1)*100).map((r,i)=><View key={`${r.employeeId}:${r.date}:${r.week}:${i}`} style={rs.block}><Text style={ui.strong}>{r.employee} {r.date??r.week??''}</Text><Text style={ui.body}>{formatDuration(r.workedMs)} worked · Paid {formatDuration(r.paidBreakMs)} · Meal {formatDuration(r.mealBreakMs)}</Text><Text style={ui.meta}>{r.open?'Open interval · ':''}{r.corrected?'Employee has correction history':''}</Text></View>)}
 <View style={rs.actions}>{page>0&&<Button label="Previous rows" secondary onPress={()=>setPage(page-1)}/>} {(page+1)*100<view.rows.length&&<Button label="Next rows" secondary onPress={()=>setPage(page+1)}/>}</View></>}
 </>} rail={<><PaneTitle title="Report filters" detail="Up to 93 local days. Export refreshes the report and uses that exact result."/><LabeledField label="Start date (YYYY-MM-DD)" value={start} onChangeText={setStart}/><LabeledField label="End date (YYYY-MM-DD)" value={end} onChangeText={setEnd}/><View style={rs.actions}>{(['employee','day','week','team'] as const).map(g=><Button key={g} label={g} secondary disabled={grouping===g||busy} onPress={()=>setGrouping(g)}/>)}</View><Button label="All authorized employees" secondary disabled={!employee||busy} onPress={()=>setEmployee('')}/>{directory.error?<Feedback kind="error" title="Employee filters unavailable" retry={directory.refresh}/>:!directory.loading&&directory.data?.employees.map(e=><Button key={e.id} label={e.name} secondary disabled={employee===e.id||busy} onPress={()=>setEmployee(e.id)}/>)}<Button label="Apply filters" disabled={busy} onPress={()=>{setPage(0);setMessage(null);setFilters({startDate:start||undefined,endDate:end||undefined,employeeId:employee||undefined,grouping});}}/></>}/>;
}
