import { useLocalSearchParams } from "expo-router";
import { TimeIssuesScreen } from "../features/management/TimeIssuesScreen";
import { issueContext } from "../navigation/reviewContext";
export default function IssuesRoute() {
  const params = useLocalSearchParams();
  const context = issueContext(params);
  return <TimeIssuesScreen key={JSON.stringify(params)} initialIssueId={context.id} invalidContext={context.invalid} />;
}
