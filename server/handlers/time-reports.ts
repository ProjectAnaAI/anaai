import { createSupabaseServiceClient } from '@/lib/supabase-server';
import { jsonBody } from '../member';
import { managementWriteActor } from '../operational-authority';
import { readFailure,readJson } from '../read-api';
import { invalidManagement,managementTime,managementTimeFailure } from '../management-time';
import { reportCsv,reportInputs,timeReport } from '../time-reports';
export async function GET(request:Request){try{
 const actor=await managementTime(request);if(!actor.ok)return actor.response;const p=new URL(request.url).searchParams;if([...p.keys()].some(k=>p.getAll(k).length!==1))return invalidManagement();
 const report=await timeReport(createSupabaseServiceClient(),actor.businessId,actor.authority.role,reportInputs(Object.fromEntries(p)));
 const {employeeIds:_,...view}=report;void _;return readJson({success:true,...view});
 }catch(e){return managementTimeFailure(e);}}
export async function EXPORT(request:Request){try{
 const actor=await managementTime(request);if(!actor.ok)return actor.response;if(new URL(request.url).search)return invalidManagement();const body=await jsonBody(request,['startDate','endDate','employeeId','grouping']);if(!body)return invalidManagement();
 const db=createSupabaseServiceClient(),report=await timeReport(db,actor.businessId,actor.authority.role,reportInputs(body)),csv=reportCsv(report);
 // Audit commit revalidates actor and every exported target. No CSV is returned
 // if authorization changed or audit failed. No second calculation is made.
 const {data,error}=await db.rpc('m06_record_time_export',{p_business_id:actor.businessId,...managementWriteActor(actor.authority),p_start_date:report.range.startDate,p_end_date:report.range.endDate,p_employee_id:report.employeeFilter,p_employee_ids:report.employeeIds,p_grouping:report.grouping,p_row_count:report.rows.length,p_generated_at:report.generatedAt});
 if(error){if(error.code==='28000')return readFailure(401,'IDENTITY_UNAUTHORIZED','Unlock again to continue.');if(error.code==='42501')return readFailure(403,'ROLE_FORBIDDEN','Export access changed. Refresh before continuing.');throw Error('Export audit unavailable');}
 if(typeof data?.id!=='string')throw Error('Export audit unavailable');const {employeeIds:_,...view}=report;void _;
 return readJson({success:true,businessId:actor.businessId,report:view,csv,filename:`zude-time-${report.range.startDate}-${report.range.endDate}.csv`,auditId:data.id});
 }catch(e){return managementTimeFailure(e);}}
