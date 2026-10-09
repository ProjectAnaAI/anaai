import { useState } from "react";
import { View, Text } from "react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import { Button, styles as ui } from "../../components/ui";
import { useEmployeeIdentity } from "../identity/EmployeeIdentityContext";
import { businessToday, dateValid } from "./reportPeriods";
// Date-only values use a neutral UTC calendar bridge, never a device-local instant.
export function ReportDateField({label,value,onChangeText,timezone,disabled=false}:{label:string;value:string;onChangeText:(value:string)=>void;timezone:string;disabled?:boolean}) {
 const {recordEmployeeActivity}=useEmployeeIdentity();
 const [open,setOpen]=useState(false),[draft,setDraft]=useState("");
 return <View><Text style={ui.meta}>{label} · {timezone}</Text><Button label={value||"Choose date"} secondary disabled={disabled} onPress={()=>{if(!recordEmployeeActivity())return;setDraft(dateValid(value)?value:businessToday(timezone));setOpen(true);}}/>
 {open&&<View><DateTimePicker value={new Date(draft+"T12:00:00Z")} mode="date" display="spinner" timeZoneName="UTC" onValueChange={(_,date)=>{if(recordEmployeeActivity())setDraft(date.toISOString().slice(0,10));}}/>
 <Button label="Done" disabled={disabled} onPress={()=>{if(!recordEmployeeActivity())return;onChangeText(draft);setOpen(false);}}/><Button label="Cancel" secondary onPress={()=>setOpen(false)}/></View>}
 {value&&<Button label={`Clear ${label}`} secondary disabled={disabled} onPress={()=>onChangeText("")}/>}</View>;
}
