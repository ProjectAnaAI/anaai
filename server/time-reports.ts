import { managementWriteActor,type ManagementAuthority } from './operational-authority';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isUuid } from '@/lib/appointment-actions';
import { buildShifts,windowTotals,dayView,clockState,addDays,mondayIndex,type Totals } from './time-calculation';
import { businessTimezone,consistentLedgerRead,TimeFailure,type HistoricalEvent } from './time-ledger';
import { localRange } from './management-time';
export const REPORT_GROUPS=['employee','day','week','team'] as const;
export type ReportGroup=typeof REPORT_GROUPS[number];
export type ReportInputs={startDate?:string;endDate?:string;employeeId?:string;grouping?:ReportGroup};
type Dataset={employee:{id:string;name:string;role:string;isActive:boolean};events:HistoricalEvent[];head:{occurred_at:string;event_type:'CLOCK_IN'|'CLOCK_OUT'|'BREAK_START'|'BREAK_END';break_type:'PAID'|'MEAL'|null}|null;hasCorrections:boolean};
export type Hours = { activeWorkMs:number; finalPaidMs:number };
export function paidHours(values:Totals):Hours {
 if(![values.workedMs,values.paidBreakMs,values.mealBreakMs].every(v=>Number.isSafeInteger(v)&&v>=0)||values.paidBreakMs>values.workedMs)throw new TimeFailure(503,"TIME_INTEGRITY_ERROR","Time records need review. Paid breaks exceed recorded paid time or durations are invalid.");
 return {activeWorkMs:values.workedMs-values.paidBreakMs,finalPaidMs:values.workedMs};
}
export type HoursSummary=Totals&Hours&{employeeId:string;employee:string;employeeRole:string;open:boolean;corrected:boolean};
export type Allocation=HoursSummary&{shiftId:string;date:string;clockInAt:string;clockOutAt:string|null;continuesFromPreviousDay:boolean;continuesNextDay:boolean};
export const EXPORT_FORMATS=["daily-v1","daily-v2","summary-v1","shifts-v1"] as const;
export type ExportFormat=typeof EXPORT_FORMATS[number];
export type ReportRow=Totals&{employeeId:string|null;employee:string;date:string|null;week:string|null;open:boolean;corrected:boolean};
const zero=():Totals=>({workedMs:0,paidBreakMs:0,mealBreakMs:0});
function plus(a:Totals,b:Totals){a.workedMs+=b.workedMs;a.paidBreakMs+=b.paidBreakMs;a.mealBreakMs+=b.mealBreakMs;}
export function reportInputs(value:Record<string,unknown>):ReportInputs{
 if(Object.keys(value).some(k=>!['startDate','endDate','employeeId','grouping'].includes(k))||Object.values(value).some(v=>typeof v!=='string')||(value.employeeId!==undefined&&!isUuid(value.employeeId))||(value.grouping!==undefined&&!REPORT_GROUPS.includes(value.grouping as ReportGroup)))throw new TimeFailure(400,'INVALID_REQUEST','Choose valid report filters.');
 return value as ReportInputs;
}
export function timeReport(db:SupabaseClient,businessId:string,role:string|ManagementAuthority,input:ReportInputs,includeDaily=false){
 // Business vector encloses timezone/range, the single-statement bounded
 // dataset and all calculations. Retries recapture the common snapshot.
 return consistentLedgerRead(db,businessId,null,async()=>{
 const timezone=await businessTimezone(db,businessId),range=localRange(timezone,input.startDate??null,input.endDate??null),grouping=input.grouping??'employee';
 const {data,error}=await db.rpc(typeof role==='string'?'m06_report_dataset':'wf01_report_dataset',{p_business_id:businessId,...(typeof role==='string'?{p_role:role}:managementWriteActor(role)),p_employee_id:input.employeeId??null,p_from:new Date(range.startsAt).toISOString(),p_to:new Date(range.endsAt).toISOString()});
 if(error){if(error.code==='28000')throw new TimeFailure(401,'IDENTITY_UNAUTHORIZED','Unlock again to continue.');if(error.code==='42501')throw new TimeFailure(403,'ROLE_FORBIDDEN','Report access changed.');if(error.code==='54000')throw new TimeFailure(503,'REPORT_LIMIT_EXCEEDED','The complete report is too large. Choose a smaller range or one employee.');if(error.code==='Z0003')throw new TimeFailure(404,'EMPLOYEE_NOT_FOUND','Employee unavailable to your current role.');throw Error('Report unavailable');}
 if(!Array.isArray(data)||data.length>200)throw Error('Incomplete report');const dataset=data as Dataset[];
 const snapshot=Math.max(Date.now(),...dataset.map(e=>e.head?Date.parse(e.head.occurred_at):0));
 const totals=zero(),rows:ReportRow[]=[],dailyRows:ReportRow[]=[],employeeIds:string[]=[];
 const summaryRows:HoursSummary[]=[],allocations:Allocation[]=[],exceptions:{employeeId:string;employee:string;employeeRole:string;message:string}[]=[];
 const workforceRows:(HoursSummary&{state:ReturnType<typeof clockState>;isActive:boolean})[]=[];
 let open=false,corrected=false,totalEvents=0;
 for(const item of dataset){
 if(!item.employee||!Array.isArray(item.events)||(totalEvents+=item.events.length)>20000)throw new TimeFailure(503,'REPORT_LIMIT_EXCEEDED','The complete report is too large.');
 employeeIds.push(item.employee.id);const shifts=buildShifts(item.events);
 const touchingOpen=(from:number,to:number)=>shifts.some(s=>s.end===null&&s.start<to&&snapshot>from);
 const summary=windowTotals(shifts,range.startsAt,range.endsAt,snapshot);const hours=paidHours(summary);
 const person={...summary,...hours,employeeId:item.employee.id,employee:item.employee.name,employeeRole:item.employee.role,open:touchingOpen(range.startsAt,range.endsAt),corrected:item.hasCorrections};
 workforceRows.push({...person,state:clockState(item.head),isActive:item.employee.isActive});
 if(summary.workedMs>0)summaryRows.push(person);
 else if(person.open||summary.mealBreakMs>0)exceptions.push({employeeId:item.employee.id,employee:item.employee.name,employeeRole:item.employee.role,message:"Recorded open or meal intervals contribute no positive paid duration. Review the authorized timesheet."});
 if(includeDaily)for(const day of range.days)for(const shift of dayView(shifts,day,snapshot).shifts){
  const values={workedMs:shift.workedMs,paidBreakMs:shift.paidBreakMs,mealBreakMs:shift.mealBreakMs};const allocated=paidHours(values);
  if(values.workedMs===0&&values.mealBreakMs===0&&!shift.open)continue;
  allocations.push({...person,...values,...allocated,shiftId:shift.id,date:day.date,clockInAt:shift.clockInAt!,clockOutAt:shift.clockOutAt,open:shift.open,continuesFromPreviousDay:shift.continuesFromPreviousDay,continuesNextDay:shift.continuesNextDay});
  if(allocations.length>20000)throw new TimeFailure(503,"REPORT_LIMIT_EXCEEDED","The complete shift export is too large.");
 }
 plus(totals,summary);open ||= touchingOpen(range.startsAt,range.endsAt);corrected ||= item.hasCorrections;
 const row=(values:Totals,date:string|null,week:string|null,isOpen:boolean):ReportRow=>({...values,employeeId:item.employee.id,employee:item.employee.name,date,week,open:isOpen,corrected:item.hasCorrections});
 if(grouping==='employee')rows.push(row(summary,null,null,touchingOpen(range.startsAt,range.endsAt)));
 // CSV detail and the day view share these exact authoritative allocations.
 const daily=grouping==='day'||includeDaily?range.days.map(day=>row(windowTotals(shifts,day.startsAt,day.endsAt,snapshot),day.date,addDays(day.date,-mondayIndex(day.date)),touchingOpen(day.startsAt,day.endsAt))):[];
 dailyRows.push(...daily);
 if(grouping==='day')rows.push(...daily);
 if(grouping==='week'){
 const weeks=new Map<string,{from:number;to:number}>();for(const day of range.days){const key=addDays(day.date,-mondayIndex(day.date));const entry=weeks.get(key);if(entry)entry.to=day.endsAt;else weeks.set(key,{from:day.startsAt,to:day.endsAt});}
 for(const [week,window]of weeks)rows.push(row(windowTotals(shifts,window.from,window.to,snapshot),null,week,touchingOpen(window.from,window.to)));
 }
 }
 if(grouping==='team')rows.push({...totals,employeeId:null,employee:'Authorized team',date:null,week:null,open,corrected});
 if(rows.length>20000||dailyRows.length>20000)throw new TimeFailure(503,'REPORT_LIMIT_EXCEEDED','The complete report is too large.');
 return {workforceRows,summaryRows,allocations,exceptions,peopleWorked:summaryRows.length,provisionalPeople:summaryRows.filter(row=>row.open).length,integrityCoverage:"Warnings cover zero-paid open/meal intervals only; employee reports and all other integrity exceptions are not assessed.",businessId,timezone,range:{startDate:range.startDate,endDate:range.endDate},grouping,employeeFilter:input.employeeId??null,snapshotAt:new Date(snapshot).toISOString(),generatedAt:new Date().toISOString(),totals:{...totals,...paidHours(totals),open,corrected},rows,dailyRows,employeeIds};
 });
}
export type TimeReport=Awaited<ReturnType<typeof timeReport>>;
export function csvCell(value:string|number|boolean|null){
 let text=value===null?'':String(value);
 if(/^[\s\u0000-\u001f\u007f]*[=+@-]/.test(text)||/^[\t\r\n]/.test(text))text="'"+text;
 return '"'+text.replaceAll('"','""')+'"';
}
const duration=(ms:number)=>{const hours=Math.floor(ms/3600000),minutes=Math.floor(ms/60000)%60,seconds=Math.floor(ms/1000)%60,millis=Math.floor(ms)%1000;return `${hours}:${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')}.${String(millis).padStart(3,'0')}`;};
export const MAX_CSV_BYTES=2*1024*1024;
export function reportCsv(report:TimeReport){
 if(report.dailyRows.length>20000)throw new TimeFailure(503,'REPORT_LIMIT_EXCEEDED','The complete export is too large.');
 const header=['Employee','Date','Worked','Paid Break','Meal Break','Status','Correction History','Timezone','Worked Milliseconds','Paid Break Milliseconds','Meal Break Milliseconds'];
 const lines=[header.map(csvCell).join(',')];let bytes=Buffer.byteLength(lines[0]+'\r\n');
 for(const row of report.dailyRows){
 if(!row.date||row.date<report.range.startDate||row.date>report.range.endDate)throw Error('Invalid daily export range');
 const line=[row.employee,row.date,duration(row.workedMs),duration(row.paidBreakMs),duration(row.mealBreakMs),row.open?'Open':'Complete',row.corrected?'Yes':'No',report.timezone,row.workedMs,row.paidBreakMs,row.mealBreakMs].map(csvCell).join(',');bytes+=Buffer.byteLength(line+'\r\n');if(bytes>MAX_CSV_BYTES)throw new TimeFailure(503,'REPORT_LIMIT_EXCEEDED','The complete CSV exceeds 2 MiB. Choose a smaller range or one employee.');lines.push(line);}
 return lines.join('\r\n')+'\r\n';
}

// Existing daily-v1 bytes remain compatible. New formats carry explicit metadata.
const hoursDisplay=(ms:number)=>`${Math.floor(ms/3600000)}h ${Math.floor(ms/60000)%60}m`;
export function exportRows(report:TimeReport,format:ExportFormat){return format==="summary-v1"?report.summaryRows.length:format==="shifts-v1"?report.allocations.length:format==="daily-v2"?report.dailyRows.filter(row=>report.summaryRows.some(person=>person.employeeId===row.employeeId)&&row.workedMs>0).length:report.dailyRows.length;}
export function hoursCsv(report:TimeReport,format:ExportFormat){
 if(format==="daily-v1")return reportCsv(report);
 if(format==="daily-v2"){
  const ids=new Set(report.summaryRows.map(row=>row.employeeId));const legacy={...report,dailyRows:report.dailyRows.filter(row=>ids.has(row.employeeId!)&&row.workedMs>0)};
  const csv=reportCsv(legacy);const extra=['business_id','period_start','period_end','snapshot_at','export_format','warning'];
  const suffix=[report.businessId,report.range.startDate,report.range.endDate,report.snapshotAt,format,'Open status means provisional through snapshot; not payroll approved'].map(csvCell).join(',');
  // Append metadata at record boundaries, outside quoted fields only.
  let quoted=false,record=0,result='';for(let i=0;i<csv.length;i++){const ch=csv[i];if(ch==='"'){if(quoted&&csv[i+1]==='"'){result+='""';i++;continue;}quoted=!quoted;}
   if(!quoted&&ch==='\r'&&csv[i+1]==='\n'){result+=','+(record++===0?extra.map(csvCell).join(','):suffix)+'\r\n';i++;}else result+=ch;
  }
  if(Buffer.byteLength(result)>MAX_CSV_BYTES)throw new TimeFailure(503,'REPORT_LIMIT_EXCEEDED','The complete CSV exceeds 2 MiB.');return result;
 }
 const common=['business_id','employee_id','employee_name','employee_role'];
 const columns=format==='summary-v1'?[...common,'period_start','period_end','timezone','snapshot_at','active_work_ms','paid_break_ms','unpaid_meal_ms','final_paid_ms','active_work_display','paid_break_display','unpaid_meal_display','final_paid_display','provisional','correction_history','export_format','warning']:[...common,'shift_id','allocation_date','clock_in_utc','clock_out_utc','local_clock_in','local_clock_out','timezone','active_work_ms','paid_break_ms','unpaid_meal_ms','final_paid_ms','provisional','continues_from_previous_day','continues_next_day','period_start','period_end','snapshot_at','export_format','warning'];
 const source=format==='summary-v1'?report.summaryRows:report.allocations;
 if(source.length>20000)throw new TimeFailure(503,'REPORT_LIMIT_EXCEEDED','The complete export is too large.');
 const local=(stamp:string|null)=>stamp?new Intl.DateTimeFormat('en-CA',{timeZone:report.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',timeZoneName:'longOffset'}).format(new Date(stamp)):null;
 const lines=[columns.map(csvCell).join(',')];let bytes=Buffer.byteLength(lines[0]+'\r\n');
 for(const row of source){
  const base=[report.businessId,row.employeeId,row.employee,row.employeeRole];
  const values=format==='summary-v1'?[...base,report.range.startDate,report.range.endDate,report.timezone,report.snapshotAt,row.activeWorkMs,row.paidBreakMs,row.mealBreakMs,row.finalPaidMs,hoursDisplay(row.activeWorkMs),hoursDisplay(row.paidBreakMs),hoursDisplay(row.mealBreakMs),hoursDisplay(row.finalPaidMs),row.open,row.corrected,format,(row.open?'Provisional through snapshot; not payroll approved':'Closed intervals; not payroll approved')+(report.exceptions.length?' · Additional zero-paid intervals need review in the report':'')]:(()=>{const r=row as Allocation;return [...base,r.shiftId,r.date,r.clockInAt,r.clockOutAt,local(r.clockInAt),local(r.clockOutAt),report.timezone,r.activeWorkMs,r.paidBreakMs,r.mealBreakMs,r.finalPaidMs,r.open,r.continuesFromPreviousDay,r.continuesNextDay,report.range.startDate,report.range.endDate,report.snapshotAt,format,r.open?'Provisional through snapshot; timestamps describe full shift, durations this allocation only':'Full shift timestamps; durations this allocation only; not payroll approved'];})();
  const line=values.map(csvCell).join(',');bytes+=Buffer.byteLength(line+'\r\n');if(bytes>MAX_CSV_BYTES)throw new TimeFailure(503,'REPORT_LIMIT_EXCEEDED','The complete CSV exceeds 2 MiB. Choose a smaller range or one employee.');lines.push(line);
 }
 return lines.join('\r\n')+'\r\n';
}
