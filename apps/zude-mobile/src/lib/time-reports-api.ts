import { apiGet,apiWrite,ZudeApiError } from './api';
import { operationalRequest } from './operational-identity';
export type ExportFormat='daily-v1'|'daily-v2'|'summary-v1'|'shifts-v1';
export type HoursSummary={employeeId:string;employee:string;employeeRole:'employee'|'manager'|'owner';workedMs:number;paidBreakMs:number;mealBreakMs:number;activeWorkMs:number;finalPaidMs:number;open:boolean;corrected:boolean};
export type ReportFilters={startDate?:string;endDate?:string;employeeId?:string;grouping?:'employee'|'day'|'week'|'team'};
type Totals={workedMs:number;paidBreakMs:number;mealBreakMs:number};
export type ReportRow=Totals&{employeeId:string|null;employee:string;date:string|null;week:string|null;open:boolean;corrected:boolean};
export type TimeReport={summaryRows:HoursSummary[];peopleWorked?:number;provisionalPeople?:number;exceptions?:{employeeId:string;employee:string;employeeRole:string;message:string}[];integrityCoverage?:string;businessId:string;timezone:string;range:{startDate:string;endDate:string};grouping:NonNullable<ReportFilters['grouping']>;employeeFilter:string|null;snapshotAt:string;generatedAt:string;totals:Totals&{open:boolean;corrected:boolean};rows:ReportRow[]};
const invalid=()=>new ZudeApiError(0,'INVALID_RESPONSE','Unable to verify this report.');
function parseReport(data:TimeReport,businessId:string):TimeReport{
 const date=(v:unknown)=>typeof v==='string'&&/^\d{4}-\d\d-\d\d$/.test(v);
 const totals=(v:Totals)=>{if(!v||![v.workedMs,v.paidBreakMs,v.mealBreakMs].every(n=>Number.isSafeInteger(n)&&n>=0)||v.paidBreakMs>v.workedMs)throw invalid();return {workedMs:v.workedMs,paidBreakMs:v.paidBreakMs,mealBreakMs:v.mealBreakMs};};
 if(data?.businessId!==businessId||!['employee','day','week','team'].includes(data.grouping)||!data.range||!date(data.range.startDate)||!date(data.range.endDate)||typeof data.timezone!=='string'||!Number.isFinite(Date.parse(data.snapshotAt))||!Number.isFinite(Date.parse(data.generatedAt))||!Array.isArray(data.rows)||data.rows.length>20000||typeof data.totals?.open!=='boolean'||typeof data.totals.corrected!=='boolean')throw invalid();
 try{new Intl.DateTimeFormat('en',{timeZone:data.timezone}).format();}catch{throw invalid();}
 const summaryRows=data.summaryRows;
 if(!Array.isArray(summaryRows))throw invalid();
 if(summaryRows!==undefined){if(!Array.isArray(summaryRows)||summaryRows.length>200)throw invalid();const ids=new Set<string>();for(const row of summaryRows){totals(row);if(!row||typeof row.employeeId!=='string'||ids.has(row.employeeId)||typeof row.employee!=='string'||!['employee','manager','owner'].includes(row.employeeRole)||typeof row.open!=='boolean'||typeof row.corrected!=='boolean'||row.workedMs<=0||row.finalPaidMs!==row.workedMs||row.activeWorkMs!==row.workedMs-row.paidBreakMs||row.activeWorkMs<0)throw invalid();ids.add(row.employeeId);}}
 if(summaryRows.reduce((sum,row)=>sum+row.finalPaidMs,0)!==data.totals.workedMs||summaryRows.reduce((sum,row)=>sum+row.paidBreakMs,0)!==data.totals.paidBreakMs)throw invalid();
 if(data.exceptions!==undefined&&(!Array.isArray(data.exceptions)||data.exceptions.length>200||data.exceptions.some(e=>typeof e.employeeId!=='string'||typeof e.employee!=='string'||typeof e.message!=='string')))throw invalid();
 return {summaryRows:summaryRows.map(row=>({employeeId:row.employeeId,employee:row.employee,employeeRole:row.employeeRole,...totals(row),activeWorkMs:row.activeWorkMs,finalPaidMs:row.finalPaidMs,open:row.open,corrected:row.corrected})),peopleWorked:summaryRows?.length,provisionalPeople:summaryRows?.filter(row=>row.open).length,exceptions:data.exceptions,integrityCoverage:data.integrityCoverage,businessId,timezone:data.timezone,range:{startDate:data.range.startDate,endDate:data.range.endDate},grouping:data.grouping,employeeFilter:data.employeeFilter,snapshotAt:data.snapshotAt,generatedAt:data.generatedAt,totals:{...totals(data.totals),open:data.totals.open,corrected:data.totals.corrected},rows:data.rows.map(r=>{if(!r||typeof r.employee!=='string'||(r.employeeId!==null&&typeof r.employeeId!=='string')||(r.date!==null&&!date(r.date))||(r.week!==null&&!date(r.week))||typeof r.open!=='boolean'||typeof r.corrected!=='boolean')throw invalid();return {...totals(r),employeeId:r.employeeId,employee:r.employee,date:r.date,week:r.week,open:r.open,corrected:r.corrected};})};
}
export async function getTimeReport(businessId:string,filters:ReportFilters,signal:AbortSignal){
 const params=new URLSearchParams(Object.entries(filters).filter(([,v])=>!!v));
 return parseReport(await operationalRequest(businessId,headers=>apiGet<TimeReport>('/api/management/time-reports?'+params.toString(),{businessId,signal,headers})),businessId);
}
export async function exportTimeReport(businessId:string,userId:string,filters:ReportFilters,signal:AbortSignal,format:ExportFormat="daily-v1"){
 const body=Object.fromEntries(Object.entries(filters).filter(([,v])=>!!v));
 const data=await operationalRequest(businessId,headers=>apiWrite<{businessId:string;report:TimeReport;csv:string;filename:string;auditId:string;format?:ExportFormat}>('/api/management/time-reports/export',{...body,format},{businessId,expectedUserId:userId,signal,method:'POST',headers}));
 if(data?.businessId!==businessId||typeof data.csv!=='string'||data.csv.length>2*1024*1024||typeof data.auditId!=='string')throw invalid();const report=parseReport(data.report,businessId);
 if(data.filename!==`zude-time-${report.range.startDate}-${report.range.endDate}${format==='daily-v1'?'':'-'+format}.csv`)throw invalid();
 if(data.format!==undefined&&data.format!==format)throw invalid();
 return {format,report,csv:data.csv,filename:data.filename,auditId:data.auditId};
}
export function reportMessage(e:unknown){if(e instanceof ZudeApiError){if(e.code==='TIME_INTEGRITY_ERROR')return 'Time records need review. A trustworthy hours report could not be produced.';if(e.status===400)return 'Choose valid dates through today, up to 93 local days.';if(e.code==='REPORT_LIMIT_EXCEEDED'||e.code==='WORKING_LIMIT_EXCEEDED')return 'The complete report is too large. Choose a smaller range or one employee.';if(e.code==='TIME_LEDGER_CHANGED')return 'Time records changed during loading. Please refresh.';if(e.code==='SHARING_UNAVAILABLE')return 'CSV file sharing is unavailable on this device.';if([401,403,404].includes(e.status))return 'Your access changed. Unlock or refresh to continue.';}return 'Unable to load or export this report. Please retry.';}

export async function getReportDirectory(businessId:string,signal:AbortSignal){
 const data=await operationalRequest(businessId,headers=>apiGet<{businessId:string;employees:{id:string;name:string;role:string;isActive:boolean}[]}>('/api/management/time-reports/directory',{businessId,signal,headers}));
 if(data?.businessId!==businessId||!Array.isArray(data.employees)||data.employees.length>200)throw invalid();
 const ids=new Set<string>();for(const e of data.employees){if(!e||typeof e.id!=='string'||!e.id||ids.has(e.id)||typeof e.name!=='string'||!['employee','manager','owner'].includes(e.role)||typeof e.isActive!=='boolean')throw invalid();ids.add(e.id);}
 return {employees:data.employees.map(e=>({id:e.id,name:e.name,role:e.role,isActive:e.isActive}))};
}
