export const onboardingDays = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'] as const;
export type OnboardingDraft = {
  name: string; phone: string; email: string; address: string;
  hours: Record<string, { open: string; close: string; closed: boolean }>;
  services: { name: string; duration: string; price: string; description: string }[];
  receptionist: string; greeting: string;
};
export function newOnboardingDraft(): OnboardingDraft {
  return { name:'',phone:'',email:'',address:'',hours:Object.fromEntries(onboardingDays.map(day=>[day,{open:'09:00',close:'17:00',closed:day==='sunday'}])),services:[{name:'',duration:'30',price:'',description:''}],receptionist:'Ana',greeting:'Hello! How can I help you today?' };
}
export function isOnboardingDraft(value: unknown): value is OnboardingDraft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as OnboardingDraft;
  return ['name','phone','email','address','receptionist','greeting'].every(key => typeof draft[key as keyof OnboardingDraft] === 'string') &&
    onboardingDays.every(day => typeof draft.hours?.[day]?.closed === 'boolean' && typeof draft.hours[day].open === 'string' && typeof draft.hours[day].close === 'string') &&
    Array.isArray(draft.services) && draft.services.length > 0 && draft.services.length <= 50 &&
    draft.services.every(service => service && ['name','duration','price','description'].every(key => typeof service[key as keyof typeof service] === 'string'));
}
export function validateOnboarding(value: OnboardingDraft) {
  if (!isOnboardingDraft(value)) throw Error('Check your setup details.');
  if (!value || typeof value.name !== 'string' || !value.name.trim() || value.name.length>200) throw Error('Enter a business name (up to 200 characters).');
  for (const key of ['phone','email','address','receptionist','greeting'] as const) if(typeof value[key]!=='string' || value[key].length>2000) throw Error('Check your business and receptionist details.');
  if(value.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email.trim())) throw Error('Enter a valid email address.');
  if(value.phone.trim() && !/^[+\d\s().-]{7,30}$/.test(value.phone.trim())) throw Error('Enter a valid business phone number.');
  for(const day of onboardingDays){const h=value.hours?.[day];if(!h || typeof h.closed!=='boolean' || (!h.closed && (!/^([01]\d|2[0-3]):[0-5]\d$/.test(h.open) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(h.close) || h.close<=h.open)))throw Error('Check opening and closing hours for every day.');}
  if(!Array.isArray(value.services)||!value.services.length||value.services.length>50)throw Error('Add between 1 and 50 services.');
  for(const s of value.services){if(!s || typeof s.name!=='string'||!s.name.trim()||s.name.length>200||typeof s.description!=='string'||s.description.length>2000||typeof s.duration!=='string'||!/^\d+$/.test(s.duration)||Number(s.duration)<1||Number(s.duration)>1440||typeof s.price!=='string'||(s.price!==''&&(!/^\d+(\.\d{1,2})?$/.test(s.price)||!Number.isFinite(Number(s.price)))))throw Error('Each service needs a name, duration of 1–1440 minutes, and a valid optional price.');}
  if(!value.receptionist.trim()||!value.greeting.trim())throw Error('Enter a receptionist name and greeting.');
  return value;
}
