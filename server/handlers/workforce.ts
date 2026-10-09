import { createSupabaseServiceClient } from '@/lib/supabase-server';
import { managementTime,managementTimeFailure,invalidManagement } from '../management-time';
import { consistentLedgerRead,businessTimezone } from '../time-ledger';
import { businessWeek } from '../time-calculation';
import { timeReport } from '../time-reports';
import { readJson } from '../read-api';
export async function GET(request:Request){try{
 const actor=await managementTime(request);if(!actor.ok)return actor.response;
 const params=new URL(request.url).searchParams;if([...params.keys()].some(k=>k!=='date')||params.getAll('date').length>1)return invalidManagement();
 const db=createSupabaseServiceClient();return await consistentLedgerRead(db,actor.businessId,null,async()=>{
 const timezone=await businessTimezone(db,actor.businessId);
 const date=params.get('date')??businessWeek(Date.now(),timezone).today;
 const report=await timeReport(db,actor.businessId,actor.authority,{startDate:date,endDate:date});
 return readJson({success:true,businessId:actor.businessId,date:report.range.startDate,timezone:report.timezone,snapshotAt:report.snapshotAt,
 employees:report.workforceRows.filter(row=>row.finalPaidMs>0||row.open||row.mealBreakMs>0),exceptions:report.exceptions});
 });
}catch(e){return managementTimeFailure(e);}}
