import { ZudeApiError } from './api';
// Web: locally generated Blob, never a server/public download URL.
export async function shareTimeReport(csv:string,filename:string,signal:AbortSignal){
 if(signal.aborted)throw new ZudeApiError(0,'CANCELLED','Export cancelled.');
 const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');
 try{a.href=url;a.download=filename;document.body.appendChild(a);a.click();}
 finally{a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
}
