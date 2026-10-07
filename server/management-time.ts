import { addDays,businessWeek,localDayStart } from './time-calculation';
import { isUuid } from '@/lib/appointment-actions';
import { authorizedMember } from './member';
import { managementAuthority, managementForbidden } from './operational-authority';
import { readFailure } from './read-api';
import { TimeFailure } from './time-ledger';
export async function managementTime(request: Request) {
 const member=await authorizedMember(request); if(!member.ok)return member;
 const managed=await managementAuthority(request,member.context);if(!managed.ok)return managed;
 const allowed=(role:string)=>role==='manager'||role==='owner';
 if(!allowed(managed.authority.role))return {ok:false as const,response:managementForbidden(managed.authority,allowed,'This view is for managers and owners.')};
 return {ok:true as const,businessId:member.context.businessId,authority:managed.authority};
}
export function managementTimeFailure(error: unknown) {
 return error instanceof TimeFailure?readFailure(error.status,error.code,error.message):readFailure(503,'TIME_UNAVAILABLE','Unable to load time records. Please retry.');
}
export const invalidManagement=()=>readFailure(400,'INVALID_REQUEST','Check the request and try again.');
export function pageCursor(raw: string|null): {at:string;id:string}|null {
 if(!raw)return null;
 try{if(raw.length>300)throw Error();const v=JSON.parse(Buffer.from(raw,'base64url').toString('utf8'));
 if(!v||typeof v.at!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(v.at)||!Number.isFinite(Date.parse(v.at))||!isUuid(v.id))throw Error();return {at:v.at,id:v.id};
 }catch{throw new TimeFailure(400,'INVALID_REQUEST','Invalid page cursor.');}
}
export function nextCursor(rows: {id:string;created_at?:string;recorded_at?:string}[]) {
 const last=rows[49];return rows.length>50?Buffer.from(JSON.stringify({at:last.created_at??last.recorded_at,id:last.id})).toString('base64url'):null;
}

// Inclusive business-local dates, bounded independently of DST day length.
export function localRange(timezone:string,start:string|null,end:string|null,snapshot=Date.now()){
 const today=businessWeek(snapshot,timezone).today;
 const from=start??addDays(today,-29),to=end??today;
 const valid=(s:string)=>/^\d{4}-\d\d-\d\d$/.test(s)&&Number.isFinite(Date.parse(s+'T00:00:00Z'))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
 if(!valid(from)||!valid(to)||from>to||to>today)throw new TimeFailure(400,'INVALID_RANGE','Choose valid dates through today.');
 const count=(Date.parse(to+'T00:00:00Z')-Date.parse(from+'T00:00:00Z'))/86400000+1;
 if(count>93)throw new TimeFailure(400,'INVALID_RANGE','Choose no more than 93 local days.');
 const days=Array.from({length:count},(_,i)=>{const date=addDays(from,i);return {date,startsAt:localDayStart(date,timezone),endsAt:localDayStart(addDays(date,1),timezone)};});
 if(days.some(d=>d.endsAt<=d.startsAt))throw new TimeFailure(400,'INVALID_RANGE','This local date range is unavailable.');
 return {startDate:from,endDate:to,startsAt:days[0].startsAt,endsAt:days.at(-1)!.endsAt,days};
}
