// Only controlled server text crosses the action response boundary. Model prose
// is never evidence of a mutation, including when the model calls no tools.
export type BookingInput = { customer_name: string; customer_phone: string; customer_email: string | null; service_name: string; date: string; time: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
export function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function canonicalTime(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.(\d{1,6}))?)?$/.exec(value);
  return match ? `${match[1]}:${match[2]}:${match[3] || '00'}.${(match[4] || '').padEnd(6, '0')}` : null;
}
export function bookingInput(value: unknown): BookingInput | null {
  if (!record(value)) return null;
  const keys = ['customer_name','customer_phone','customer_email','service_name','date','time'];
  if (Object.keys(value).some(key => !keys.includes(key))) return null;
  for (const key of keys.filter(key => key !== 'customer_email')) {
    if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 200) return null;
  }
  if (value.customer_email !== null && (typeof value.customer_email !== 'string' || value.customer_email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.customer_email))) return null;
  if (!validDate(value.date) || !canonicalTime(value.time) || !/^\d{2}:\d{2}$/.test(value.time as string)) return null;
  if (!/^[+\d\s().-]{7,30}$/.test(value.customer_phone as string)) return null;
  return Object.fromEntries(keys.map(key => [key, typeof value[key] === 'string' ? value[key].trim() : value[key]])) as BookingInput;
}
export function uniqueService<T extends {name:string}>(services:T[], name:string):T | null {
  const normalized = name.trim().toLowerCase();
  const exact = services.filter(s => s.name.trim().toLowerCase() === normalized);
  if (exact.length) return exact.length === 1 ? exact[0] : null;
  const partial = services.filter(s => s.name.trim().toLowerCase().includes(normalized));
  return partial.length === 1 ? partial[0] : null;
}
export type BookingReceipt = { success:true; appointment_id:string; customer_id:string; business_id:string; service_id:string; service:string; date:string; time:string; status:'Booked' };
export function bookingReceipt(value:unknown, businessId:string, serviceId:string, date:string, time:string):BookingReceipt | null {
  if (!record(value) || value.success !== true || value.status !== 'Booked') return null;
  for (const key of ['appointment_id','customer_id','business_id','service_id']) if (typeof value[key] !== 'string' || !uuid.test(value[key])) return null;
  if ((value.business_id as string).toLowerCase() !== businessId.toLowerCase() || (value.service_id as string).toLowerCase() !== serviceId.toLowerCase()) return null;
  if (!validDate(value.date) || value.date !== date || !canonicalTime(time) || canonicalTime(value.time) !== canonicalTime(time)) return null;
  if (typeof value.service !== 'string' || !value.service.trim()) return null;
  return {success:true,appointment_id:value.appointment_id as string,customer_id:value.customer_id as string,business_id:value.business_id as string,service_id:value.service_id as string,service:value.service,date:value.date,time:value.time as string,status:'Booked'};
}
const noAction = 'No appointment change has been verified. To request a booking, provide your name, phone number, service, date and time. Rescheduling, confirmation and cancellation are not supported here.';
export async function executeAiActions(output:unknown, preview:boolean, book:(input:BookingInput)=>Promise<{receipt?:BookingReceipt;sms_sent?:boolean;replayed?:boolean;reason?:string;rejection?:BookingRejection}>, availability?:(args:{service_name:string;date:string;time:string})=>Promise<{available:boolean}>) {
  if (!Array.isArray(output)) return {reply:noAction, action:null};
  const calls = output.filter(item => record(item) && item.type === 'function_call');
  const bookings = calls.filter(call => call.name === 'book_appointment');
  if (preview) return {reply:'Preview only. No appointment was created or changed, and no SMS was sent.', action:null};
  if (bookings.length > 1) return {reply:'Please request one appointment at a time. No booking was attempted.', action:null};
  if (calls.some(call => !['book_appointment','check_availability'].includes(call.name))) return {reply:'That action is not supported here. No appointment change was attempted.', action:null};
  if (calls.length > 1) return {reply:'Please request one action at a time. No booking was attempted.', action:null};
  if (!bookings.length) {
    if (calls.length === 1 && availability) {
      try {
        const args = JSON.parse(calls[0].arguments);
        if (!record(args) || typeof args.service_name !== 'string' || !args.service_name.trim() || !validDate(args.date) || !canonicalTime(args.time)) return {reply:noAction,action:null};
        const result = await availability({service_name:args.service_name,date:args.date,time:args.time as string});
        return {reply:result.available === true ? 'The requested time appears available. This is not a booking; availability can change before booking.' : 'Availability could not be confirmed for that request. No booking was attempted.',action:null};
      } catch { return {reply:noAction,action:null}; }
    }
    return {reply:noAction, action:null};
  }
  let args:BookingInput | null = null;
  try { args = bookingInput(JSON.parse(bookings[0].arguments)); } catch { /* Invalid tool arguments are not executable. */ }
  if (!args) return {reply:'Please check the booking details. No booking was attempted.', action:null};
  const result = await book(args);
  if (result.rejection) return {reply:bookingRejectionReply(result.rejection),action:null,rejection:result.rejection};
  if (!result.receipt) return {reply:result.reason || 'Booking could not be verified. Check your appointments before retrying.', action:null};
  // No model-controlled or customer-controlled string is interpolated into prose.
  return {reply:result.replayed ? "The original booking succeeded. This retry made no new booking. Check appointments for its current state." : result.sms_sent ? 'Your appointment was booked successfully. A confirmation text was submitted for sending.' : 'Your appointment was booked successfully. Text confirmation status could not be verified.', action:{type:'booking',receipt:result.receipt,replayed:result.replayed===true,sms_sent:result.sms_sent === true}};
}

const bookingRejectionMessages: Record<string, string> = {
  UNAUTHORIZED: 'Please log in again before booking.',
  INVALID_REQUEST: 'Please check the booking request details.',
  FORBIDDEN: 'Business access is not available for this booking.',
  INVALID_CUSTOMER: 'Please check the customer name and phone number.',
  INVALID_SERVICE: 'Please select an available service.',
  INVALID_SCHEDULE: 'Please select a valid appointment date and time.',
  INVALID_DURATION: 'The service duration is not configured correctly.',
  INVALID_HOURS: 'Business hours are not configured correctly.',
  CLOSED: 'The business is closed on the requested day.',
  OUTSIDE_HOURS: 'The appointment must fit within business hours.',
  INVALID_EXISTING_SCHEDULE: 'The calendar contains an appointment that cannot be safely checked.',
  SLOT_CONFLICT: 'That time is no longer available. Please choose another time.',
};
export type BookingRejection = {
  success: false; changed: false; action_id: string; action_type: 'book';
  business_id: string; code: string; receipt_scope: 'action_outcome';
  replayed: boolean; completed_at: string;
};
export function bookingRejection(value: unknown, businessId: string): BookingRejection | null {
  if (!record(value) || value.success !== false || value.changed !== false ||
      value.action_type !== 'book' || value.business_id !== businessId ||
      typeof value.business_id !== 'string' || !uuid.test(value.business_id) ||
      typeof value.action_id !== 'string' || !uuid.test(value.action_id) ||
      value.receipt_scope !== 'action_outcome' || typeof value.replayed !== 'boolean' ||
      typeof value.completed_at !== 'string' || !Number.isFinite(Date.parse(value.completed_at)) ||
      typeof value.code !== 'string' || !Object.hasOwn(bookingRejectionMessages, value.code)) return null;
  // Copy only validated fields; legacy/provider text cannot reach the response.
  return {success:false,changed:false,action_id:value.action_id,action_type:'book',
    business_id:value.business_id,code:value.code,receipt_scope:'action_outcome',
    replayed:value.replayed,completed_at:value.completed_at};
}
export function bookingRejectionReply(receipt: BookingRejection) {
  return `${receipt.replayed ? 'The original booking request was rejected. No new booking was attempted. ' : 'The appointment was not booked. '}${bookingRejectionMessages[receipt.code]}`;
}
