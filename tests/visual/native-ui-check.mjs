import fs from 'node:fs';
import assert from 'node:assert/strict';
// Synthetic fixtures only. Fetch interception blocks every non-fixture remote host.
fs.mkdirSync('/tmp/zude-ui-captures',{recursive:true});
const tab=await (await fetch('http://127.0.0.1:9339/json/new?about:blank',{method:'PUT'})).json();
const ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);
let seq=0;const pending=new Map(),errors=[],requests=[];
function send(method,params={}){return new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));})}
let mode='normal',conflict=false,holdDay=false;
const date='2026-09-28',business='11111111-1111-4111-8111-111111111111',customer='22222222-2222-4222-8222-222222222222',service='33333333-3333-4333-8333-333333333333';
let appointments=[['09:00:00','Alex Rivera','Completed',30],['09:45:00','Sam Morgan','Completed',30],['10:30:00','Jordan Lee','Confirmed',45],['11:30:00','Maya Chen','Booked',45],['13:00:00','Casey Brooks','Confirmed',30],['14:30:00','Robin Taylor','Cancelled',45]].map(([time,name,status,duration],i)=>({id:`44444444-4444-4444-8444-${String(i+1).padStart(12,'0')}`,business_id:business,customer_id:customer,service_id:service,customer_name:name,service:'Signature haircut',appointment_date:date,appointment_time:time,status,duration_minutes:duration,notes:null}));
const fixtureSession={access_token:`eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${Buffer.from(JSON.stringify({sub:'fixture-user',exp:2100000000})).toString('base64url')}.fixture`,refresh_token:'synthetic',expires_at:2100000000,expires_in:3600,token_type:'bearer',user:{id:'fixture-user',email:'fixture@example.invalid',aud:'authenticated',role:'authenticated',app_metadata:{},user_metadata:{},created_at:'2026-01-01T00:00:00Z'}};
ws.onmessage=async({data})=>{const m=JSON.parse(data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p?.reject(Error(m.error.message)):p?.resolve(m.result);return}
 if(m.method==='Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text+' '+(m.params.exceptionDetails.exception?.description||''));
 if(m.method==='Fetch.requestPaused'){
  const {requestId,request}=m.params;const u=new URL(request.url);
  if(u.hostname==='127.0.0.1'||u.protocol==='data:'){await send('Fetch.continueRequest',{requestId});return}
  if(!['zude-ui.test','zude-ui.supabase.co'].includes(u.hostname)){await send('Fetch.failRequest',{requestId,errorReason:'BlockedByClient'});return}
  let body={success:true},status=200;requests.push({path:u.pathname,method:request.method});
  if(u.hostname==='zude-ui.supabase.co')body=fixtureSession;
  else if(u.pathname==='/api/businesses')body={success:true,userId:'fixture-user',businesses:[{id:business,name:'Fieldwork Studio',timezone:'America/Los_Angeles',role:'owner'}]};
  else if(u.pathname==='/api/customers')body={success:true,businessId:business,customers:[{id:customer,full_name:'Maya Chen',phone:null},{id:'other',full_name:'Alex Rivera',phone:'555-0100'}],nextOffset:null};
  else if(u.pathname==='/api/services')body={success:true,businessId:business,services:[{id:service,name:'Signature haircut',duration_minutes:45},{id:'other',name:'Express trim',duration_minutes:30}]};
  else if(u.pathname==='/api/appointments/availability')body={success:true,businessId:business,date:u.searchParams.get('date'),serviceId:service,appointmentId:u.searchParams.get('appointmentId'),durationMinutes:45,code:mode==='closed'?'CLOSED':mode==='empty'?'NO_AVAILABILITY':'AVAILABLE',slots:mode==='closed'||mode==='empty'?[]:['11:30:00','12:15:00','13:30:00','14:15:00','15:00:00','15:45:00','16:30:00']};
  else if(request.method==='POST'||request.method==='PATCH'){
   const b=JSON.parse(request.postData);if(conflict){status=409;body={success:false,code:'SLOT_CONFLICT'};conflict=false}else{
    let a=appointments.find(a=>a.id===b.appointmentId);if(a){Object.assign(a,b.status?{status:b.status}:{appointment_date:b.appointmentDate,appointment_time:b.appointmentTime})}else{a={...appointments[3],id:'55555555-5555-4555-8555-555555555555',appointment_time:b.appointmentTime,appointment_date:b.appointmentDate};appointments.push(a)}
    body={success:true,appointment:a,receipt:{business_id:business,appointment_id:a.id}};
   }
  }else if(u.pathname.startsWith('/api/appointments')){body={success:true,businessId:business,date:u.searchParams.get('date'),appointments:mode==='day-empty'?[]:appointments};if(mode==='error'){status=503;body={success:false,code:'SERVICE_UNAVAILABLE'}}}
  if(holdDay && request.method==='GET' && ['/api/appointments/day','/api/appointments'].includes(u.pathname))await new Promise(r=>setTimeout(r,3000));
  await send('Fetch.fulfillRequest',{requestId,responseCode:status,responseHeaders:[{name:'Content-Type',value:'application/json'},{name:'Access-Control-Allow-Origin',value:'*'},{name:'Access-Control-Allow-Headers',value:'*'},{name:'Access-Control-Allow-Methods',value:'GET,POST,PATCH,OPTIONS'}],body:Buffer.from(request.method==='OPTIONS'?'':JSON.stringify(body)).toString('base64')});
 }
};
await send('Runtime.enable');await send('Page.enable');await send('Fetch.enable',{patterns:[{urlPattern:'*'}]});
await send('Page.addScriptToEvaluateOnNewDocument',{source:`localStorage.setItem('sb-zude-ui-auth-token',${JSON.stringify(JSON.stringify(fixtureSession))});const OriginalDate=Date;window.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:['2026-09-28T17:45:00Z']))}static now(){return new OriginalDate('2026-09-28T17:45:00Z').getTime()}};`});
const pause=()=>new Promise(r=>setTimeout(r,450));
async function evaluate(expression){const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result.value}
async function waitText(text){for(let i=0;i<35;i++){if(await evaluate(`(document.body?.innerText || '').toLowerCase().includes(${JSON.stringify(text.toLowerCase())})`))return;await pause()}throw Error('Missing text: '+text+'; '+await evaluate('document.body.innerText'))}
async function click(label){const found=await evaluate(`(()=>{const e=[...document.querySelectorAll('[role="button"]')].find(e=>e.getAttribute('aria-label')===${JSON.stringify(label)}||e.textContent.trim().endsWith(${JSON.stringify(label)})||(e.getAttribute('aria-label')||'').includes(${JSON.stringify(', '+label+',')}));if(!e)return false;e.click();return true})()`);assert.ok(found,'Missing button '+label);await pause()}
async function viewport(w,h){await send('Emulation.setDeviceMetricsOverride',{width:w,height:h,deviceScaleFactor:1,mobile:false});await pause()}
async function shot(name){await pause();const metrics=await evaluate(`({width:innerWidth,scroll:document.documentElement.scrollWidth,smallTargets:[...document.querySelectorAll('[role=button]')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&(r.width<43||r.height<43)}).length,overflows:[...document.querySelectorAll('body *')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.right>innerWidth+1&&getComputedStyle(e).position!=='absolute'}).length})`);assert.ok(metrics.scroll<=metrics.width,'Page overflow '+name);assert.equal(metrics.smallTargets,0,'Small touch target '+name);const {data}=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync('/tmp/zude-ui-captures/'+name+'.png',Buffer.from(data,'base64'));console.log(name,JSON.stringify(metrics))}
await viewport(1024,768);await send('Page.navigate',{url:'http://127.0.0.1:8769/'});await waitText('Maya Chen');await shot('1024-today');
const headerGeometry=await evaluate(`(()=>{const buttons=[...document.querySelectorAll('[role=button]')];const action=buttons.find(e=>e.textContent.trim().endsWith('New Appointment'));const firstRow=buttons.find(e=>(e.getAttribute('aria-label')||'').startsWith('9:00 AM,'));return {actionTop:action.getBoundingClientRect().top,rowTop:firstRow.getBoundingClientRect().top}})()`);
assert.ok(headerGeometry.actionTop<=24,'Primary header must stay compact');assert.ok(headerGeometry.rowTop<=150,'Timeline must begin beneath compact header');
const visualPolicy=await evaluate(`(()=>{const buttons=[...document.querySelectorAll('[role=button]')];const future=buttons.find(e=>(e.getAttribute('aria-label')||'').startsWith('11:30 AM,'));const current=buttons.find(e=>(e.getAttribute('aria-label')||'').startsWith('10:30 AM,'));const canvas=document.elementFromPoint(400,700);const logo=document.querySelector('img[alt="ZUDE logo"]');return {canvas:getComputedStyle(canvas).backgroundColor,futureBorder:getComputedStyle(future).borderTopWidth,currentBorder:getComputedStyle(current).borderTopWidth,logo:!!logo&&logo.complete&&logo.naturalWidth>0}})()`);
assert.equal(visualPolicy.canvas,'rgb(250, 249, 247)','Warm light timeline canvas');
assert.equal(visualPolicy.futureBorder,'1px','Upcoming appointment must not imply selection');
assert.equal(visualPolicy.currentBorder,'2px','Actual current appointment is emphasized');
assert.equal(visualPolicy.logo,true,'Canonical logo image loaded');
for(const [w,h,name]of[[1366,1024,'large-ipad'],[768,1024,'portrait-ipad'],[390,844,'iphone'],[1440,900,'web']]){await viewport(w,h);await shot(name+'-today')}
await viewport(1024,768);
assert.ok(!requests.some(r=>r.path.includes('/availability')),'Today must not fan out availability');
await click('View appointment for Maya Chen, 11:30 AM');await waitText('Appointment details');await shot('1024-today-to-inspector');
await click('Today');await waitText('Up next');await click('New Appointment');await waitText('Select');await shot('1024-today-to-composer');await click('Close');await click('Today');await waitText('Up next');
await click('Browse ZUDE');await shot('1024-navigation');assert.equal(await evaluate(`/\\b(Web|Later|Phase 2)\\b/.test(document.body.innerText)`),false,'No engineering capability labels');await click('Close navigation');
await click('Appointments');await waitText('Day timeline');await shot('1024-appointments');await click('Maya Chen');await shot('1024-inspector');
await click('New Appointment');await waitText('Select');await shot('1024-composer-initial');
await click('Select Maya Chen');await shot('1024-customer-selected');await click('Signature haircut · 45 min');await waitText('11:30 AM');await shot('1024-service-selected');
await click('Change date');await shot('1024-date-selection');await click('Use this date');await shot('1024-date-selected');await shot('1024-composer-times');
await click('11:30 AM');await shot('1024-composer-ready');
conflict=true;await click('Book Appointment');await waitText('That time is no longer available');await shot('1024-conflict');
await click('12:15 PM');await click('Book Appointment');await waitText('Your booking is saved');await shot('1024-success');
await click('Done');
await click('Confirm');await waitText('Complete');await shot('1024-confirmed');
await click('Reschedule');await waitText('Save Reschedule');await click('1:30 PM');await click('Save Reschedule');await waitText('The new time is saved');await shot('1024-rescheduled');await click('Done');
await click('Complete');await waitText('No further actions are available');await shot('1024-completed');
await click('Maya Chen');await click('Cancel Appointment');await shot('1024-cancel-prompt');await click('Keep Appointment');await click('Cancel Appointment');await click('Yes, Cancel Appointment');await waitText('No further actions are available');await shot('1024-cancelled');
for(const [w,h,name]of[[1366,1024,'large-ipad'],[768,1024,'portrait-ipad'],[390,844,'iphone'],[1440,900,'web']]){
 await viewport(w,h);await shot(name+'-appointments');await click('New Appointment');await shot(name+'-composer');await click('Close');
}
await viewport(1024,480);await click('New Appointment');await evaluate(`document.querySelector('input').focus()`);await shot('keyboard-reduced-height');await click('Close');
await viewport(1024,768);mode='closed';await click('New Appointment');await click('Select Maya Chen');await click('Signature haircut · 45 min');await waitText('business is closed');await shot('1024-closed');await click('Close');
mode='empty';await click('New Appointment');await click('Select Maya Chen');await click('Signature haircut · 45 min');await waitText('No available times');await shot('1024-no-availability');await click('Close');
holdDay=true;mode='normal';await click('Refresh day');await waitText('Loading appointments');await shot('1024-loading');holdDay=false;await waitText('Maya Chen');
mode='day-empty';await click('Refresh day');await waitText('No appointments on this day');await shot('1024-empty-day');
mode='error';await click('Refresh day');await waitText('Appointments unavailable');await shot('1024-error');
mode='normal';await click('Today');await waitText('Up next');holdDay=true;await click('Refresh today');await waitText('Loading today');await shot('1024-today-loading');holdDay=false;await waitText('Maya Chen');
mode='error';await click('Refresh today');await waitText('Appointments unavailable');await shot('1024-today-error');
mode='day-empty';await click('Refresh today');await waitText('A clear day ahead');await shot('1024-today-empty');
assert.equal(appointments.find(a=>a.id==='55555555-5555-4555-8555-555555555555').status,'Completed');
assert.equal(appointments.find(a=>a.id==='55555555-5555-4555-8555-555555555555').appointment_time,'13:30:00');
assert.equal(appointments[3].status,'Cancelled');assert.equal(appointments[2].status,'Confirmed');
assert.deepEqual(errors,[]);console.log('PASS visual matrix; '+requests.length+' intercepted fixture requests; no external API requests.');
await send('Page.close');ws.close();
