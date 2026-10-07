import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useBusiness } from '../business/BusinessContext';
import { useEmployeeIdentity } from '../identity/EmployeeIdentityContext';
// Presentation/lifecycle only. Existing operationalRequest and API authority
// remain the security boundary. Changing this key unmounts all sensitive state.
export function useManagementScope(){
 const {business,userId}=useBusiness();const {managementRole,sharedMode,identity}=useEmployeeIdentity();
 const generation=useRef(0);const [focus,setFocus]=useState<number|null>(null);const [active,setActive]=useState(AppState.currentState==='active');
 useFocusEffect(useCallback(()=>{setFocus(++generation.current);return()=>setFocus(null);},[]));
 useEffect(()=>{const s=AppState.addEventListener('change',state=>{setActive(state==='active');});return()=>s.remove();},[]);
 const allowed=!!userId&&(managementRole==='manager'||managementRole==='owner')&&(!sharedMode||!!identity);
 const scope=allowed&&active&&focus!==null?`${userId}:${business.id}:${managementRole}:${sharedMode?`${identity!.employee.id}:${identity!.expiresAt}`:'account'}:${focus}`:null;
 return {scope,allowed,business,userId,managementRole};
}
