// Real migrations and SQL, with deliberate changes after HTTP authorization.
// This required Slice-1 suite fails (rather than skips) without PGlite.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { loadPGlite, openDatabase, serviceClient, as } = require('./support/pglite-db.cjs');
const lib = loadPGlite();
const baseline = process.env.ZUDE_TEST_M04_BASELINE === '1';
const uuid = () => crypto.randomUUID();
async function fixture(t, { accountRole = 'owner', employeeRole = 'manager', shared = true } = {}) {
  assert.ok(lib, 'Required SQL tests need PGlite; set ZUDE_PGLITE_MODULE');
  const db = await openDatabase(lib, { m06: !baseline }); t.after(() => db.close());
  const business = uuid(), other = uuid(), account = uuid(), actor = uuid(), device = uuid(), session = uuid();
  await db.query(`insert into public.businesses(id,name) values ($1,'A'),($2,'B')`, [business, other]);
  await db.query(`insert into auth.users(id) values ($1)`, [account]);
  await db.query(`insert into public.business_members values ($1,$2,$3)`, [business, account, accountRole]);
  async function employee(role = 'employee', tenant = business, active = true) {
    const id = uuid();
    await db.query(`insert into public.employees(id,business_id,display_name,role,pin_hash,pin_salt,is_active,updated_at) values ($1,$2,'Target',$3,'synthetic-hash','synthetic-salt',$4,now()-interval '2 hours')`, [id, tenant, role, active]);
    return id;
  }
  await db.query(`insert into public.employees(id,business_id,display_name,role,pin_hash,pin_salt,updated_at) values ($1,$2,'Actor',$3,'actor-hash','actor-salt',now()-interval '2 hours')`, [actor, business, employeeRole]);
  await db.query(`insert into public.zude_devices(id,business_id,name,credential_hash,credential_salt,updated_at) values ($1,$2,'iPad','device-hash','device-salt',now()-interval '1 hour')`, [device,business]);
  await db.query(`insert into public.employee_sessions(id,business_id,device_id,employee_id,token_hash,token_salt,created_at,expires_at) values ($1,$2,$3,$4,'session-hash','session-salt',(select updated_at from public.zude_devices where id=$3),now()+interval '4 hours')`, [session,business,device,actor]);
  const target = await employee();
  const row = async id => (await db.query('select * from public.employees where id=$1',[id])).rows[0];
  const args = async (id = target, values = { display_name: 'Changed' }) => ({
    p_business_id: business, p_actor_id: account, p_employee_id: id,
    p_expected_updated_at: id ? (await row(id)).updated_at : null,
    p_pin_snapshot: (id === null || Object.hasOwn(values,'pin_hash')) ? (await db.query('select id,pin_hash,pin_salt from public.employees where business_id=$1 and is_active order by id',[business])).rows : null,
    p_values: values, p_authority_mode: shared ? 'shared-device' : 'account', p_expected_account_role: accountRole,
    p_actor_employee_id: shared ? actor : null, p_actor_device_id: shared ? device : null, p_actor_session_id: shared ? session : null,
  });
  const write = async params => {
    const entries = Object.entries(params).filter(([key]) => !baseline || !['p_authority_mode','p_expected_account_role','p_actor_employee_id','p_actor_device_id','p_actor_session_id'].includes(key));
    return as(db, 'service_role', `select * from public.m04_write_employee(${entries.map(([key],i) => `${key} => $${i+1}`).join(',')})`, entries.map(([,v]) => v));
  };
  const audits = async () => (await db.query('select * from public.employee_management_actions order by recorded_at,id')).rows;
  return { db,business,other,account,actor,device,session,target,employee,row,args,write,audits };
}
async function denied(h, args, code = '42501') {
  await assert.rejects(h.write(args), e => e.code === code);
  if (!baseline) assert.equal((await h.audits()).length,0);
}

test('M06 manager can update employee with exactly one safe, verified audit record', async t => {
  const h = await fixture(t); await h.write(await h.args());
  const [audit] = await h.audits(); assert.equal((await h.audits()).length,1);
  assert.equal(audit.actor_user_id,h.account); assert.equal(audit.actor_employee_id,h.actor);
  assert.equal(audit.actor_device_id,h.device); assert.equal(audit.actor_session_id,h.session);
  assert.equal(audit.effective_role,'manager'); assert.equal(audit.authority_mode,'shared-device');
  assert.equal(audit.before_value.display_name,'Target'); assert.equal(audit.after_value.display_name,'Changed');
  assert.equal((await h.row(h.target)).display_name,'Changed');
});
for (const role of ['manager','owner']) test(`M06 manager cannot mutate ${role}, including reactivation and PIN reset`, async t => {
  const h = await fixture(t), id = await h.employee(role);
  for (const values of [{display_name:'No'}, {role:'employee'}, {is_active:false}, {pin_hash:'new-hash',pin_salt:'new-salt'}]) await denied(h,await h.args(id,values));
  await h.db.query('update public.employees set is_active=false where id=$1',[id]);
  await denied(h,await h.args(id,{is_active:true,pin_hash:'new-hash',pin_salt:'new-salt'}));
});
for (const role of ['manager','owner']) test(`M06 manager cannot create or promote to ${role}`, async t => {
  const h = await fixture(t); await denied(h,await h.args(h.target,{role}));
  await denied(h,await h.args(null,{display_name:'New',role,pin_hash:'new-hash',pin_salt:'new-salt'}));
});
test('M06 owner retains manager and existing owner-provisioning operations', async t => {
  const h = await fixture(t,{employeeRole:'owner'});
  for (const role of ['employee','manager','owner']) {
    const target = await h.employee(role); await h.write(await h.args(target));
    await h.write(await h.args(null,{display_name:'Created',role,pin_hash:'new-hash',pin_salt:'new-salt'}));
  }
  assert.equal((await h.audits()).length,6);
});
test('M06 employee PIN never inherits owner account authority', async t => {
  const h = await fixture(t,{employeeRole:'employee'}); await denied(h,await h.args());
});
test('M06 cross-business target is rejected without mutation or audit', async t => {
  const h = await fixture(t), foreign = await h.employee('employee',h.other);
  await denied(h,await h.args(foreign),'40001'); assert.equal((await h.row(foreign)).display_name,'Target');
});
const races = [
  ['membership removed',h=>h.db.query('delete from public.business_members where user_id=$1',[h.account]),'42501'],
  ['account role changed',h=>h.db.query("update public.business_members set role='manager' where user_id=$1",[h.account]),'42501'],
  ['actor deactivated',h=>h.db.query('update public.employees set is_active=false where id=$1',[h.actor]),'28000'],
  ['actor generation changed',h=>h.db.query('update public.employees set updated_at=clock_timestamp() where id=$1',[h.actor]),'28000'],
  ['actor demoted',h=>h.db.query("update public.employees set role='employee' where id=$1",[h.actor]),'42501'],
  ['session revoked',h=>h.db.query('update public.employee_sessions set revoked_at=clock_timestamp() where id=$1',[h.session]),'28000'],
  ['session expired',h=>h.db.query("update public.employee_sessions set expires_at=now()-interval '1 minute' where id=$1",[h.session]),'28000'],
  ['device revoked',h=>h.db.query('update public.zude_devices set revoked_at=clock_timestamp() where id=$1',[h.device]),'28000'],
  ['device generation changed',h=>h.db.query('update public.zude_devices set updated_at=clock_timestamp() where id=$1',[h.device]),'28000'],
  ['session rebound',h=>h.db.query('update public.employee_sessions set employee_id=$1 where id=$2',[h.target,h.session]),'28000'],
  ['target promoted',h=>h.db.query("update public.employees set role='manager' where id=$1",[h.target]),'42501'],
];
for (const [name,change,code] of races) test(`M06 transaction rejects ${name} after initial authorization`, async t => {
  const h = await fixture(t), args = await h.args(); await change(h); await denied(h,args,code);
  assert.equal((await h.row(h.target)).display_name,'Target');
});
test('M06 account setup mode remains available and cannot carry partial operational attribution',async t=>{
  const h=await fixture(t,{shared:false,accountRole:'manager'}); const args=await h.args();
  await denied(h,{...args,p_actor_device_id:h.device});
  await h.write(args); const [audit]=await h.audits(); assert.equal(audit.authority_mode,'account'); assert.equal(audit.actor_employee_id,null);
});
test('M06 compound change, deactivation, fresh-PIN reactivation and reset have one audit each, no secrets',async t=>{
  const h=await fixture(t,{employeeRole:'owner'});
  await h.write(await h.args(h.target,{display_name:'Renamed',role:'manager'}));
  await h.write(await h.args(h.target,{is_active:false}));
  await h.write(await h.args(h.target,{is_active:true,pin_hash:'PRIVATE_PIN_HASH',pin_salt:'PRIVATE_PIN_SALT'}));
  const args=await h.args(h.target,{pin_hash:'SECOND_PRIVATE_HASH',pin_salt:'SECOND_PRIVATE_SALT'});
  await h.write(args);
  // Team has no request-idempotency contract: a stale RPC replay is rejected.
  await assert.rejects(h.write(args),e=>e.code==='40001');
  const audits=await h.audits(); assert.equal(audits.length,4);
  assert.deepEqual(audits.map(a=>a.action),['employee.updated','employee.deactivated','employee.reactivated','employee.pin_reset']);
  assert.equal(audits[3].pin_reset,true);
  const serialized=JSON.stringify(audits); for(const secret of ['PRIVATE','pin_hash','pin_salt','token_hash','credential_hash','session-hash','device-hash']) assert.ok(!serialized.includes(secret),'no security material in audit');
});
test('M06 audit and employee direct writes denied; immutable even with future grants; tenant deletion retained',async t=>{
  const h=await fixture(t); await h.write(await h.args());
  for(const role of ['anon','authenticated','service_role']) {
    for(const sql of ["update public.employee_management_actions set action='employee.created'",'delete from public.employee_management_actions','truncate public.employee_management_actions',"insert into public.employee_management_actions default values", "update public.employees set display_name='No'",'delete from public.employees']) await assert.rejects(as(h.db,role,sql));
    if(role!=='service_role') await assert.rejects(as(h.db,role,'select * from public.employee_management_actions'));
  }
  for(const sql of ["update public.employee_management_actions set action='employee.created'",'delete from public.employee_management_actions','truncate public.employee_management_actions cascade']) await assert.rejects(h.db.exec(sql),e=>e.code==='42501');
  await h.db.exec('grant update,delete,truncate on public.employee_management_actions to service_role');
  await assert.rejects(as(h.db,'service_role','delete from public.employee_management_actions'),e=>e.code==='42501');
  await h.db.query('delete from auth.users where id=$1',[h.account]);
  assert.equal((await h.audits())[0].actor_user_id,h.account,'historical account attribution retained');
  await h.db.query('delete from public.businesses where id=$1',[h.business]); assert.equal((await h.audits()).length,0);
});
test('M06 missing/forged actor bindings and unknown sensitive input fail closed',async t=>{
  const h=await fixture(t), args=await h.args();
  for(const key of ['p_actor_employee_id','p_actor_device_id','p_actor_session_id']) {
    await denied(h,{...args,[key]:null}); await denied(h,{...args,[key]:uuid()},'28000');
  }
  await denied(h,{...args,p_values:{display_name:'No',unexpected:'secret'}},'22023');
});

// Real handlers, credential verifier, operational boundary and write RPC.
// Only Supabase bearer authentication is stubbed; it resolves actual fixture
// memberships. The beforeRpc hook is the auth-to-transaction race boundary.
async function httpFixture(t, options) {
  const h=await fixture(t,options), vm=require('node:vm'), path=require('node:path'), ts=require('typescript');
  const tokenFor=async(id,table,hashColumn,saltColumn)=>{
    const token=`${id}.${crypto.randomBytes(32).toString('base64url')}`,salt=crypto.randomBytes(16).toString('base64');
    const hash=crypto.createHash('sha256').update(salt).update('\0').update(token).digest('base64');
    await h.db.query(`update public.${table} set ${hashColumn}=$1,${saltColumn}=$2 where id=$3`,[hash,salt,id]); return token;
  };
  const deviceToken=await tokenFor(h.device,'zude_devices','credential_hash','credential_salt');
  const sessionToken=await tokenFor(h.session,'employee_sessions','token_hash','token_salt');
  const base=serviceClient(h.db), hooks={}, cache=new Map();
  const service={...base,rpc(name,args){
    let fields='*'; return {select(value){fields=value;return this;},async single(){
      await hooks.beforeRpc?.();
      try {
        const rows=(await h.write(args)).rows;
        const data=rows[0]; if(!data)return {data:null,error:{code:'PGRST116'}};
        return {data:Object.fromEntries(fields.split(',').map(k=>[k.trim(),data[k.trim()]])),error:null};
      }catch(error){return {data:null,error:{code:error.code}};}
    }};
  }};
  function load(file){
    file=path.resolve(file); if(cache.has(file))return cache.get(file);
    const exports={};cache.set(file,exports);
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,
      {exports,Buffer,Request,Response,URL,Date,console:{error(){},warn(){},log(){}},require(name){
        if(name==='@/lib/supabase-server')return {createSupabaseServiceClient:()=>service};
        if(name==='@/lib/appointment-actions')return {isUuid:v=>typeof v==='string'&&/^[0-9a-f-]{36}$/.test(v)};
        if(name==='@/lib/business-context')return {resolveBusinessContext:async({accessToken})=>{
          assert.ok(accessToken==='synthetic-account-token');
          const [member]=(await h.db.query('select role from public.business_members where business_id=$1 and user_id=$2',[h.business,h.account])).rows;
          return member?{success:true,db:base,context:{businessId:h.business,userId:h.account,role:member.role}}:{success:false,status:403,code:'NO_BUSINESS_MEMBERSHIP',error:'No membership'};
        }};
        if(name.startsWith('.'))return load(path.resolve(path.dirname(file),name+'.ts'));
        return require(name);
      }},{filename:file}); return exports;
  }
  const team=load('server/handlers/team.ts'), authority=load('server/operational-authority.ts');
  const request=(method='PATCH',body={name:'HTTP name'},headers={},route=`/api/team/${h.target}`)=>new Request(`https://zude.test${route}`,{method,headers:{Authorization:'Bearer synthetic-account-token','x-zude-device':deviceToken,'x-zude-employee-session':sessionToken,...headers},body:JSON.stringify(body)});
  return {...h,hooks,team,authority,request,deviceToken,sessionToken};
}
test('M06 HTTP retains only verified actor IDs, and its successful Team write audits them',async t=>{
  const h=await httpFixture(t);
  const result=await h.authority.managementAuthority(h.request(),{businessId:h.business,userId:h.account,role:'owner'});
  assert.equal(result.ok,true); assert.equal(result.authority.accountUserId,h.account);
  assert.equal(result.authority.employeeId,h.actor);assert.equal(result.authority.role,'manager');
  const serialized=JSON.stringify(result); assert.ok(!serialized.includes(h.deviceToken)&&!serialized.includes(h.sessionToken));
  assert.doesNotMatch(serialized,/hash|salt|credential|token/i);
  const response=await h.team.UPDATE(h.request());assert.equal(response.status,200);
  const body=await response.json();assert.equal(body.employee.display_name,'HTTP name');assert.equal((await h.audits()).length,1);
  assert.doesNotMatch(JSON.stringify(body),/pin_hash|pin_salt|token_hash|credential_hash/);
});
for(const [name,change,status,code] of [
  ['session revoked',h=>h.db.query('update public.employee_sessions set revoked_at=clock_timestamp() where id=$1',[h.session]),401,'IDENTITY_UNAUTHORIZED'],
  ['account downgraded',h=>h.db.query("update public.business_members set role='staff' where user_id=$1",[h.account]),403,'ROLE_FORBIDDEN'],
  ['target promoted',h=>h.db.query("update public.employees set role='manager' where id=$1",[h.target]),403,'ROLE_FORBIDDEN'],
  ['target edited',h=>h.db.query('update public.employees set updated_at=clock_timestamp() where id=$1',[h.target]),409,'TEAM_CHANGED'],
])test(`M06 HTTP preserves safe failure for ${name} between auth and commit`,async t=>{
  const h=await httpFixture(t);h.hooks.beforeRpc=()=>change(h);
  const response=await h.team.UPDATE(h.request());assert.equal(response.status,status);assert.equal((await response.json()).code,code);
  assert.equal((await h.audits()).length,0);assert.equal((await h.row(h.target)).display_name,'Target');
});
test('M06 public RPC grants: no legacy overload, no client execution or helper access',async t=>{
  const h=await fixture(t);
  const functions=(await h.db.query("select p.oid::regprocedure::text as signature,p.prosecdef,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('m04_write_employee','m06_assert_management_actor')")).rows;
  assert.equal(functions.length,2);
  for(const fn of functions){
    assert.equal(fn.prosecdef,true); assert.ok(fn.proconfig.some(v=>v==='search_path=""'));
    for(const role of ['anon','authenticated','service_role']){
      const can=(await h.db.query('select has_function_privilege($1,$2,\'EXECUTE\') as can',[role,fn.signature])).rows[0].can;
      assert.equal(can,role==='service_role'&&fn.signature.startsWith('m04_write_employee('));
    }
    const publicExecute=(await h.db.query("select exists(select 1 from pg_proc p, lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=$1::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE') as can",[fn.signature])).rows[0].can;
    assert.equal(publicExecute,false);
  }
  assert.equal((await h.db.query("select relrowsecurity from pg_class where oid='public.employee_management_actions'::regclass")).rows[0].relrowsecurity,true);
});
test('M06 HTTP create and PIN reset audit once; duplicate PIN create adds no audit',async t=>{
  const h=await httpFixture(t);
  const input={name:'New employee',role:'employee',pin:'1357'};
  const created=await h.team.CREATE(h.request('POST',input,{},'/api/team'));assert.equal(created.status,201);
  const id=(await created.json()).employee.id;
  const duplicate=await h.team.CREATE(h.request('POST',input,{},'/api/team'));assert.equal(duplicate.status,409);
  assert.equal((await h.audits()).length,1);
  const reset=await h.team.RESET_PIN(h.request('POST',{pin:'2468'},{},`/api/team/${id}/pin`));assert.equal(reset.status,200);
  const audits=await h.audits();assert.equal(audits.length,2);assert.equal(audits[1].pin_reset,true);
  assert.doesNotMatch(JSON.stringify(audits), /"1357"|"2468"/, 'PIN values absent');
});
test('M06 audit failure rolls back employee and session mutations atomically',async t=>{
  const h=await fixture(t);
  const targetSession=uuid();
  await h.db.query(`insert into public.employee_sessions(id,business_id,device_id,employee_id,token_hash,token_salt,expires_at) values ($1,$2,$3,$4,'hash','salt',now()+interval '1 hour')`,[targetSession,h.business,h.device,h.target]);
  await h.db.exec(`create function public.test_audit_failure() returns trigger language plpgsql as $$ begin raise exception 'test'; end $$;
    create trigger test_audit_failure before insert on public.employee_management_actions for each row execute function public.test_audit_failure();`);
  await assert.rejects(h.write(await h.args()));
  assert.equal((await h.row(h.target)).display_name,'Target');assert.equal((await h.audits()).length,0);
  assert.equal((await h.db.query('select revoked_at from public.employee_sessions where id=$1',[targetSession])).rows[0].revoked_at,null);
});
test('M06 owner self-edit records pre-change actor attribution and invalidates that session',async t=>{
  const h=await fixture(t,{employeeRole:'owner'});
  await h.write(await h.args(h.actor,{display_name:'New actor name'}));
  const [audit]=await h.audits();assert.equal(audit.actor_name_snapshot,'Actor');assert.equal(audit.after_value.display_name,'New actor name');
  assert.ok((await h.db.query('select revoked_at from public.employee_sessions where id=$1',[h.session])).rows[0].revoked_at);
});
test('M06 failed PIN snapshot and missing reactivation PIN never write history',async t=>{
  const h=await fixture(t), args=await h.args(null,{display_name:'New',role:'employee',pin_hash:'new',pin_salt:'salt'});
  await h.employee();await denied(h,args,'40001');
  const inactive=await h.employee('employee',h.business,false);
  await denied(h,await h.args(inactive,{is_active:true}),'22023');
});
