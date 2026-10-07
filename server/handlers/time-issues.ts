import { isUuid } from '@/lib/appointment-actions';
import { createSupabaseServiceClient } from '@/lib/supabase-server';
import { jsonBody, pathId } from '../member';
import { managementWriteActor } from '../operational-authority';
import { readFailure, readJson } from '../read-api';
import { invalidManagement, managementTime, managementTimeFailure, nextCursor, pageCursor } from '../management-time';
import { businessWeek, localDayStart } from '../time-calculation';
import { businessTimezone, consistentLedgerRead, EFFECTIVE_EVENTS, historicalLedger, timesheetEventFields } from '../time-ledger';
import { timesheetBody } from './timesheets';
type Issue={id:string;employee_id:string;employee_name:string;employee_role:'employee'|'manager'|'owner';is_active:boolean;note:string;work_date:string|null;time_event_id:string|null;created_at:string;status:'open'|'resolved';resolution:{id:string;note:string;recordedAt:string;correctionId:string|null;auditId:string}|null};
export async function GET(request:Request){
 try{
 const actor=await managementTime(request);if(!actor.ok)return actor.response;
 const params=new URL(request.url).searchParams;if([...params.keys()].some(k=>!['status','cursor'].includes(k)||params.getAll(k).length!==1))return invalidManagement();
 const status=params.get('status')??'open';if(!['open','resolved','all'].includes(status))return invalidManagement();const cursor=pageCursor(params.get('cursor'));
 const {data,error}=await createSupabaseServiceClient().rpc('m06_time_issues_page',{p_business_id:actor.businessId,p_role:actor.authority.role,p_issue_id:null,p_status:status==='all'?null:status,p_before_at:cursor?.at??null,p_before_id:cursor?.id??null});
 if(error||!Array.isArray(data))throw Error('Issue list unavailable');
 return readJson({success:true,businessId:actor.businessId,issues:data.slice(0,50),nextCursor:nextCursor(data)});
 }catch(e){return managementTimeFailure(e);}
}
export async function DETAIL(request:Request){
 try{
 const actor=await managementTime(request);if(!actor.ok)return actor.response;const id=pathId(request);if(!isUuid(id)||new URL(request.url).search)return invalidManagement();const db=createSupabaseServiceClient();
 const {data,error}=await db.rpc('m06_time_issues_page',{p_business_id:actor.businessId,p_role:actor.authority.role,p_issue_id:id,p_status:null,p_before_at:null,p_before_id:null});
 if(error||!Array.isArray(data))throw Error('Issue unavailable');const issue=data[0] as Issue|undefined;if(!issue)return readFailure(404,'ISSUE_NOT_FOUND','Issue unavailable to your current role.');
 // Original event is immutable provenance only. Effective context and the
 // timesheet are accepted together under the Slice 4.1 version protocol.
 const context=await consistentLedgerRead(db,actor.businessId,issue.employee_id,async()=>{
 const timezone=await businessTimezone(db,actor.businessId);
 let original=null,current=null;
 if(issue.time_event_id){
 const raw=await db.from('employee_time_events').select('id,event_type,break_type,occurred_at').eq('business_id',actor.businessId).eq('employee_id',issue.employee_id).eq('id',issue.time_event_id).maybeSingle();
 const effective=await db.from(EFFECTIVE_EVENTS).select(timesheetEventFields).eq('business_id',actor.businessId).eq('employee_id',issue.employee_id).eq('id',issue.time_event_id).maybeSingle();
 if(raw.error||effective.error)throw Error('Issue context unavailable');original=raw.data;current=effective.data;
 }
 const anchor=issue.work_date?localDayStart(issue.work_date,timezone):Date.parse(current?.occurred_at??original?.occurred_at??issue.created_at);
 const ledger=await historicalLedger(db,actor.businessId,issue.employee_id,businessWeek(anchor,timezone).startDate);
 const sheet=timesheetBody(actor.businessId,{id:issue.employee_id,display_name:issue.employee_name,role:issue.employee_role,is_active:issue.is_active},ledger.timezone,ledger.snapshot,ledger,ledger.events);
 const corrections=await db.from('employee_time_corrections').select('id,reason,created_at,revision').eq('business_id',actor.businessId).eq('employee_id',issue.employee_id).order('revision',{ascending:false}).limit(50);
 if(corrections.error)throw Error('Correction references unavailable');
 return {originalEvent:original,currentEvent:current,referencedEventVoided:!!original&&!current,timesheet:sheet,recentCorrections:corrections.data??[]};
 });
 return readJson({success:true,businessId:actor.businessId,issue,...context});
 }catch(e){return managementTimeFailure(e);}
}
export async function RESOLVE(request:Request){
 try{
 const actor=await managementTime(request);if(!actor.ok)return actor.response;
 const parts=new URL(request.url).pathname.split('/').filter(Boolean),id=parts.at(-2),key=request.headers.get('idempotency-key');
 const body=await jsonBody(request,['note','correctionId']);const note=typeof body?.note==='string'?body.note.trim():'';
 if(!isUuid(id)||!isUuid(key)||new URL(request.url).search||!body||note.length<3||note.length>500||!/[\p{L}\p{N}]/u.test(note)||(body.correctionId!=null&&!isUuid(body.correctionId)))return invalidManagement();
 const {data,error}=await createSupabaseServiceClient().rpc('m06_resolve_time_issue',{p_business_id:actor.businessId,p_issue_id:id,...managementWriteActor(actor.authority),p_note:note,p_correction_id:body.correctionId??null,p_request_id:key});
 if(error){
 if(error.code==='28000')return readFailure(401,'IDENTITY_UNAUTHORIZED','Unlock again to continue.');
 if(error.code==='42501')return readFailure(403,'ROLE_FORBIDDEN','Your current role cannot resolve this issue.');
 if(error.code==='Z0003')return readFailure(404,'ISSUE_NOT_FOUND','Issue unavailable.');
 if(error.code==='22023')return invalidManagement();
 if(error.code==='23505')return readFailure(409,'TIME_REQUEST_CONFLICT','This request was already used. Refresh and retry.');
 throw Error('Resolution unavailable');}
 if(data?.ok!==true)return readFailure(409,data?.code==='TIME_REQUEST_CONFLICT'?'TIME_REQUEST_CONFLICT':'ISSUE_ALREADY_RESOLVED','This issue or request changed. Refresh before continuing.');
 return readJson({success:true,businessId:actor.businessId,resolution:{id:data.id,replayed:data.replayed===true}},data.replayed?200:201);
 }catch(e){return managementTimeFailure(e);}
}
