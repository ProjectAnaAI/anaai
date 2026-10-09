import { createSupabaseServiceClient } from '@/lib/supabase-server';
import { jsonBody } from '../member';
import { managementWriteActor } from '../operational-authority';
import { readFailure,readJson } from '../read-api';
import { invalidManagement,managementTime,managementTimeFailure } from '../management-time';
import { EXPORT_FORMATS,exportRows,hoursCsv,reportInputs,timeReport,type ExportFormat } from '../time-reports';
export async function GET(request:Request){try{
 const actor=await managementTime(request);if(!actor.ok)return actor.response;const p=new URL(request.url).searchParams;if([...p.keys()].some(k=>p.getAll(k).length!==1))return invalidManagement();
 const report=await timeReport(createSupabaseServiceClient(),actor.businessId,actor.authority,reportInputs(Object.fromEntries(p)));
 const {employeeIds:_,dailyRows:__,allocations:___,workforceRows:____,...view}=report;void _;void __;void ___;void ____;return readJson({success:true,...view});
 }catch(e){return managementTimeFailure(e);}}
export async function EXPORT(request:Request){try{
 const actor=await managementTime(request);if(!actor.ok)return actor.response;if(new URL(request.url).search)return invalidManagement();const body=await jsonBody(request,['startDate','endDate','employeeId','grouping','format']);if(!body)return invalidManagement();
 const {format:rawFormat,...filters}=body;const format=(rawFormat??'daily-v1') as ExportFormat;if(!EXPORT_FORMATS.includes(format))return invalidManagement();
 const db=createSupabaseServiceClient(),report=await timeReport(db,actor.businessId,actor.authority,reportInputs(filters),true),csv=hoursCsv(report,format);
 // Audit commit revalidates actor and every exported target. No CSV is returned
 // if authorization changed or audit failed. No second calculation is made.
 const {data,error}=await db.rpc('m06_record_time_export',{p_business_id:actor.businessId,...managementWriteActor(actor.authority),p_start_date:report.range.startDate,p_end_date:report.range.endDate,p_employee_id:report.employeeFilter,p_employee_ids:report.employeeIds,p_grouping:format==='summary-v1'?'employee':'day',p_row_count:exportRows(report,format),p_generated_at:report.generatedAt});
 if(error){if(error.code==='28000')return readFailure(401,'IDENTITY_UNAUTHORIZED','Unlock again to continue.');if(error.code==='42501')return readFailure(403,'ROLE_FORBIDDEN','Export access changed. Refresh before continuing.');throw Error('Export audit unavailable');}
 if(typeof data?.id!=='string')throw Error('Export audit unavailable');const {employeeIds:_,workforceRows:__,...view}=report;void _;void __;
 return readJson({success:true,businessId:actor.businessId,report:view,csv,format,filename:`zude-time-${report.range.startDate}-${report.range.endDate}${format==='daily-v1'?'':'-'+format}.csv`,auditId:data.id});
 }catch(e){return managementTimeFailure(e);}}

export async function DIRECTORY(request:Request){try{
 const actor=await managementTime(request);if(!actor.ok)return actor.response;if(new URL(request.url).search)return invalidManagement();
 const {data,error}=await createSupabaseServiceClient().rpc('wf01_report_directory',{p_business_id:actor.businessId,...managementWriteActor(actor.authority)});
 if(error){if(error.code==='54000')return readFailure(503,'REPORT_LIMIT_EXCEEDED','Choose a smaller report scope.');if(error.code==='28000')return readFailure(401,'IDENTITY_UNAUTHORIZED','Unlock again.');if(error.code==='42501')return readFailure(403,'ROLE_FORBIDDEN','Access changed.');throw new Error('Report directory unavailable');}
 if(!Array.isArray(data)||data.length>200)throw new Error('Incomplete report directory');
 return readJson({success:true,businessId:actor.businessId,employees:data});
}catch(e){return managementTimeFailure(e);}}
