import { TodayScreen } from "../features/today/TodayScreen";
import { useWorkspace } from "../navigation/WorkspaceContext";
export default function TodayRoute() { return <TodayScreen {...useWorkspace()} />; }
