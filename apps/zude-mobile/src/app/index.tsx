import { useEmployeeIdentity } from "../features/identity/EmployeeIdentityContext";
import { ManagerTodayScreen } from "../features/management/ManagerTodayScreen";
import { TodayScreen } from "../features/today/TodayScreen";
export default function TodayEntry() {
  const { managementRole } = useEmployeeIdentity();
  return managementRole === "manager" || managementRole === "owner" ? <ManagerTodayScreen /> : <TodayScreen />;
}
