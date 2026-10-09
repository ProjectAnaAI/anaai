const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ts = require('typescript');
const { loadPGlite, openDatabase, serviceClient, as } = require('./pglite-db.cjs');
const uuid = () => crypto.randomUUID();
// Execute the two bounded PostgREST query shapes against actual PostgreSQL.
// The separate supabase-js transport test checks their wire representation.
function workingClient(db, hooks, queries) {
  const base = serviceClient(db);
  return { ...base, from(table) {
    let fields, options, business, from = 0, to, filters;
    const calls = [];
    const fallback = base.from(table);
    let special = false;
    const q = {};
    for (const method of ['select','eq','order','limit','range','or','maybeSingle','single']) q[method] = (...args) => {
      calls.push([method,...args]);
      // Only the two Who's Working shapes are intercepted; every other query
      // (Time Clock, My Time, Timesheets) uses the regular SQL shim builder.
      if (method === 'select') {
        [fields,options] = args;
        special = !!options?.count && ((table === 'employees' && String(fields).includes('latest:')) || String(fields).startsWith('employee_id,'));
        if (!special) return fallback.select(...args);
      }
      if (!special) { fallback[method](...args); return q; }
      if (method === 'eq' && args[0] === 'business_id') business = args[1];
      if (method === 'range') [from,to] = args;
      if (method === 'limit' && !args[1]) to = args[0]-1;
      if (method === 'or') filters = args[0];
      return q;
    };
    q.then = (resolve,reject) => {
      if (!special) return Promise.resolve(fallback).then(resolve,reject);
      return (async () => {
        queries.push({table,fields,calls});
        const params = [business];
        let sql;
        if (table === 'employees') {
          assert.ok(fields.includes('latest:employee_time_effective_events!employee_time_effective_events_business_employee_fkey'));
          const event = 'id,seq,event_type,break_type,occurred_at';
          const head = (extra) => `(select coalesce(jsonb_agg(h),'[]') from (select ${event} from public.employee_time_effective_events ev where ev.business_id=e.business_id and ev.employee_id=e.id ${extra} order by seq desc limit 1) h)`;
          sql = `select e.id,e.display_name,e.role,e.is_active,${head('')} as latest,${head("and event_type='CLOCK_IN'")} as opened,count(*) over()::integer as total from public.employees e where business_id=$1 order by id limit ${to+1}`;
        } else {
          assert.equal(table,'employee_time_effective_events');
          const clauses = [...filters.matchAll(/and\(employee_id.eq.([0-9a-f-]{36}),seq.gte.(\d+),seq.lte.(\d+)\)/g)].map(([,id,lo,hi]) => {
            params.push(id,Number(lo),Number(hi)); const n=params.length;
            return `(employee_id=$${n-2} and seq >= $${n-1} and seq <= $${n})`;
          });
          assert.ok(clauses.length && clauses.length<=20);
          await hooks.beforeEvents?.();
          sql=`select employee_id,id,seq,event_type,break_type,occurred_at,count(*) over()::integer as total from public.employee_time_effective_events where business_id=$1 and (${clauses.join(' or ')}) order by seq limit ${to-from+1} offset ${from}`;
        }
        const rows = (await as(db,'service_role',sql,params)).rows;
        const result={data:rows.map(row=>{const safe={...row};delete safe.total;return safe;}),count:rows[0]?.total??0,error:null};
        await hooks.result?.(table,result);
        return result;
      })().then(resolve,reject);
    };
    return q;
  }};
}
async function fixture(t, { serviceFactory = workingClient, workforce = true } = {}) {
  const lib=loadPGlite(); assert.ok(lib,'Required Slice 2 SQL tests need ZUDE_PGLITE_MODULE');
  const db=await openDatabase(lib,{workforce}); t.after(()=>db.close());
  const business=uuid(),other=uuid(),account=uuid();
  await db.query("insert into public.businesses(id,name,timezone) values ($1,'Main','America/Los_Angeles'),($2,'Other','UTC')",[business,other]);
  await db.query('insert into auth.users(id) values ($1)',[account]);
  await db.query("insert into public.business_members values ($1,$2,'owner')",[business,account]);
  async function employee({role='employee',active=true,tenant=business,name='Employee'}={}) {
    const id=uuid(); await db.query("insert into public.employees(id,business_id,display_name,role,is_active,pin_hash,pin_salt,updated_at) values ($1,$2,$3,$4,$5,'synthetic-hash','synthetic-salt',now()-interval '2 hours')",[id,tenant,name,role,active]);return id;
  }
  const actor=await employee({role:'manager',name:'Manager'});
  const token=()=>{const id=uuid(),value=`${id}.${crypto.randomBytes(32).toString('base64url')}`,salt=crypto.randomBytes(16).toString('base64');return {id,value,salt,hash:crypto.createHash('sha256').update(salt).update('\0').update(value).digest('base64')};};
  const dt=token(),st=token();
  // Use credential locators as the actual fixture IDs, never print credentials.
  await db.query("insert into public.zude_devices(id,business_id,name,credential_hash,credential_salt,updated_at) values ($1,$2,'iPad',$3,$4,now()-interval '1 hour')",[dt.id,business,dt.hash,dt.salt]);
  await db.query("insert into public.employee_sessions(id,business_id,device_id,employee_id,token_hash,token_salt,created_at,expires_at) values ($1,$2,$3,$4,$5,$6,(select updated_at from public.zude_devices where id=$3),now()+interval '4 hours')",[st.id,business,dt.id,actor,st.hash,st.salt]);
  async function event(id,type,at,breakType=null) {
    return (await db.query('insert into public.employee_time_events(business_id,employee_id,device_id,event_type,break_type,occurred_at,request_id) values ($1,$2,$3,$4,$5,$6,$7) returning id,seq,event_type,break_type,occurred_at',[business,id,dt.id,type,breakType,new Date(at).toISOString(),uuid()])).rows[0];
  }
  const hooks={},queries=[],service=serviceFactory(db,hooks,queries),cache={};
  function load(file) {
    file=path.resolve(file);if(cache[file])return cache[file];const exports={};cache[file]=exports;
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,{exports,Request,Response,URL,Date,Intl,Buffer,require(name){
      if(name==='@/lib/appointment-actions')return {isUuid:v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)};
      if(name==='@/lib/supabase-server')return {createSupabaseServiceClient:()=>service};
      if(name==='@/lib/business-context')return {resolveBusinessContext:async({accessToken,requestedBusinessId})=>{
        if(accessToken!=='synthetic-account')return {success:false,status:401,code:'UNAUTHORIZED',error:'Unauthorized'};
        const id=requestedBusinessId||business;
        const member=(await db.query('select role from public.business_members where business_id=$1 and user_id=$2',[id,account])).rows[0];
        return member?{success:true,db:service,context:{businessId:id,userId:account,role:member.role}}:{success:false,status:403,code:'NO_BUSINESS_MEMBERSHIP',error:'Forbidden'};
      }};
      if(name.startsWith('.'))return load(path.resolve(path.dirname(file),name+'.ts'));return require(name);
    }},{filename:file});return exports;
  }
  const handler=load('server/handlers/working.ts');
  function request(route,{shared=false,headers={}}={}) {
    return new Request('https://zude.test'+route,{headers:{Authorization:'Bearer synthetic-account',...(shared?{'x-zude-device':dt.value,'x-zude-employee-session':st.value}:{}),...headers}});
  }
  async function get(options={}) { const r=await handler.GET(request('/api/management/working'+(options.query??''),options));return {status:r.status,body:await r.json()}; }
  const timeRequest = route => new Request('https://zude.test'+route,{headers:{Authorization:`ZudeDevice ${dt.value}`,'x-zude-employee-session':st.value}});
  // A PIN session for any employee on the fixture iPad (same generation).
  async function sessionFor(employeeId) {
    const t=token();
    await db.query("insert into public.employee_sessions(id,business_id,device_id,employee_id,token_hash,token_salt,created_at,expires_at) values ($1,$2,$3,$4,$5,$6,(select updated_at from public.zude_devices where id=$3),now()+interval '4 hours')",[t.id,business,dt.id,employeeId,t.hash,t.salt]);
    return {id:t.id,value:t.value};
  }
  return {timeRequest,db,business,other,account,actor,device:dt.id,deviceCredential:dt.value,session:st.id,sessionCredential:st.value,sessionFor,employee,event,get,request,hooks,queries,load,service};
}
module.exports={fixture};
