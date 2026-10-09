import { apiGet,ZudeApiError } from './api';
import { operationalRequest } from './operational-identity';
import type { HoursSummary } from './time-reports-api';
export type WorkforcePerson=HoursSummary&{state:'OFF_CLOCK'|'WORKING'|'ON_PAID_BREAK'|'ON_MEAL_BREAK';isActive:boolean};
export type WorkforceView={businessId:string;date:string;timezone:string;snapshotAt:string;employees:WorkforcePerson[];exceptions:{employeeId:string;employee:string;message:string}[]};
export async function getWorkforce(businessId:string,signal:AbortSignal,date?:string):Promise<WorkforceView>{
 const data=await operationalRequest(businessId,headers=>apiGet<WorkforceView>('/api/management/workforce'+(date?'?date='+encodeURIComponent(date):''),{businessId,signal,headers}));
 const invalid=()=>new ZudeApiError(0,'INVALID_RESPONSE','Unable to verify daily workforce hours.');
 if(data?.businessId!==businessId||typeof data.timezone!=='string'||!data.timezone||! /^\d{4}-\d{2}-\d{2}$/.test(data.date)||!Number.isFinite(Date.parse(data.date+'T00:00:00Z'))||new Date(data.date+'T00:00:00Z').toISOString().slice(0,10)!==data.date||(date!==undefined&&data.date!==date)||!Number.isFinite(Date.parse(data.snapshotAt))||!Array.isArray(data.employees)||data.employees.length>200||!Array.isArray(data.exceptions))throw invalid();
 try{new Intl.DateTimeFormat('en',{timeZone:data.timezone}).format();}catch{throw invalid();}
 const ids=new Set<string>();const employees=data.employees.map(row=>{
 if(!row||typeof row.employeeId!=='string'||!row.employeeId||ids.has(row.employeeId)||typeof row.employee!=='string'||!['employee','manager','owner'].includes(row.employeeRole)||!['OFF_CLOCK','WORKING','ON_PAID_BREAK','ON_MEAL_BREAK'].includes(row.state)||typeof row.isActive!=='boolean'||typeof row.open!=='boolean'||typeof row.corrected!=='boolean'||![row.activeWorkMs,row.finalPaidMs,row.workedMs,row.paidBreakMs,row.mealBreakMs].every(n=>Number.isSafeInteger(n)&&n>=0)||row.finalPaidMs!==row.workedMs||row.activeWorkMs+row.paidBreakMs!==row.finalPaidMs||!(row.finalPaidMs>0||row.open||row.mealBreakMs>0))throw invalid();
 ids.add(row.employeeId);return {employeeId:row.employeeId,employee:row.employee,employeeRole:row.employeeRole,state:row.state,isActive:row.isActive,open:row.open,corrected:row.corrected,activeWorkMs:row.activeWorkMs,finalPaidMs:row.finalPaidMs,workedMs:row.workedMs,paidBreakMs:row.paidBreakMs,mealBreakMs:row.mealBreakMs};
 });
 if(data.exceptions.length>200||data.exceptions.some(e=>!e||typeof e.employeeId!=='string'||typeof e.employee!=='string'||typeof e.message!=='string'))throw invalid();
 return {businessId,date:data.date,timezone:data.timezone,snapshotAt:data.snapshotAt,employees,exceptions:data.exceptions.map(e=>({employeeId:e.employeeId,employee:e.employee,message:e.message}))};
}
