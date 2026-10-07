import { apiGet,apiWrite,ZudeApiError } from './api';
import { operationalRequest } from './operational-identity';
import { parseTimesheet,type Timesheet } from './timesheets-api';
export type TimeIssue={id:string;employee_id:string;employee_name:string;employee_role:'employee'|'manager'|'owner';is_active:boolean;note:string;work_date:string|null;time_event_id:string|null;created_at:string;status:'open'|'resolved';resolution:{id:string;note:string;recordedAt:string;correctionId:string|null;auditId:string}|null};
export type IssuePage={businessId:string;issues:TimeIssue[];nextCursor:string|null};
export type IssueDetail={businessId:string;issue:TimeIssue;timesheet:Timesheet;referencedEventVoided:boolean;originalEvent:{event_type:string;occurred_at:string}|null;currentEvent:{event_type:string;occurred_at:string}|null;recentCorrections:{id:string;reason:string;created_at:string;revision:number}[]};
const invalid=()=>new ZudeApiError(0,'INVALID_RESPONSE','Unable to verify issue records.');
function issue(v:TimeIssue):TimeIssue{
 if(!v||typeof v.id!=='string'||typeof v.employee_id!=='string'||typeof v.employee_name!=='string'||typeof v.note!=='string'||!['open','resolved'].includes(v.status)||!['employee','manager','owner'].includes(v.employee_role)||!Number.isFinite(Date.parse(v.created_at))||typeof v.is_active!=='boolean')throw invalid();
 if(v.resolution&&(typeof v.resolution.id!=='string'||typeof v.resolution.note!=='string'||!Number.isFinite(Date.parse(v.resolution.recordedAt))))throw invalid();
 return {id:v.id,employee_id:v.employee_id,employee_name:v.employee_name,employee_role:v.employee_role,is_active:v.is_active,note:v.note,work_date:v.work_date,time_event_id:v.time_event_id,created_at:v.created_at,status:v.status,resolution:v.resolution?{id:v.resolution.id,note:v.resolution.note,recordedAt:v.resolution.recordedAt,correctionId:v.resolution.correctionId,auditId:v.resolution.auditId}:null};
}
export async function getIssues(businessId:string,status:string,cursor:string|null,signal:AbortSignal):Promise<IssuePage>{
 const data=await operationalRequest(businessId,headers=>apiGet<IssuePage>(`/api/management/time-issues?status=${encodeURIComponent(status)}${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`,{businessId,signal,headers}));
 if(data?.businessId!==businessId||!Array.isArray(data.issues)||data.issues.length>50||(data.nextCursor!==null&&typeof data.nextCursor!=='string'))throw invalid();
 return {businessId,issues:data.issues.map(issue),nextCursor:data.nextCursor};
}
export async function getIssue(businessId:string,id:string,signal:AbortSignal):Promise<IssueDetail>{
 const data=await operationalRequest(businessId,headers=>apiGet<IssueDetail>(`/api/management/time-issues/${encodeURIComponent(id)}`,{businessId,signal,headers}));
 if(data?.businessId!==businessId||data.issue?.id!==id||typeof data.referencedEventVoided!=='boolean'||!Array.isArray(data.recentCorrections)||data.recentCorrections.length>50)throw invalid();
 return {businessId,issue:issue(data.issue),timesheet:parseTimesheet(data.timesheet,businessId,data.issue.employee_id,null),referencedEventVoided:data.referencedEventVoided,
 originalEvent:data.originalEvent?{event_type:data.originalEvent.event_type,occurred_at:data.originalEvent.occurred_at}:null,currentEvent:data.currentEvent?{event_type:data.currentEvent.event_type,occurred_at:data.currentEvent.occurred_at}:null,
 recentCorrections:data.recentCorrections.map(c=>{if(typeof c.id!=='string'||typeof c.reason!=='string'||!Number.isFinite(Date.parse(c.created_at))||!Number.isSafeInteger(c.revision))throw invalid();return {id:c.id,reason:c.reason,created_at:c.created_at,revision:c.revision};})};
}
export async function resolveIssue(businessId:string,userId:string,id:string,intent:{key:string;note:string;correctionId:string|null},signal:AbortSignal){
 const data=await operationalRequest(businessId,headers=>apiWrite<{businessId:string;resolution:{id:string;replayed:boolean}}>(`/api/management/time-issues/${encodeURIComponent(id)}/resolve`,{note:intent.note,correctionId:intent.correctionId},{businessId,expectedUserId:userId,signal,method:'POST',headers:{...headers,'Idempotency-Key':intent.key}}));
 if(data?.businessId!==businessId||typeof data.resolution?.id!=='string'||typeof data.resolution.replayed!=='boolean')throw invalid();return data.resolution;
}
export function issueMessage(error:unknown){
 if(error instanceof ZudeApiError){if([401,403,404].includes(error.status))return 'Your access changed. Unlock or refresh to continue.';if(error.status===409)return 'This issue or request changed. Refresh to view its current resolution.';if(error.code==='TIME_LEDGER_CHANGED')return 'Time records changed while loading. Please refresh.';}
 return 'Unable to load or save this issue. Please retry.';
}
