import { useEffect,useRef,useState } from 'react';
import { Text,View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { Button,styles as ui } from '../../components/ui';
import { LabeledField,RecordRow,recordStyles as rs } from '../../components/records';
import { Feedback,MasterDetail,PaneTitle,WorkspaceHeader,workspaceStyles as ws } from '../../components/workspace';
import { getIssue,getIssues,issueMessage,resolveIssue,type IssueDetail } from '../../lib/time-issues-api';
import { ZudeApiError } from '../../lib/api';
import { useManagementScope } from './useManagementScope';
import { useTimeResource } from '../time/useTimeResource';
import { CorrectionPanel } from '../timesheets/CorrectionPanel';
import { formatDay,formatDuration } from '../time/state';
export function TimeIssuesScreen(){const access=useManagementScope();return <View style={ws.page}><WorkspaceHeader title="Reported Issues" business={access.business.name} subtitle="Employee reports and recorded resolutions"/>{access.scope?<Issues key={access.scope} businessId={access.business.id} userId={access.userId!}/>:<Feedback title="Management access required" detail="Unlock with an authorized identity to view issues."/>}</View>;}
function Issues({businessId,userId}:{businessId:string;userId:string}){
 const [status,setStatus]=useState('open'),[cursor,setCursor]=useState<string|null>(null),[selected,setSelected]=useState<string|null>(null);
 const list=useTimeResource(`${businessId}:${status}:${cursor}`,signal=>getIssues(businessId,status,cursor,signal));
 const detail=useTimeResource(selected?`${businessId}:${selected}`:null,signal=>getIssue(businessId,selected!,signal));
 const view=!detail.loading&&!detail.error?detail.data:null;
 const refresh=()=>{list.refresh();detail.refresh();};
 return <MasterDetail fixed={{side:'master',width:300}} showDetail={!!selected} onBack={()=>setSelected(null)} backLabel="Issues" master={<>
 <PaneTitle title="Employee reports"/><View style={rs.actions}>{['open','resolved','all'].map(value=><Button key={value} label={value==='open'?'Unresolved':value==='resolved'?'Resolved':'All'} secondary disabled={status===value} onPress={()=>{setStatus(value);setCursor(null);setSelected(null);}}/>)}</View>
 <Button label="Refresh" secondary onPress={refresh}/>{list.error?<Feedback kind="error" title="Issues unavailable" detail={issueMessage(list.error)} retry={list.refresh}/>:list.loading?<Feedback kind="loading" title="Loading issues"/>:<>
 {!list.data?.issues.length&&<Feedback title="No issues"/>}{list.data?.issues.map(i=><RecordRow key={i.id} label={`View report from ${i.employee_name}`} selected={selected===i.id} onPress={()=>setSelected(i.id)}><Text style={ui.strong}>{i.employee_name}</Text><Text style={ui.body} numberOfLines={2}>{i.note}</Text><Text style={ui.meta}>{i.work_date?formatDay(i.work_date):'No work date'} · {i.status}</Text></RecordRow>)}
 <View style={rs.actions}>{cursor&&<Button label="First page" secondary onPress={()=>{setCursor(null);setSelected(null);}}/>}{list.data?.nextCursor&&<Button label="Next page" secondary onPress={()=>{setCursor(list.data!.nextCursor);setSelected(null);}}/>}</View></>}
 </>} detail={!selected?<Feedback title="Choose a report"/>:detail.error?<Feedback kind="error" title="Issue unavailable" detail={issueMessage(detail.error)} retry={refresh}/>:!view?<Feedback kind="loading" title="Loading issue context"/>:<Issue key={`${selected}:${detail.fetchedAt}`} view={view} businessId={businessId} userId={userId} refresh={refresh}/>}/>;
}
function Issue({view,businessId,userId,refresh}:{view:IssueDetail;businessId:string;userId:string;refresh:()=>void}){
 const [day,setDay]=useState(view.issue.work_date??view.timesheet.days[0].date),[correcting,setCorrecting]=useState(false),[note,setNote]=useState(''),[correctionId,setCorrectionId]=useState<string|null>(null),[review,setReview]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState<string|null>(null),[intent,setIntent]=useState<{key:string;note:string;correctionId:string|null}|null>(null);
 const alive=useRef(true),controller=useRef<AbortController|null>(null),submitting=useRef(false);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;controller.current?.abort();};},[]);
 const submit=async()=>{if(submitting.current)return;submitting.current=true;setBusy(true);const next=intent??{key:randomUUID(),note:note.trim(),correctionId};setIntent(next);const c=new AbortController();controller.current=c;
 try{await resolveIssue(businessId,userId,view.issue.id,next,c.signal);if(alive.current)refresh();}
 catch(e){if(!alive.current)return;setMessage(issueMessage(e));if(e instanceof ZudeApiError&&[401,403,404,409].includes(e.status)){setNote('');setIntent(null);setReview(false);refresh();}}
 finally{if(alive.current){submitting.current=false;setBusy(false);}}};
 const selectedDay=view.timesheet.days.find(d=>d.date===day)??view.timesheet.days[0];
 return <><PaneTitle title={view.issue.employee_name} detail={`${view.issue.status==='open'?'Unresolved':'Resolved'} · Submitted ${new Date(view.issue.created_at).toLocaleString()}`}/>
 <Text style={ui.body}>{view.issue.note}</Text><Text style={ui.meta}>Work date: {view.issue.work_date??'Not specified'}</Text>
 {view.originalEvent&&<Text style={ui.meta}>Originally reported event: {view.originalEvent.event_type} · {new Date(view.originalEvent.occurred_at).toLocaleString()}</Text>}
 {view.referencedEventVoided&&<Text style={ui.strong}>The referenced event was removed by a correction. The original report is retained.</Text>}
 {view.currentEvent&&<Text style={ui.meta}>Current event: {view.currentEvent.event_type} · {new Date(view.currentEvent.occurred_at).toLocaleString()}</Text>}
 <PaneTitle title="Current time interpretation" detail={view.timesheet.timezone}/><Text style={ui.strong}>{formatDuration(view.timesheet.totals.workedMs)} worked in this week</Text>
 {view.timesheet.days.map(d=><RecordRow key={d.date} label={`View ${d.date}`} selected={selectedDay.date===d.date} onPress={()=>{setDay(d.date);setCorrecting(false);}}><Text style={ui.body}>{formatDay(d.date)} · {formatDuration(d.workedMs)} worked · {d.shifts.length} shifts</Text></RecordRow>)}
 {selectedDay.shifts.map(s=><Text key={s.id} style={ui.body}>{new Date(s.clockInAt).toLocaleString()} – {s.clockOutAt?new Date(s.clockOutAt).toLocaleString():'Open'} · {formatDuration(s.workedMs)} worked</Text>)}
 {view.issue.status==='resolved'?<><PaneTitle title="Resolution"/><Text style={ui.body}>{view.issue.resolution?.note??'Resolved previously; no attributable resolution history is available.'}</Text>{view.issue.resolution&&<Text style={ui.meta}>{new Date(view.issue.resolution.recordedAt).toLocaleString()}{view.issue.resolution.correctionId?' · Linked to a committed correction':''}</Text>}</>:<>
 {!correcting&&<Button label="Correct time" secondary onPress={()=>setCorrecting(true)}/>}{correcting&&<CorrectionPanel key={selectedDay.date} businessId={businessId} userId={userId} sheet={view.timesheet} day={selectedDay} onClose={()=>setCorrecting(false)} onCommitted={()=>{setCorrecting(false);refresh();}} onStale={refresh} onAuthorityLost={refresh}/>}
 <PaneTitle title="Resolve issue" detail="A correction does not resolve this report automatically."/>
 {!review?<><LabeledField label="Resolution note" value={note} onChangeText={setNote} multiline maxLength={500}/><Text style={ui.meta}>Optional: link one of the 50 most recent committed corrections.</Text><Button label="No linked correction" secondary disabled={!correctionId} onPress={()=>setCorrectionId(null)}/>{view.recentCorrections.map(c=><Button key={c.id} label={`${correctionId===c.id?'Selected · ':''}${new Date(c.created_at).toLocaleDateString()} · ${c.reason}`} secondary onPress={()=>setCorrectionId(c.id)}/>)}<Button label="Review resolution" disabled={note.trim().length<3||!/[\p{L}\p{N}]/u.test(note)} onPress={()=>setReview(true)}/></>:<><Text style={ui.body}>{intent?.note??note.trim()}</Text><Text style={ui.meta}>{correctionId?'A committed correction will be linked.':'No correction will be linked.'} This resolution is final.</Text>{message&&<Text accessibilityRole="alert" style={ui.body}>{message}</Text>}<Button label={intent?'Retry same resolution':'Confirm resolution'} disabled={busy} onPress={()=>void submit()}/>{!intent&&<Button label="Back to edit" secondary onPress={()=>setReview(false)}/>}</>}
 </>}</>;
}
