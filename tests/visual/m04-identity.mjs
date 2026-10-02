import fs from 'node:fs';
import assert from 'node:assert/strict';
const tab=await(await fetch('http://127.0.0.1:9339/json/new?about:blank',{method:'PUT'})).json();
const ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);
let seq=0,lockFailure=true;const pending=new Map(),errors=[],paths=[];
function send(method,params={}){return new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});}
const business='11111111-1111-4111-8111-111111111111';
const fixtureSession={access_token:`eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${Buffer.from(JSON.stringify({sub:'fixture-user',exp:2100000000})).toString('base64url')}.fixture`,refresh_token:'synthetic',expires_at:2100000000,expires_in:3600,token_type:'bearer',user:{id:'fixture-user',email:'fixture@example.invalid',aud:'authenticated',role:'authenticated',app_metadata:{},user_metadata:{},created_at:'2026-01-01T00:00:00Z'}};
ws.onmessage=async({data})=>{const m=JSON.parse(data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p?.reject(Error(m.error.message)):p?.resolve(m.result);return;}
if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);
if(m.method==='Fetch.requestPaused'){
 const {requestId,request}=m.params,u=new URL(request.url);
 if(u.hostname==='127.0.0.1'||u.protocol==='data:'){await send('Fetch.continueRequest',{requestId});return;}
 if(!['zude-ui.test','zude-ui.supabase.co'].includes(u.hostname)){await send('Fetch.failRequest',{requestId,errorReason:'BlockedByClient'});return;}
 let status=200,body={success:true};paths.push(u.pathname);
 if(u.hostname==='zude-ui.supabase.co')body=fixtureSession;
 else if(u.pathname==='/api/businesses')body={success:true,userId:'fixture-user',businesses:[{id:business,name:'Fixture Studio',timezone:'America/Los_Angeles',role:'owner'}]};
 else if(u.pathname==='/api/devices')body={success:true,credential:'synthetic-device-only',device:{id:'fixture-device',business_id:business}};
 else if(u.pathname==='/api/device/pin'&&request.method!=='OPTIONS'){
  assert.equal(request.headers.Authorization||request.headers.authorization,'ZudeDevice synthetic-device-only');
  if(JSON.parse(request.postData).pin!=='1234'){status=401;body={success:false,code:'PIN_INVALID'};}
  else body={success:true,session:'synthetic-session-only',expiresAt:new Date(Date.now()+3600000).toISOString(),employee:{id:'fixture-employee',businessId:business,name:'Fixture Employee',role:'employee'},permissions:[]};
 }else if(u.pathname==='/api/employee-session/lock'&&request.method!=='OPTIONS'&&lockFailure){status=503;body={success:false};lockFailure=false;}
 await send('Fetch.fulfillRequest',{requestId,responseCode:status,responseHeaders:[{name:'Content-Type',value:'application/json'},{name:'Access-Control-Allow-Origin',value:'http://127.0.0.1:8769'},{name:'Access-Control-Allow-Headers',value:'Authorization,Accept,Content-Type,x-anaai-business-id'},{name:'Access-Control-Allow-Methods',value:'GET,POST,OPTIONS'}],body:Buffer.from(request.method==='OPTIONS'?'':JSON.stringify(body)).toString('base64')});
}};
await send('Runtime.enable');await send('Page.enable');await send('Fetch.enable',{patterns:[{urlPattern:'*'}]});
await send('Page.addScriptToEvaluateOnNewDocument',{source:`localStorage.setItem('sb-zude-ui-auth-token',${JSON.stringify(JSON.stringify(fixtureSession))});`});
await send('Emulation.setDeviceMetricsOverride',{width:1024,height:768,deviceScaleFactor:1,mobile:false});
async function evaluate(expression){return(await send('Runtime.evaluate',{expression,returnByValue:true})).result.value;}
const pause=()=>new Promise(r=>setTimeout(r,250));
async function waitText(text){for(let i=0;i<40;i++){if(await evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`))return;await pause();}throw Error('Missing '+text+'; screen: '+await evaluate('document.body.innerText')+'; request paths: '+paths.join(','));}
async function click(label){assert.ok(await evaluate(`(()=>{const e=[...document.querySelectorAll('[role=button]')].find(e=>e.getAttribute('aria-label')===${JSON.stringify(label)}||e.textContent.trim()===${JSON.stringify(label)});if(!e)return false;e.click();return true})()`),'Missing button '+label);await pause();}
async function shot(name){const{data}=await send('Page.captureScreenshot',{format:'png'});fs.mkdirSync('/tmp/zude-m04-captures',{recursive:true});fs.writeFileSync('/tmp/zude-m04-captures/'+name+'.png',Buffer.from(data,'base64'));}
await send('Page.navigate',{url:'http://127.0.0.1:8769/device'});await waitText('Register this ZUDE device');
await evaluate(`(()=>{const e=document.querySelector('input[aria-label="Device name"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'Fixture iPad');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);await pause();await click('Register device');await waitText('Enter your PIN');await shot('pin-1024');
for(const key of ['9','9','9','9'])await click(key);await click('Unlock');await waitText('Unable to unlock');
for(const key of ['1','2','3','4'])await click(key);await click('Unlock');await waitText('Day Timeline');await click('Browse ZUDE');await click('Device & PIN');await waitText('Fixture Employee');await shot('identity-1024');
assert.equal(await evaluate(`document.body.innerText.includes('synthetic-session-only')||document.body.innerText.includes('synthetic-device-only')`),false);
await click('Today');await waitText('Day Timeline');await click('Lock');await waitText('Locked locally');await click('Retry Lock');await waitText('Device registration is retained');
await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});await pause();await shot('pin-iphone');
assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);
assert.equal(errors.length,0);assert.ok(paths.every(p=>!p.includes('clock')));
console.log('PASS: registration, universal PIN, incorrect PIN, identity, failed lock/retry, no displayed credentials, iPad and iPhone captures.');
await send('Page.close');ws.close();
