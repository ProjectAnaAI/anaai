import { File,Directory,Paths } from 'expo-file-system';
import { isAvailableAsync,shareAsync } from 'expo-sharing';
import { randomUUID } from 'expo-crypto';
import { ZudeApiError } from './api';
// Native: private cache only. No uploads or token-bearing file URLs.
export async function shareTimeReport(csv:string,filename:string,signal:AbortSignal){
 const check=()=>{if(signal.aborted)throw new ZudeApiError(0,'CANCELLED','Export cancelled.');};check();
 if(!await isAvailableAsync())throw new ZudeApiError(0,'SHARING_UNAVAILABLE','File sharing unavailable.');check();
 const directory=new Directory(Paths.cache,'zude-time-exports');directory.create({idempotent:true,intermediates:true});
 // Remove stale artifacts left by a terminated process, only in our cache.
 for(const old of directory.list())if(old instanceof File&&old.modificationTime!==null&&old.modificationTime<Date.now()-86400000)old.delete();
 const file=new File(directory,`${randomUUID()}-${filename}`);
 try{file.create();file.write(csv);check();await shareAsync(file.uri,{mimeType:'text/csv',UTI:'public.comma-separated-values-text',dialogTitle:'Export time report'});}
 finally{if(file.exists)file.delete();}
 // Once the OS share sheet receives the file, the authorized export cannot
 // be recalled. Keep it alive until that handoff finishes, then remove it.
}
