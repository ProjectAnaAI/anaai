const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const {register}=require('tsx/cjs/api');
const unregister=register();
const {createApp}=require('../server/app.ts');
const servers=[];
after(async()=>{await Promise.all(servers.map(s=>new Promise(r=>s.close(r))));unregister();});
async function server(){const app=createApp();const s=app.listen(0,'127.0.0.1');servers.push(s);await new Promise(r=>s.once('listening',r));return `http://127.0.0.1:${s.address().port}/api`;}
test('all M04 account management routes reject unauthenticated HTTP before provider access',async()=>{const base=await server();for(const [method,path] of [['GET','/devices'],['POST','/devices'],['POST','/devices/11111111-1111-4111-8111-111111111111']]){const response=await fetch(base+path,{method,...(method==='POST'?{body:'{}'}:{})});assert.equal(response.status,401);assert.equal((await response.json()).code,'UNAUTHORIZED');}});
test('all M04 identity HTTP routes require device/session credentials, not Supabase impersonation',async()=>{const base=await server();for(const [path,body]of [['/device/pin',{pin:'1234'}],['/employee-session/validate',{session:'invalid'}],['/employee-session/lock',{session:'invalid'}]]){const response=await fetch(base+path,{method:'POST',headers:{Authorization:'Bearer synthetic-account-token','Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,401);assert.equal((await response.json()).code,'IDENTITY_UNAUTHORIZED');}});
test('M04 PIN route rejects claimed employee role at HTTP boundary',async()=>{const base=await server();const response=await fetch(base+'/device/pin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:'1234',role:'owner'})});assert.equal(response.status,400);assert.equal((await response.json()).code,'INVALID_REQUEST');});
