import { useLocalSearchParams } from "expo-router";
import { TimesheetsScreen } from "../features/timesheets/TimesheetsScreen";
import { timesheetContext } from "../navigation/reviewContext";
export default function TimesheetsRoute() {
  const params = useLocalSearchParams();
  const context = timesheetContext(params);
  return <TimesheetsScreen key={JSON.stringify(params)} initialContext={context.context} invalidContext={context.invalid} />;
}
