const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const crypto = require('node:crypto');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const epoch = '2020-01-01T00:00:00.000Z';
function harness() {
  const tables = { zude_devices: [], employee_sessions: [], employees: [] };
  const state = { service: 0, queries: [], writes: [], fail: null, role: 'owner' };
  const db = { from(table) {
    let op = 'select', values, fields = '*', filters = [], from = 0, to = Infinity, single = false;
    const q = {
      select(v) { fields = v; return q; }, insert(v) { op = 'insert'; values = v; return q; }, update(v) { op = 'update'; values = v; return q; },
      eq(k,v) { filters.push(r=>r[k]===v); return q; }, is(k,v) { filters.push(r=>(r[k]??null)===v); return q; },
      maybeSingle() { single = true; return q; }, single() { single = true; return q; }, order() { return q; }, range(a,b) { from=a;to=b;return q; },
      then(resolve,reject) { return Promise.resolve().then(()=>{
        state.queries.push({ table, op });
        if (state.fail?.(table,op,values)) return { data:null,error:{message:'provider-private-secret'} };
        let rows = tables[table].filter(r=>filters.every(f=>f(r))).slice(from,to+1);
        if (op==='insert') { const row = {created_at:new Date().toISOString(),updated_at:epoch,registered_at:epoch,revoked_at:null,pin_locked_until:null,failed_pin_attempts:0,...values};tables[table].push(row);rows=[row];state.writes.push({table,values:{...values}}); }
        if (op==='update') { for(const r of rows)Object.assign(r,values);state.writes.push({table,values:{...values}}); }
        const safe = rows.map(r=>fields==='*'?{...r}:Object.fromEntries(fields.split(',').map(k=>k.trim()).map(k=>[k,r[k]])));
        return {data:single?(safe[0]??null):safe,error:null};
      }).then(resolve,reject); }
    }; return q;
  }};
  const cache = {};
  function load(file) {
    file=path.resolve(file);if(cache[file])return cache[file];
    const exports={};cache[file]=exports;
    const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
    vm.runInNewContext(code,{exports,Buffer,Request,Response,URL,Date,require(name){
      if(name==='@/lib/supabase-server')return {createSupabaseServiceClient(){state.service++;return db;}};
      if(name==='@/lib/appointment-actions')return {isUuid:v=>typeof v==='string'&&/^[0-9a-f-]{36}$/.test(v)};
      if(name==='@/lib/business-context')return {resolveBusinessContext:async({accessToken,requestedBusinessId})=>accessToken==='account'&&(!requestedBusinessId||requestedBusinessId===A)?{success:true,db:{},context:{businessId:A,userId:'actor',role:state.role}}:{success:false,status:403,code:'FORBIDDEN',error:'Denied'}};
      if(name.startsWith('.'))return load(path.resolve(path.dirname(file),name+'.ts'));
      return require(name);
    }},{filename:file});return exports;
  }
  const api=load('server/handlers/devices.ts');const sec=load('server/device-security.ts');
  function req(route,body,credential='account',extra={}) { return new Request('https://zude.test/api/'+route,{method:'POST',headers:{Authorization:credential==='account'?'Bearer account':`ZudeDevice ${credential}`,...extra},body:JSON.stringify(body)}); }
  async function call(name,body={},token='account',route='devices',extra={}) { const r=await api[name](req(route,body,token,extra));return {status:r.status,body:await r.json(),headers:r.headers}; }
  async function register() { const r=await call('REGISTER',{name:'Shared iPad'});assert.equal(r.status,201);return r.body.credential; }
  function employee(pin='1234',overrides={}) { const salt=crypto.randomBytes(16);const e={id:crypto.randomUUID(),business_id:A,display_name:'Test employee',role:'employee',is_active:true,updated_at:epoch,pin_salt:salt.toString('base64'),pin_hash:crypto.scryptSync(pin,salt,32).toString('base64'),...overrides};tables.employees.push(e);return e; }
  async function login(token,pin='1234') {return call('PIN',{pin},token,'device/pin');}
  return {state,tables,api,sec,call,register,employee,login,req,identity:load("server/employee-identity.ts")};
}
for(const role of ['owner','manager'])test(`${role} registers and revokes tenant device`,async()=>{const h=harness();h.state.role=role;const token=await h.register();const id=h.sec.credentialId(token);const r=await h.call('REVOKE',{},'account','devices/'+id);assert.equal(r.status,200);assert.ok(h.tables.zude_devices[0].revoked_at);});
for(const name of ['REGISTER','DIRECTORY','REVOKE'])test(`${name}: unauthenticated denied before service access`,async()=>{const h=harness();const r=await h.api[name](new Request('https://zude.test/api/devices'));assert.equal(r.status,401);assert.equal(h.state.service,0);});
for(const name of ['REGISTER','DIRECTORY','REVOKE'])test(`${name}: staff denied before service access`,async()=>{const h=harness();h.state.role='staff';const r=await h.call(name,{name:'iPad'});assert.equal(r.status,403);assert.equal(h.state.service,0);});
test('forged membership selector rejected before service access',async()=>{const h=harness();const r=await h.call('REGISTER',{name:'iPad'},'account','devices',{'x-anaai-business-id':B});assert.equal(r.status,403);assert.equal(h.state.service,0);});
for(const field of ['business_id','registered_by_user_id','credential_hash','credential_salt','revoked_at','failed_pin_attempts','pin_locked_until'])test(`registration rejects client ${field}`,async()=>{const h=harness();assert.equal((await h.call('REGISTER',{name:'iPad',[field]:'forged'})).status,400);assert.equal(h.state.service,0);});
for(const name of ['', ' '.repeat(3), 'x'.repeat(101), null, 42])test(`malformed device name ${typeof name}/${String(name).length}`,async()=>{const h=harness();assert.equal((await h.call('REGISTER',{name})).status,400);assert.equal(h.state.service,0);});
test('credential stored salted/hashed and returned only at issuance',async()=>{const h=harness();const token=await h.register();const row=h.tables.zude_devices[0];assert.ok(row.credential_hash&&row.credential_salt);assert.ok(!JSON.stringify(h.tables).includes(token));assert.ok(h.sec.verifyCredential(token,row.credential_hash,row.credential_salt));const r=await h.api.DIRECTORY(new Request('https://zude.test/api/devices',{headers:{Authorization:'Bearer account'}}));const text=await r.text();assert.ok(!text.includes(token));assert.ok(!text.includes('credential_'));assert.equal(r.headers.get('cache-control'),'no-store');});
test('cross-tenant device revoke is 404 and preserves row',async()=>{const h=harness();const token=await h.register();h.tables.zude_devices[0].business_id=B;assert.equal((await h.call('REVOKE',{},'account','devices/'+h.sec.credentialId(token))).status,404);assert.equal(h.tables.zude_devices[0].revoked_at,null);});
for(const token of ['','bad','x'.repeat(1000)])test(`malformed credential denied without service access ${token.length}`,async()=>{const h=harness();assert.equal((await h.login(token)).status,401);assert.equal(h.state.service,0);});
test('wrong secret with valid locator denied',async()=>{const h=harness();const token=await h.register();assert.equal((await h.login(token.slice(0,37)+'A'.repeat(43))).status,401);assert.equal(h.tables.zude_devices[0].failed_pin_attempts,0);});
test('unknown credential denied',async()=>{const h=harness();assert.equal((await h.login(h.sec.issueCredential().credential)).status,401);});
test('revoked device cannot authenticate',async()=>{const h=harness();const token=await h.register();h.employee();h.tables.zude_devices[0].revoked_at=new Date().toISOString();assert.equal((await h.login(token)).status,401);assert.equal(h.tables.employee_sessions.length,0);});
test('credential business controls employee search',async()=>{const h=harness();const token=await h.register();h.employee('1234',{business_id:B});assert.equal((await h.login(token)).status,401);assert.equal(h.tables.employee_sessions.length,0);});
test('device request rejects business selector',async()=>{const h=harness();const token=await h.register();h.employee();assert.equal((await h.call('PIN',{pin:'1234'},token,'device/pin',{'x-anaai-business-id':A})).status,401);});
for(const pin of ['123','1234567','abcd',1234,null])test(`invalid PIN shape ${typeof pin}/${String(pin).length}`,async()=>{const h=harness();assert.equal((await h.login('bad',pin)).status,400);assert.equal(h.state.service,0);});
test('inactive employee cannot authenticate',async()=>{const h=harness();const token=await h.register();h.employee('1234',{is_active:false});assert.equal((await h.login(token)).status,401);});
test('incorrect PIN increments attempts; fifth locks; locked correct PIN denied',async()=>{const h=harness();const token=await h.register();h.employee();for(let i=1;i<=5;i++){assert.equal((await h.login(token,'9999')).status,401);assert.equal(h.tables.zude_devices[0].failed_pin_attempts,i);}assert.ok(Date.parse(h.tables.zude_devices[0].pin_locked_until)>Date.now());assert.equal((await h.login(token)).status,429);assert.equal(h.tables.zude_devices[0].failed_pin_attempts,5);});
test('correct PIN resets failures and returns opaque session with no PIN material',async()=>{const h=harness();const token=await h.register();h.employee();await h.login(token,'9999');const r=await h.login(token);assert.equal(r.status,201);assert.ok(h.sec.credentialId(r.body.session));assert.equal(h.tables.zude_devices[0].failed_pin_attempts,0);assert.equal(h.tables.zude_devices[0].pin_locked_until,null);assert.ok(!JSON.stringify(r.body).includes('pin_'));assert.ok(!JSON.stringify(h.tables).includes(r.body.session));const session=h.tables.employee_sessions[0];assert.ok(session.token_hash&&session.token_salt);assert.equal(session.business_id,A);assert.equal(session.device_id,h.sec.credentialId(token));assert.equal(Date.parse(session.expires_at)-Date.parse(session.created_at),8*60*60*1000);});
test('elapsed lockout permits a fresh bounded attempt',async()=>{const h=harness();const token=await h.register();h.employee();Object.assign(h.tables.zude_devices[0],{failed_pin_attempts:5,pin_locked_until:epoch});assert.equal((await h.login(token)).status,201);});
test('concurrent PIN requests cannot reserve the same revision',async()=>{const h=harness();const token=await h.register();h.employee();const results=await Promise.all(Array.from({length:12},()=>h.login(token,'9999')));assert.equal(results.filter(r=>r.status===401).length,1);assert.equal(results.filter(r=>r.status===429).length,11);assert.equal(h.tables.zude_devices[0].failed_pin_attempts,1);});
test('duplicate matching active PINs fail closed',async()=>{const h=harness();const token=await h.register();h.employee();h.employee();assert.equal((await h.login(token)).status,401);assert.equal(h.tables.employee_sessions.length,0);});
async function unlocked(h){const device=await h.register();const employee=h.employee();const r=await h.login(device);assert.equal(r.status,201);return {device,employee,session:r.body.session};}
test('valid session resolves server identity and safe permissions',async()=>{const h=harness();const x=await unlocked(h);const r=await h.call('VALIDATE',{session:x.session},x.device);assert.equal(r.status,200);assert.equal(r.body.employee.id,x.employee.id);assert.equal(r.body.employee.role,'employee');assert.deepEqual(r.body.permissions,[]);assert.ok(!JSON.stringify(r.body).includes('token_'));assert.ok(!('session' in r.body));});
for(const role of ['manager','owner'])test(`${role} permissions derived from employee record`,async()=>{const h=harness();const device=await h.register();h.employee('1234',{role});const r=await h.login(device);assert.equal(r.status,201);assert.ok(r.body.permissions.includes('team:manage-employees'));assert.equal(r.body.permissions.includes('team:manage-managers'),role==='owner');});
for(const field of ['role','business_id','employee_id','permissions'])test(`session cannot declare ${field}`,async()=>{const h=harness();const x=await unlocked(h);assert.equal((await h.call('VALIDATE',{session:x.session,[field]:'owner'},x.device)).status,400);});
for(const condition of ['expired','revoked','employee-inactive','employee-changed','device-revoked','cross-business','cross-device','wrong-secret'])test(`session rejects ${condition}`,async()=>{const h=harness();const x=await unlocked(h);const s=h.tables.employee_sessions[0];let token=x.session;
 if(condition==='expired')s.expires_at=epoch;
 if(condition==='revoked')s.revoked_at=new Date().toISOString();
 if(condition==='employee-inactive')x.employee.is_active=false;
 if(condition==='employee-changed')x.employee.updated_at=new Date(Date.now()+1000).toISOString();
 if(condition==='device-revoked')h.tables.zude_devices[0].revoked_at=epoch;
 if(condition==='cross-business')s.business_id=B;
 if(condition==='cross-device')s.device_id=crypto.randomUUID();
 if(condition==='wrong-secret')token=token.slice(0,37)+'A'.repeat(43);
 assert.equal((await h.call('VALIDATE',{session:token},x.device)).status,401);
});
test('session cannot move to another valid registered device',async()=>{const h=harness();const x=await unlocked(h);const other=await h.register();assert.equal((await h.call('VALIDATE',{session:x.session},other)).status,401);});
test('lock revokes session only, device still unlocks and no time clock writes',async()=>{const h=harness();const x=await unlocked(h);const r=await h.call('LOCK',{session:x.session},x.device);assert.equal(r.status,200);assert.ok(h.tables.employee_sessions[0].revoked_at);assert.equal(h.tables.zude_devices[0].revoked_at,null);assert.equal((await h.call('VALIDATE',{session:x.session},x.device)).status,401);assert.equal((await h.login(x.device)).status,201);assert.ok(h.state.writes.every(w=>['zude_devices','employee_sessions'].includes(w.table)));});
for(const [table,op]of[['zude_devices','select'],['zude_devices','update'],['employees','select'],['employee_sessions','insert']])test(`PIN provider failure ${table}/${op} is safe and closed`,async()=>{const h=harness();const token=await h.register();h.employee();h.state.fail=(t,o)=>t===table&&o===op;const r=await h.login(token);assert.equal(r.status,503);assert.equal(r.body.code,'SERVICE_UNAVAILABLE');assert.ok(!JSON.stringify(r.body).includes('provider-private-secret'));});
for(const name of ['REGISTER','DIRECTORY','REVOKE'])test(`${name} provider failure is safe`,async()=>{const h=harness();const token=await h.register();h.state.fail=()=>true;const r=await h.call(name,{...(name==='REGISTER'?{name:'iPad'}:{})},'account','devices/'+h.sec.credentialId(token));assert.equal(r.status,503);assert.ok(!JSON.stringify(r.body).includes('provider-private-secret'));});
test('lock write failure does not report success',async()=>{const h=harness();const x=await unlocked(h);h.state.fail=(t,o)=>t==='employee_sessions'&&o==='update';const r=await h.call('LOCK',{session:x.session},x.device);assert.equal(r.status,503);assert.equal(h.tables.employee_sessions[0].revoked_at,null);});
test('credential hashes are unique and corruption fails safely',()=>{const h=harness();const a=h.sec.issueCredential(),b=h.sec.issueCredential();assert.notEqual(a.credential,b.credential);assert.notEqual(a.salt,b.salt);assert.ok(!h.sec.verifyCredential(a.credential,b.hash,b.salt));assert.ok(!h.sec.verifyCredential(a.credential,'broken','broken'));});

test('future handler permission boundary denies ordinary employee administration',async()=>{const h=harness();const x=await unlocked(h);await assert.rejects(h.identity.authorizedEmployee(h.req('future',{},x.device),x.session,'team:manage-employees'),e=>e.status===403&&e.code==='EMPLOYEE_FORBIDDEN');});
test('PIN changed during issuance cannot authenticate using the earlier PIN snapshot',async()=>{const h=harness();const token=await h.register();const employee=h.employee();h.state.fail=(table,op)=>{if(table==='employee_sessions'&&op==='insert')employee.updated_at='2021-01-01T00:00:00.000Z';return false;};assert.equal((await h.login(token)).status,401);});

test('later PIN attempt invalidates a prior session even when its Lock request was lost',async()=>{const h=harness();const x=await unlocked(h);await h.login(x.device,'9999');assert.equal((await h.call('VALIDATE',{session:x.session},x.device)).status,401);});

// ---- Device-credential rejection codes (native recovery contract) ----------------
// Only DEVICE_INVALID / DEVICE_REVOKED authorize a client to forget its stored
// credential. Everything else must keep a distinct code.
test('revoked device with verified secret reports DEVICE_REVOKED',async()=>{const h=harness();const token=await h.register();h.employee();h.tables.zude_devices[0].revoked_at=epoch;const r=await h.login(token);assert.equal(r.status,401);assert.equal(r.body.code,'DEVICE_REVOKED');assert.equal(h.tables.zude_devices[0].failed_pin_attempts,0);assert.equal(h.tables.employee_sessions.length,0);});
test('revocation is not disclosed without the verified secret',async()=>{const h=harness();const token=await h.register();h.tables.zude_devices[0].revoked_at=epoch;const r=await h.login(token.slice(0,37)+'A'.repeat(43));assert.equal(r.status,401);assert.equal(r.body.code,'DEVICE_INVALID');});
for(const [name,make]of[['unknown locator',h=>h.sec.issueCredential().credential],['wrong secret',async h=>(await h.register()).slice(0,37)+'A'.repeat(43)],['malformed',()=>'bad']])test(`${name} device credential reports DEVICE_INVALID`,async()=>{const h=harness();const token=await make(h);const r=await h.login(token);assert.equal(r.status,401);assert.equal(r.body.code,'DEVICE_INVALID');assert.ok(!JSON.stringify(r.body).includes(token));});
test('no device credential or a business selector is not a device rejection',async()=>{const h=harness();const token=await h.register();h.employee();
 const missing=await h.api.PIN(new Request('https://zude.test/api/device/pin',{method:'POST',body:JSON.stringify({pin:'1234'})}));assert.equal((await missing.json()).code,'IDENTITY_UNAUTHORIZED');
 assert.equal((await h.call('PIN',{pin:'1234'},token,'device/pin',{'x-anaai-business-id':A})).body.code,'IDENTITY_UNAUTHORIZED');});
test('PIN outcomes keep their own codes, never a device rejection',async()=>{const h=harness();const token=await h.register();h.employee();assert.equal((await h.login(token,'9999')).body.code,'PIN_INVALID');Object.assign(h.tables.zude_devices[0],{failed_pin_attempts:5,pin_locked_until:new Date(Date.now()+60000).toISOString()});assert.equal((await h.login(token)).body.code,'PIN_LOCKED');});
for(const condition of ['expired','revoked','employee-inactive','cross-device'])test(`session failure ${condition} is IDENTITY_UNAUTHORIZED, not a device rejection`,async()=>{const h=harness();const x=await unlocked(h);const s=h.tables.employee_sessions[0];
 if(condition==='expired')s.expires_at=epoch;if(condition==='revoked')s.revoked_at=new Date().toISOString();if(condition==='employee-inactive')x.employee.is_active=false;if(condition==='cross-device')s.device_id=crypto.randomUUID();
 for(const name of ['VALIDATE','LOCK']){const r=await h.call(name,{session:x.session},x.device);assert.equal(r.status,401);assert.equal(r.body.code,'IDENTITY_UNAUTHORIZED');}});
test('post-issuance identity change is IDENTITY_UNAUTHORIZED, so it cannot forget a valid device',async()=>{const h=harness();const token=await h.register();const employee=h.employee();h.state.fail=(table,op)=>{if(table==='employee_sessions'&&op==='insert')employee.updated_at='2021-01-01T00:00:00.000Z';return false;};const r=await h.login(token);assert.equal(r.status,401);assert.equal(r.body.code,'IDENTITY_UNAUTHORIZED');});
test('session on a revoked device reports DEVICE_REVOKED',async()=>{const h=harness();const x=await unlocked(h);h.tables.zude_devices[0].revoked_at=epoch;const r=await h.call('VALIDATE',{session:x.session},x.device);assert.equal(r.status,401);assert.equal(r.body.code,'DEVICE_REVOKED');});

// ---- Idempotent revocation preserves the first audit record -----------------------
test('repeat revocation preserves original revoked_at and revoked_by_user_id',async()=>{const h=harness();const token=await h.register();const id=h.sec.credentialId(token);
 const first=await h.call('REVOKE',{},'account','devices/'+id);assert.equal(first.status,200);const row=h.tables.zude_devices[0];const original={revoked_at:row.revoked_at,revoked_by_user_id:row.revoked_by_user_id,updated_at:row.updated_at};assert.equal(original.revoked_by_user_id,'actor');
 await new Promise(r=>setTimeout(r,5));h.state.role='manager';
 const again=await h.call('REVOKE',{},'account','devices/'+id);assert.equal(again.status,200);assert.equal(again.body.device.revoked_at,original.revoked_at);
 assert.deepEqual({revoked_at:row.revoked_at,revoked_by_user_id:row.revoked_by_user_id,updated_at:row.updated_at},original);
 assert.ok(!JSON.stringify(again.body).includes('credential_'));});
test('repeat revocation stays tenant-scoped',async()=>{const h=harness();const token=await h.register();const id=h.sec.credentialId(token);await h.call('REVOKE',{},'account','devices/'+id);h.tables.zude_devices[0].business_id=B;assert.equal((await h.call('REVOKE',{},'account','devices/'+id)).status,404);});
