const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
function setup({existing=[],fail=false,active='business',user=true}={}) {
 const calls=[]; const exports={};
 const db={auth:{getUser:async()=>({data:{user:user?{id:'authenticated-user'}:null}})},from:table=>{
   calls.push(['table',table]); const q={};let write=false;
   q.select=()=>q;q.order=()=>q;q.range=()=>q;q.eq=(key,value)=>{calls.push(['eq',key,value]);return q};
   for(const method of ['insert','update'])q[method]=value=>{write=true;calls.push([method,value]);return q};
   q.then=resolve=>Promise.resolve({data:existing,error:fail?{}:null}).then(resolve);
   q.single=async()=>({data:fail?null:{id:'saved',full_name:'Example',phone:null,email:null,notes:null},error:fail?{}:null});
   return q;
 }};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/customer-mutations.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports,require:name=>name.includes('active-business')?{activeBusinessHeaders:()=>({'x-anaai-business-id':active})}:{supabase:db}});
 return {api:exports,calls};
}
const input={name:' Example ',phone:'123-456-7890',email:''};
test('valid customer normalized and compatibility auth identity retained',async()=>{const h=setup();await h.api.saveCustomer('business',input);const write=h.calls.find(x=>x[0]==='insert')[1];assert.equal(write.business_id,'business');assert.equal(write.user_id,'authenticated-user');assert.equal(write.full_name,'Example');});
test('formatted duplicate phone rejected within business',async()=>{const h=setup({existing:[{id:'other',phone:'(123) 456-7890'}]});await assert.rejects(h.api.saveCustomer('business',input),/already exists/);assert.ok(!h.calls.some(x=>x[0]==='insert'));assert.ok(h.calls.some(x=>x[0]==='eq'&&x[1]==='business_id'&&x[2]==='business'));});
test('editing scopes ID and business and preserves compatibility owner',async()=>{const h=setup();await h.api.saveCustomer('business',input,{id:'existing'});assert.ok(h.calls.some(x=>x[0]==='eq'&&x[1]==='id'&&x[2]==='existing'));assert.ok(h.calls.some(x=>x[0]==='eq'&&x[1]==='business_id'));assert.equal(h.calls.find(x=>x[0]==='update')[1].user_id,undefined);});
test('current customer excluded from duplicate check',async()=>{const h=setup({existing:[{id:'existing',phone:input.phone}]});await h.api.saveCustomer('business',input,{id:'existing'});});
test('business mismatch blocks writes',async()=>{const h=setup({active:'different'});await assert.rejects(h.api.saveCustomer('business',input),/context changed/);assert.equal(h.calls.length,0);});
test('missing authentication blocks writes',async()=>{const h=setup({user:false});await assert.rejects(h.api.saveCustomer('business',input),/log in/);assert.equal(h.calls.length,0);});
test('duplicate-check errors fail closed',async()=>{const h=setup({fail:true});await assert.rejects(h.api.saveCustomer('business',input),/Unable to check/);assert.ok(!h.calls.some(x=>x[0]==='insert'));});
test('overlapping create calls cannot both submit',async()=>{const h=setup();const first=h.api.saveCustomer('business',input);await assert.rejects(h.api.saveCustomer('business',input),/already being saved/);await first;assert.equal(h.calls.filter(x=>x[0]==='insert').length,1);});
for(const bad of [{...input,name:''},{...input,phone:'bad'},{...input,email:'bad'}])test('invalid required customer fields rejected',()=>{const h=setup();assert.throws(()=>h.api.validateCustomer(bad));});
test('Customers page keeps optional phone',()=>{const h=setup();assert.equal(h.api.validateCustomer({name:'Example',phone:''}).phone,null);});

for (const fields of [{name:'Example',phone:''},{name:'Example',phone:'1234567890'},{name:'Example',phone:'',email:'example@example.invalid'}]) test('optional customer identity fields save successfully',async()=>{const h=setup();await h.api.saveCustomer('business',fields);assert.equal(h.calls.filter(x=>x[0]==='insert').length,1);});
