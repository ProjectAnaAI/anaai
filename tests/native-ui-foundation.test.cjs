const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const ts=require('typescript');
function load(file,imports={}){
 const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync('apps/zude-mobile/src/'+file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require(name){if(name in imports)return imports[name];throw Error(name)}});return exports;
}
const tokens=load('theme/tokens.ts');
const {workspaceLayout}=load('theme/layout.ts',{'./tokens':tokens});
const {visibleNavigation,navigationGroups}=load('navigation/items.ts');
const {statusTone,timelinePresentation,upcomingAppointment,appointmentTiming}=load('features/today/presentation.ts');
for(const [width,height,persistent,split]of[[1024,768,true,true],[1366,1024,true,true],[768,1024,true,false],[390,844,false,false],[1440,900,true,true]])test(`workspace ${width}×${height}: correct responsive composition`,()=>{
 const result=workspaceLayout(width,height);assert.equal(result.persistent,persistent);assert.equal(result.split,split);
 if(split){assert.ok(result.workspaceWidth-result.railWidth>=500,'Primary pane remains usable');assert.equal(result.workspaceWidth+tokens.theme.layout.sidebar,width)}
});
test('large text switches to stacked presentation and larger text to drawer navigation',()=>{
 assert.equal(workspaceLayout(1024,768,1.3).split,false);assert.equal(workspaceLayout(1024,768,1.5).persistent,false);
});
test('touch target foundation never falls below 44pt',()=>{
 assert.ok(tokens.theme.layout.touch>=44);assert.ok(tokens.theme.control.height>=44);assert.ok(tokens.theme.control.row>=44);
});
for(const role of ['owner','manager','staff'])test(`${role}: only implemented destinations navigate`,()=>{
 const items=visibleNavigation(role).flatMap(g=>g.items).filter(i=>i.state==='AVAILABLE_NATIVE');
 const expected=role==='staff'?'["Today","Appointments","Customers","Services","Time Clock","My Time","Device & PIN","Lock"]':'["Today","Appointments","Customers","Services","Time Clock","My Time","Who’s Working","Team","Timesheets","Reported Issues","Audit History","Reports","Registered Devices","Device & PIN","Lock"]';
 assert.equal(JSON.stringify(items.map(i=>i.label)),expected,'staff never receives Team administration');
 assert.ok(items.every(i=>['/time-issues','/audit','/reports','/timesheets','/working','/','/appointments','/customers','/services','/time-clock','/my-time','/device','/team','/devices'].includes(i.route)));
});
test('navigation architecture retains future IA without fake routes or front-end authorization grants',()=>{
 assert.equal(JSON.stringify(navigationGroups.map(g=>g.title)),'["Operations","My Work","Manage","Ana AI","Business","System"]');
 const manage=navigationGroups.find(g=>g.title==='Manage').items;
 assert.ok(manage.every(i=>i.roles.includes('owner')&&i.roles.includes('manager')&&!i.roles.includes('staff')));
 assert.equal(manage.find(i=>i.label==='Team').route,'/team');
 assert.ok(manage.filter(i=>!['Team','Who’s Working','Timesheets','Reported Issues','Audit History','Reports'].includes(i.label)).every(i=>!i.route&&i.state!=='AVAILABLE_NATIVE'),'Standalone Corrections stays non-navigable; correction UI lives in Timesheets and Issues');
 assert.equal(navigationGroups.find(g=>g.title==='System').items.find(i=>i.label==='Device & PIN').route,'/device');
});
const row=(id,start,status='Booked',duration=30)=>({id,start,status,duration,customer:id,service:'Service'});
test('timeline orders real data without mutating it; NOW divides elapsed/future starts',()=>{
 const rows=[row('later',780),row('unknown',null),row('earlier',540),row('current',630)];
 const {ordered,nowIndex}=timelinePresentation(rows,645);assert.equal(JSON.stringify(ordered.map(a=>a.id)),'["earlier","current","later","unknown"]');assert.equal(nowIndex,2);assert.equal(rows[0].id,'later');
});
test('NOW position handles empty, early, late and unavailable clock',()=>{
 assert.equal(timelinePresentation([],645).nowIndex,0);assert.equal(timelinePresentation([row('a',540)],500).nowIndex,0);
 assert.equal(timelinePresentation([row('a',540)],600).nowIndex,1);assert.equal(timelinePresentation([row('a',null)],null).nowIndex,-1);
});
test('up next excludes unknown-time, past and terminal rows and uses nearest real appointment',()=>{
 const rows=[row('cancelled',700,'Cancelled'),row('unknown',null),row('past',540),row('far',800),row('next',710,'Confirmed')];
 assert.equal(upcomingAppointment(rows,690).id,'next');assert.equal(upcomingAppointment(rows,900),undefined);assert.equal(upcomingAppointment(rows,null),undefined);
});
test('current/past appearance preserves status semantics and uses duration snapshot',()=>{
 assert.equal(appointmentTiming(row('active',630,'Confirmed',45),645).current,true);
 assert.equal(appointmentTiming(row('finished',600,'Confirmed',30),645).past,true);
 assert.equal(appointmentTiming(row('terminal',630,'Cancelled',45),645).current,false);
 assert.equal(appointmentTiming(row('unknown',630,'Confirmed',null),645).current,false);
});
test('semantic status treatment: confirmed green, booked amber, terminal neutral',()=>{
 assert.equal(statusTone('Confirmed'),'success');assert.equal(statusTone('Booked'),'warning');assert.equal(statusTone('Completed'),'neutral');assert.equal(statusTone('Cancelled'),'neutral');
});

const {dateLabel}=load('components/datePresentation.ts');
test('calendar date presentation is readable, preserves year and does not shift by device timezone',()=>{
 assert.equal(dateLabel('2026-09-28'),'Monday, September 28, 2026');
 assert.equal(dateLabel('2026-09-28',true),'Sep 28, 2026');
 assert.equal(dateLabel('2028-02-29'),'Tuesday, February 29, 2028');
 for(const value of ['2026-02-29','2026-13-01','0000-01-01','','not-a-date'])assert.equal(dateLabel(value),'Choose a date');
});
test('catalog represents real web capabilities and phase-two limits without inventing routes',()=>{
 const items=navigationGroups.flatMap(g=>g.items);
 for(const label of ['Customers','Services']){
  const item=items.find(i=>i.label===label);assert.equal(item.state,'AVAILABLE_NATIVE');assert.equal(item.route,'/'+label.toLowerCase());assert.equal(item.webRoute,'/'+label.toLowerCase());
 }
 for(const label of ['Analytics','Business & Availability','Settings']){
  const item=items.find(i=>i.label===label);assert.equal(item.state,'EXISTING_WEB_CAPABILITY');assert.ok(item.webRoute);assert.equal(item.route,undefined);
 }
 for(const label of ['Voice Assistant','Calls','Knowledge'])assert.equal(items.find(i=>i.label===label).state,'PHASE_2');
 assert.equal(items.find(i=>i.label==='Calls').webRoute,undefined,'web call history is unavailable too');
 // M05: real destinations for every PIN role; no role or permission filter.
 for(const [label,route] of [['Time Clock','/time-clock'],['My Time','/my-time']]){const item=items.find(i=>i.label===label);assert.equal(item.state,'AVAILABLE_NATIVE');assert.equal(item.route,route);assert.equal(item.roles,undefined);assert.equal(item.permission,undefined)}
 assert.ok(items.filter(i=>i.state!=='AVAILABLE_NATIVE').every(i=>!i.route));
});
test('membership-filtered catalog exposes employee operations without management grants',()=>{
 const employee=visibleNavigation('staff').flatMap(g=>g.items);
 for(const label of ['Today','Appointments','Customers','Services','Time Clock','My Time'])assert.ok(employee.some(i=>i.label===label));
 assert.ok(!visibleNavigation('staff').some(g=>g.title==='Manage'));
 for(const role of ['owner','manager'])assert.ok(visibleNavigation(role).find(g=>g.title==='Manage').items.some(i=>i.label==='Analytics'));
});
const {upcomingTimingLabel}=load('features/today/presentation.ts');
test('upcoming timing derives only from the supplied business clock and appointment start',()=>{
 assert.equal(upcomingTimingLabel(780,732),'Starts in 48 mins');
 assert.equal(upcomingTimingLabel(780,779),'Starts in 1 min');
 assert.equal(upcomingTimingLabel(780,780),'Starting now');
 for(const [start,now]of[[null,780],[780,null],[779,780]])assert.equal(upcomingTimingLabel(start,now),'Upcoming appointment');
});
test('light timeline and muted appointment text preserve readable contrast',()=>{
 function luminance(hex){const c=hex.slice(1).match(/../g).map(v=>parseInt(v,16)/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4);return c[0]*0.2126+c[1]*0.7152+c[2]*0.0722}
 function contrast(a,b){const x=luminance(a),y=luminance(b);return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05)}
 const c=tokens.theme.colors;
 assert.ok(contrast(c.timeline,c.timelineText)>=4.5);
 assert.ok(contrast(c.upcomingSurface,c.brandText)>=4.5);assert.ok(contrast(c.surface,c.rowMuted)>=4.5);
});
