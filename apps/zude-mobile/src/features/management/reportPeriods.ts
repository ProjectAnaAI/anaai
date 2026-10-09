export type Period = "Weekly" | "Every two weeks" | "Twice monthly" | "Monthly" | "Custom";
export const periods:Period[] = ["Weekly","Every two weeks","Twice monthly","Monthly","Custom"];
export function businessToday(timezone:string,now=Date.now()) {const p=Object.fromEntries(new Intl.DateTimeFormat("en",{timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(now).map(v=>[v.type,v.value]));return `${p.year}-${p.month}-${p.day}`;}
export function dateValid(v:string){return /^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;}
const add=(day:string,n:number)=>new Date(Date.parse(day)+n*86400000).toISOString().slice(0,10);
export function periodRange(kind:Period,today:string,start:string,end:string){
 if(!dateValid(today))throw Error("Business date is unavailable. Refresh and retry.");
 if(start&&!dateValid(start)||end&&!dateValid(end))throw Error("Choose valid calendar dates.");
 let from=start||today,to=end||today;
 if(kind==="Weekly"){if(!start)from=add(today,-(new Date(today).getUTCDay()+6)%7);to=add(from,6);}
 if(kind==="Every two weeks"){if(!start)throw Error("Choose the first day of your 14-day window. This is not a configured payroll schedule.");to=add(start,13);}
 if(kind==="Monthly"||kind==="Twice monthly"){
  const [year,month,day]=from.split("-").map(Number);const last=new Date(Date.UTC(year,month,0)).toISOString().slice(0,10),prefix=from.slice(0,8);
  from=prefix+(kind==="Monthly"||day<=15?"01":"16");to=kind==="Twice monthly"&&day<=15?prefix+"15":last;
 }
 const capped=kind!=="Custom"&&to>today;if(capped)to=today;
 if(!dateValid(from)||!dateValid(to)||from>to||to>today)throw Error("Choose a start before the end, with no dates after business-local today.");
 if((Date.parse(to)-Date.parse(from))/86400000+1>93)throw Error("Choose no more than 93 inclusive calendar days.");
 return {startDate:from,endDate:to,capped};
}
