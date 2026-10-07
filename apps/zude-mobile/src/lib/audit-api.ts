import { apiGet,ZudeApiError } from './api';
import { operationalRequest } from './operational-identity';
export type AuditEntry={id:string;employee_id:string|null;employee_name:string|null;recorded_at:string;action:string;actor:{userId:string;employeeId:string|null;name:string|null;mode:string};before_value:Record<string,unknown>|null;after_value:Record<string,unknown>;reason:string|null;correction_id:string|null;issue_id:string|null;pin_reset:boolean};
export type AuditPage={businessId:string;timezone:string;range:{startDate:string;endDate:string};entries:AuditEntry[];nextCursor:string|null};
export async function getAudit(businessId:string,filters:{employeeId?:string;category?:string;action?:string;startDate?:string;endDate?:string;cursor?:string},signal:AbortSignal):Promise<AuditPage>{
 const p=new URLSearchParams(Object.entries(filters).filter(([,v])=>!!v));
 const data=await operationalRequest(businessId,headers=>apiGet<AuditPage>('/api/management/audit?'+p.toString(),{businessId,signal,headers}));
 const invalid=()=>new ZudeApiError(0,'INVALID_RESPONSE','Unable to verify audit history.');
 if(data?.businessId!==businessId||!Array.isArray(data.entries)||data.entries.length>50||!data.range||typeof data.timezone!=='string'||(data.nextCursor!==null&&typeof data.nextCursor!=='string'))throw invalid();
 const safe=(value:Record<string,unknown>|null)=>{if(value===null)return null;if(!value||typeof value!=='object'||Array.isArray(value))throw invalid();const allowed=['display_name','role','is_active','revision','watermark','state','event_count','operation_count','status','start_date','end_date','employee_filter','grouping','row_count','generated_at'];return Object.fromEntries(Object.entries(value).filter(([k,v])=>allowed.includes(k)&&(v===null||['string','number','boolean'].includes(typeof v))));};
 return {businessId,timezone:data.timezone,range:{startDate:data.range.startDate,endDate:data.range.endDate},nextCursor:data.nextCursor,entries:data.entries.map(e=>{
 if(!e||typeof e.id!=='string'||typeof e.action!=='string'||!Number.isFinite(Date.parse(e.recorded_at))||!e.actor||typeof e.actor.userId!=='string'||!['account','shared-device'].includes(e.actor.mode))throw invalid();
 return {id:e.id,employee_id:e.employee_id,employee_name:e.employee_name,recorded_at:e.recorded_at,action:e.action,actor:{userId:e.actor.userId,employeeId:e.actor.employeeId,name:e.actor.name,mode:e.actor.mode},before_value:safe(e.before_value),after_value:safe(e.after_value)!,reason:e.reason,correction_id:e.correction_id,issue_id:e.issue_id,pin_reset:e.pin_reset===true};})};
}
export function auditMessage(e:unknown){return e instanceof ZudeApiError&&e.status===400?'Choose valid dates (up to 93 days) and filters.':'Unable to load audit history. Refresh or unlock again.';}
