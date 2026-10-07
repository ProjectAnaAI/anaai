import { apiGet,apiWrite,ZudeApiError } from './api';
import { operationalRequest } from './operational-identity';
export type ReportFilters={startDate?:string;endDate?:string;employeeId?:string;grouping?:'employee'|'day'|'week'|'team'};
type Totals={workedMs:number;paidBreakMs:number;mealBreakMs:number};
export type ReportRow=Totals&{employeeId:string|null;employee:string;date:string|null;week:string|null;open:boolean;corrected:boolean};
export type TimeReport={businessId:string;timezone:string;range:{startDate:string;endDate:string};grouping:NonNullable<ReportFilters['grouping']>;employeeFilter:string|null;snapshotAt:string;generatedAt:string;totals:Totals&{open:boolean;corrected:boolean};rows:ReportRow[]};
const invalid=()=>new ZudeApiError(0,'INVALID_RESPONSE','Unable to verify this report.');
function parseReport(data:TimeReport,businessId:string):TimeReport{
 const date=(v:unknown)=>typeof v==='string'&&/^\d{4}-\d\d-\d\d$/.test(v);
 const totals=(v:Totals)=>{if(!v||![v.workedMs,v.paidBreakMs,v.mealBreakMs].every(n=>Number.isSafeInteger(n)&&n>=0))throw invalid();return {workedMs:v.workedMs,paidBreakMs:v.paidBreakMs,mealBreakMs:v.mealBreakMs};};
 if(data?.businessId!==businessId||!['employee','day','week','team'].includes(data.grouping)||!data.range||!date(data.range.startDate)||!date(data.range.endDate)||typeof data.timezone!=='string'||!Number.isFinite(Date.parse(data.snapshotAt))||!Number.isFinite(Date.parse(data.generatedAt))||!Array.isArray(data.rows)||data.rows.length>20000||typeof data.totals?.open!=='boolean'||typeof data.totals.corrected!=='boolean')throw invalid();
 try{new Intl.DateTimeFormat('en',{timeZone:data.timezone}).format();}catch{throw invalid();}
 return {businessId,timezone:data.timezone,range:{startDate:data.range.startDate,endDate:data.range.endDate},grouping:data.grouping,employeeFilter:data.employeeFilter,snapshotAt:data.snapshotAt,generatedAt:data.generatedAt,totals:{...totals(data.totals),open:data.totals.open,corrected:data.totals.corrected},rows:data.rows.map(r=>{if(!r||typeof r.employee!=='string'||(r.employeeId!==null&&typeof r.employeeId!=='string')||(r.date!==null&&!date(r.date))||(r.week!==null&&!date(r.week))||typeof r.open!=='boolean'||typeof r.corrected!=='boolean')throw invalid();return {...totals(r),employeeId:r.employeeId,employee:r.employee,date:r.date,week:r.week,open:r.open,corrected:r.corrected};})};
}
export async function getTimeReport(businessId:string,filters:ReportFilters,signal:AbortSignal){
 const params=new URLSearchParams(Object.entries(filters).filter(([,v])=>!!v));
 return parseReport(await operationalRequest(businessId,headers=>apiGet<TimeReport>('/api/management/time-reports?'+params.toString(),{businessId,signal,headers})),businessId);
}
export async function exportTimeReport(businessId:string,userId:string,filters:ReportFilters,signal:AbortSignal){
 const body=Object.fromEntries(Object.entries(filters).filter(([,v])=>!!v));
 const data=await operationalRequest(businessId,headers=>apiWrite<{businessId:string;report:TimeReport;csv:string;filename:string;auditId:string}>('/api/management/time-reports/export',body,{businessId,expectedUserId:userId,signal,method:'POST',headers}));
 if(data?.businessId!==businessId||typeof data.csv!=='string'||data.csv.length>2*1024*1024||typeof data.auditId!=='string')throw invalid();const report=parseReport(data.report,businessId);
 if(data.filename!==`zude-time-${report.range.startDate}-${report.range.endDate}.csv`)throw invalid();
 return {report,csv:data.csv,filename:data.filename,auditId:data.auditId};
}
export function reportMessage(e:unknown){if(e instanceof ZudeApiError){if(e.status===400)return 'Choose valid dates through today, up to 93 local days.';if(e.code==='REPORT_LIMIT_EXCEEDED'||e.code==='WORKING_LIMIT_EXCEEDED')return 'The complete report is too large. Choose a smaller range or one employee.';if(e.code==='TIME_LEDGER_CHANGED')return 'Time records changed during loading. Please refresh.';if(e.code==='SHARING_UNAVAILABLE')return 'CSV file sharing is unavailable on this device.';if([401,403,404].includes(e.status))return 'Your access changed. Unlock or refresh to continue.';}return 'Unable to load or export this report. Please retry.';}
