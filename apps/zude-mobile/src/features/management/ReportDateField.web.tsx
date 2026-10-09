import { LabeledField } from "../../components/records";
export function ReportDateField({label,value,onChangeText,disabled=false}:{label:string;value:string;onChangeText:(value:string)=>void;timezone:string;disabled?:boolean}) {return <LabeledField label={label} value={value} onChangeText={onChangeText} editable={!disabled} placeholder="YYYY-MM-DD" maxLength={10}/>;}
