import type { SupabaseClient } from '@supabase/supabase-js';
import { isUuid } from '@/lib/appointment-actions';
import { buildShifts,windowTotals,addDays,mondayIndex,type Totals } from './time-calculation';
import { businessTimezone,consistentLedgerRead,TimeFailure,type HistoricalEvent } from './time-ledger';
import { localRange } from './management-time';
export const REPORT_GROUPS=['employee','day','week','team'] as const;
export type ReportGroup=typeof REPORT_GROUPS[number];
export type ReportInputs={startDate?:string;endDate?:string;employeeId?:string;grouping?:ReportGroup};
type Dataset={employee:{id:string;name:string;role:string;isActive:boolean};events:HistoricalEvent[];head:{occurred_at:string}|null;hasCorrections:boolean};
export type ReportRow=Totals&{employeeId:string|null;employee:string;date:string|null;week:string|null;open:boolean;corrected:boolean};
const zero=():Totals=>({workedMs:0,paidBreakMs:0,mealBreakMs:0});
function plus(a:Totals,b:Totals){a.workedMs+=b.workedMs;a.paidBreakMs+=b.paidBreakMs;a.mealBreakMs+=b.mealBreakMs;}
export function reportInputs(value:Record<string,unknown>):ReportInputs{
 if(Object.keys(value).some(k=>!['startDate','endDate','employeeId','grouping'].includes(k))||Object.values(value).some(v=>typeof v!=='string')||(value.employeeId!==undefined&&!isUuid(value.employeeId))||(value.grouping!==undefined&&!REPORT_GROUPS.includes(value.grouping as ReportGroup)))throw new TimeFailure(400,'INVALID_REQUEST','Choose valid report filters.');
 return value as ReportInputs;
}
export function timeReport(db:SupabaseClient,businessId:string,role:string,input:ReportInputs){
 // Business vector encloses timezone/range, the single-statement bounded
 // dataset and all calculations. Retries recapture the common snapshot.
 return consistentLedgerRead(db,businessId,null,async()=>{
 const timezone=await businessTimezone(db,businessId),range=localRange(timezone,input.startDate??null,input.endDate??null),grouping=input.grouping??'employee';
 const {data,error}=await db.rpc('m06_report_dataset',{p_business_id:businessId,p_role:role,p_employee_id:input.employeeId??null,p_from:new Date(range.startsAt).toISOString(),p_to:new Date(range.endsAt).toISOString()});
 if(error){if(error.code==='54000')throw new TimeFailure(503,'REPORT_LIMIT_EXCEEDED','The complete report is too large. Choose a smaller range or one employee.');if(error.code==='Z0003')throw new TimeFailure(404,'EMPLOYEE_NOT_FOUND','Employee unavailable to your current role.');throw Error('Report unavailable');}
 if(!Array.isArray(data)||data.length>200)throw Error('Incomplete report');const dataset=data as Dataset[];
 const snapshot=Math.max(Date.now(),...dataset.map(e=>e.head?Date.parse(e.head.occurred_at):0));
 const totals=zero(),rows:ReportRow[]=[],employeeIds:string[]=[];
 let open=false,corrected=false,totalEvents=0;
 for(const item of dataset){
 if(!item.employee||!Array.isArray(item.events)||(totalEvents+=item.events.length)>20000)throw new TimeFailure(503,'REPORT_LIMIT_EXCEEDED','The complete report is too large.');
 employeeIds.push(item.employee.id);const shifts=buildShifts(item.events);
 const touchingOpen=(from:number,to:number)=>shifts.some(s=>s.end===null&&s.start<to&&snapshot>from);
 const summary=windowTotals(shifts,range.startsAt,range.endsAt,snapshot);plus(totals,summary);open ||= touchingOpen(range.startsAt,range.endsAt);corrected ||= item.hasCorrections;
 const row=(values:Totals,date:string|null,week:string|null,isOpen:boolean):ReportRow=>({...values,employeeId:item.employee.id,employee:item.employee.name,date,week,open:isOpen,corrected:item.hasCorrections});
 if(grouping==='employee')rows.push(row(summary,null,null,touchingOpen(range.startsAt,range.endsAt)));
 if(grouping==='day')for(const day of range.days)rows.push(row(windowTotals(shifts,day.startsAt,day.endsAt,snapshot),day.date,addDays(day.date,-mondayIndex(day.date)),touchingOpen(day.startsAt,day.endsAt)));
 if(grouping==='week'){
 const weeks=new Map<string,{from:number;to:number}>();for(const day of range.days){const key=addDays(day.date,-mondayIndex(day.date));const entry=weeks.get(key);if(entry)entry.to=day.endsAt;else weeks.set(key,{from:day.startsAt,to:day.endsAt});}
 for(const [week,window]of weeks)rows.push(row(windowTotals(shifts,window.from,window.to,snapshot),null,week,touchingOpen(window.from,window.to)));
 }
 }
 if(grouping==='team')rows.push({...totals,employeeId:null,employee:'Authorized team',date:null,week:null,open,corrected});
 if(rows.length>20000)throw new TimeFailure(503,'REPORT_LIMIT_EXCEEDED','The complete report is too large.');
 return {businessId,timezone,range:{startDate:range.startDate,endDate:range.endDate},grouping,employeeFilter:input.employeeId??null,snapshotAt:new Date(snapshot).toISOString(),generatedAt:new Date().toISOString(),totals:{...totals,open,corrected},rows,employeeIds};
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
 if(report.rows.length>20000)throw new TimeFailure(503,'REPORT_LIMIT_EXCEEDED','The complete export is too large.');
 const header=['employee','local_date','local_week','worked_ms','worked_duration','paid_break_ms','paid_break_duration','meal_break_ms','meal_break_duration','open','has_correction_history','timezone'];
 const lines=[header.map(csvCell).join(',')];let bytes=Buffer.byteLength(lines[0]+'\r\n');
 for(const row of report.rows){const line=[row.employee,row.date,row.week,row.workedMs,duration(row.workedMs),row.paidBreakMs,duration(row.paidBreakMs),row.mealBreakMs,duration(row.mealBreakMs),row.open,row.corrected,report.timezone].map(csvCell).join(',');bytes+=Buffer.byteLength(line+'\r\n');if(bytes>MAX_CSV_BYTES)throw new TimeFailure(503,'REPORT_LIMIT_EXCEEDED','The complete CSV exceeds 2 MiB. Choose a smaller range or one employee.');lines.push(line);}
 return lines.join('\r\n')+'\r\n';
}
