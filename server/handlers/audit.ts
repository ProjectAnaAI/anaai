import { isUuid } from '@/lib/appointment-actions';
import { createSupabaseServiceClient } from '@/lib/supabase-server';
import { readJson } from '../read-api';
import { businessTimezone } from '../time-ledger';
import { invalidManagement,localRange,managementTime,managementTimeFailure,nextCursor,pageCursor } from '../management-time';
export const AUDIT_ACTIONS=['employee.created','employee.updated','employee.role_changed','employee.deactivated','employee.reactivated','employee.pin_reset','time.corrected','time.issue_resolved','report.exported'];
export async function GET(request:Request){try{
 const actor=await managementTime(request);if(!actor.ok)return actor.response;const p=new URL(request.url).searchParams;
 if([...p.keys()].some(k=>!['employeeId','action','category','startDate','endDate','cursor'].includes(k)||p.getAll(k).length!==1))return invalidManagement();
 const employee=p.get('employeeId'),action=p.get('action'),category=p.get('category');
 if((employee!==null&&!isUuid(employee))||(action!==null&&!AUDIT_ACTIONS.includes(action))||(category!==null&&!['team','time','reports'].includes(category)))return invalidManagement();
 const db=createSupabaseServiceClient(),timezone=await businessTimezone(db,actor.businessId),range=localRange(timezone,p.get('startDate'),p.get('endDate')),cursor=pageCursor(p.get('cursor'));
 const {data,error}=await db.rpc('m06_audit_page',{p_business_id:actor.businessId,p_role:actor.authority.role,p_employee_id:employee,p_action:action,p_category:category,p_from:new Date(range.startsAt).toISOString(),p_to:new Date(range.endsAt).toISOString(),p_before_at:cursor?.at??null,p_before_id:cursor?.id??null});
 if(error||!Array.isArray(data))throw Error('Audit unavailable');
 return readJson({success:true,businessId:actor.businessId,timezone,range:{startDate:range.startDate,endDate:range.endDate},entries:data.slice(0,50),nextCursor:nextCursor(data)});
 }catch(e){return managementTimeFailure(e);}}
