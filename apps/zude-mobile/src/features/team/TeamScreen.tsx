import { useEffect, useRef, useState } from "react";
import { Text, View, useWindowDimensions } from "react-native";
import { Badge, Button, IconButton, styles as ui } from "../../components/ui";
import { Feedback, MasterDetail, PaneTitle, WorkspaceHeader, workspaceStyles as ws } from "../../components/workspace";
import { LabeledField, ReadOnlyValue, RecordRow, recordStyles as rs } from "../../components/records";
import { createEmployee, deactivateEmployee, getTeam, reactivateEmployee, resetEmployeePin, updateEmployee, type EmployeeRole, type TeamEmployee, type TeamStatus } from "../../lib/team-api";
import { useWorkspace } from "../../navigation/WorkspaceContext";
import { theme as t } from "../../theme/tokens";
import { workspaceLayout } from "../../theme/layout";
import { useBusiness } from "../business/BusinessContext";
import { useEmployeeIdentity } from "../identity/EmployeeIdentityContext";
import { Notice } from "../appointments/controls";
import { useResource } from "../appointments/useResource";
import { assignableRoles, canManageEmployee, canManageTeam, employeeChanges, pinProblem, roleLabel, teamMessage, validName } from "./state";

type Mode = "view" | "create" | "edit" | "pin" | "reactivate";
const signOutNote = "Saving signs this employee out of any ZUDE device where they are unlocked.";
// PIN fields: never autofilled, never shown, never kept after a submit.
const pinInput = { keyboardType: "number-pad", secureTextEntry: true, maxLength: 6, autoCorrect: false, autoComplete: "off", importantForAutofill: "no", textContentType: "none", contextMenuHidden: true } as const;

export function TeamScreen() {
  const { business, userId } = useBusiness();
  const { setNavigationLocked } = useWorkspace();
  const { width, height, fontScale } = useWindowDimensions();
  const { compact } = workspaceLayout(width, height, fontScale);
  // Effective authority: the account role, narrowed on a shared device to the
  // PIN-verified employee. The server enforces the same rule.
  const { managementRole } = useEmployeeIdentity();
  const allowed = canManageTeam(managementRole);
  const roles = assignableRoles(managementRole);
  const [status, setStatus] = useState<TeamStatus>("active");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("view");
  const [deactivatePrompt, setDeactivatePrompt] = useState(false);
  const [name, setName] = useState("");
  const [role, setRole] = useState<EmployeeRole>("employee");
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState<{ message: string; error?: boolean } | null>(null);
  const submitting = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setNavigationLocked(busy); return () => setNavigationLocked(false); }, [busy, setNavigationLocked]);
  // Staff accounts never request the directory; the server would refuse anyway.
  const team = useResource(allowed ? `${userId}:${business.id}:team:${status}` : null, (signal) => getTeam(business.id, status, signal));
  const employees = team.data;
  const selected = employees?.find((employee) => employee.id === selectedId);
  const manageable = !!selected && canManageEmployee(managementRole, selected.role);

  function clearPins() { setPin(""); setConfirm(""); }
  function open(next: Mode, employee?: TeamEmployee) {
    if (busy) return;
    clearPins(); setFormError(""); setNotice(null); setDeactivatePrompt(false);
    setName(next === "edit" && employee ? employee.display_name : next === "create" ? "" : name);
    setRole(next === "edit" && employee ? employee.role : "employee");
    setMode(next);
  }
  function select(id: string) {
    if (busy) return;
    setSelectedId(id); setMode("view"); clearPins(); setFormError(""); setNotice(null); setDeactivatePrompt(false);
  }
  // One submit at a time; Team writes have no idempotency contract, so a
  // failure is reported and never retried automatically.
  async function run(work: () => Promise<TeamEmployee>, message: string, after: (employee: TeamEmployee) => void) {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setFormError(""); setNotice(null);
    try {
      const employee = await work();
      if (!alive.current) return;
      after(employee); setMode("view"); setDeactivatePrompt(false); setNotice({ message }); team.refresh();
    } catch (error) {
      if (alive.current) { if (mode === "view") setNotice({ message: teamMessage(error), error: true }); else setFormError(teamMessage(error)); }
    } finally {
      submitting.current = false;
      if (alive.current) setBusy(false);
    }
  }
  // PIN digits leave component state before the request is sent, whatever the outcome.
  function takePins() { const entered = { pin, confirm }; clearPins(); return entered; }
  function create() {
    const entered = takePins();
    if (!validName(name)) { setFormError("Enter a display name (up to 100 characters)."); return; }
    const problem = pinProblem(entered.pin, entered.confirm);
    if (problem) { setFormError(problem); return; }
    const chosen = roles.includes(role) ? role : "employee";
    void run(() => createEmployee(business.id, userId, { name, role: chosen, pin: entered.pin }), "Employee added.", (employee) => setSelectedId(employee.id));
  }
  function saveEdit() {
    if (!selected) return;
    if (!validName(name)) { setFormError("Enter a display name (up to 100 characters)."); return; }
    const changes = employeeChanges(selected, { name, role });
    if (!changes.name && !changes.role) { setMode("view"); return; }
    void run(() => updateEmployee(business.id, userId, selected.id, changes), "Employee updated.", () => {});
  }
  function resetPin() {
    if (!selected) return;
    const entered = takePins();
    const problem = pinProblem(entered.pin, entered.confirm);
    if (problem) { setFormError(problem); return; }
    void run(() => resetEmployeePin(business.id, userId, selected.id, entered.pin), "PIN reset.", () => {});
  }
  // Reactivation always sets a fresh PIN through the existing Team contract;
  // the old PIN is never restored.
  function reactivate() {
    if (!selected) return;
    const entered = takePins();
    const problem = pinProblem(entered.pin, entered.confirm);
    if (problem) { setFormError(problem); return; }
    void run(() => reactivateEmployee(business.id, userId, selected.id, entered.pin), `${selected.display_name} was reactivated.`, (employee) => { setStatus("active"); setSelectedId(employee.id); });
  }
  function changeStatus(next: TeamStatus) {
    if (busy || next === status) return;
    setStatus(next); setSelectedId(null); setMode("view"); clearPins(); setFormError(""); setNotice(null); setDeactivatePrompt(false);
  }
  function deactivate() {
    if (!selected) return;
    void run(() => deactivateEmployee(business.id, userId, selected.id), `${selected.display_name} was deactivated.`, () => setSelectedId(null));
  }

  function roleControl(current?: TeamEmployee) {
    // Owner-role employees keep their role here; that decision is unresolved.
    if (current?.role === "owner" || roles.length < 2) {
      return <ReadOnlyValue label="Role" value={roleLabel(current?.role ?? "employee")}
        hint={managementRole === "manager" ? "Managers can add and manage employees only." : undefined} />;
    }
    return <View style={{ gap: t.space.xs }}>
      <Text style={ui.strong}>Role</Text>
      <View style={rs.actions}>{roles.map((option) => <Button key={option} label={roleLabel(option)} secondary selected={role === option}
        disabled={busy} onPress={() => setRole(option)} />)}</View>
    </View>;
  }
  function pinFields() {
    return <>
      <LabeledField label="PIN" value={pin} onChangeText={(value) => setPin(value.replace(/\D/g, ""))} editable={!busy} placeholder="4–6 digits" {...pinInput} />
      <LabeledField label="Confirm PIN" value={confirm} onChangeText={(value) => setConfirm(value.replace(/\D/g, ""))} editable={!busy} {...pinInput}
        hint="Each active employee needs a different PIN." />
    </>;
  }
  function cancelForm() { clearPins(); setFormError(""); setMode("view"); }

  let detail;
  if (mode === "create") {
    detail = <View style={rs.form}>
      <PaneTitle title="Add employee" detail="Employees unlock shared ZUDE devices with their PIN." />
      <LabeledField label="Display name" value={name} onChangeText={setName} editable={!busy} maxLength={100} autoCapitalize="words" autoFocus />
      {roleControl()}
      {pinFields()}
      {!!formError && <Notice message={formError} error />}
      <View style={rs.actions}>
        <Button label={busy ? "Saving…" : "Create Employee"} icon="check" busy={busy} disabled={busy || (!name.trim() || !pin || !confirm)} onPress={create} />
        <Button label="Cancel" secondary disabled={busy} onPress={cancelForm} />
      </View>
    </View>;
  } else if (mode === "edit" && selected && manageable) {
    detail = <View style={rs.form}>
      <PaneTitle title="Edit employee" detail={selected.display_name} />
      <LabeledField label="Display name" value={name} onChangeText={setName} editable={!busy} maxLength={100} autoCapitalize="words" />
      {roleControl(selected)}
      <Text style={ui.meta}>{signOutNote}</Text>
      {!!formError && <Notice message={formError} error />}
      <View style={rs.actions}>
        <Button label={busy ? "Saving…" : "Save Changes"} icon="check" busy={busy} disabled={busy || (!name.trim())} onPress={saveEdit} />
        <Button label="Cancel" secondary disabled={busy} onPress={cancelForm} />
      </View>
    </View>;
  } else if (mode === "pin" && selected && manageable) {
    detail = <View style={rs.form}>
      <PaneTitle title="Reset PIN" detail={selected.display_name} />
      {pinFields()}
      <Text style={ui.meta}>{signOutNote}</Text>
      {!!formError && <Notice message={formError} error />}
      <View style={rs.actions}>
        <Button label={busy ? "Saving…" : "Reset PIN"} icon="check" busy={busy} disabled={busy || (!pin || !confirm)} onPress={resetPin} />
        <Button label="Cancel" secondary disabled={busy} onPress={cancelForm} />
      </View>
    </View>;
  } else if (mode === "reactivate" && selected && manageable && !selected.is_active) {
    detail = <View style={rs.form}>
      <PaneTitle title="Reactivate employee" detail={selected.display_name} />
      <Text style={ui.body}>Reactivation needs a new PIN. The previous PIN is not restored.</Text>
      {pinFields()}
      {!!formError && <Notice message={formError} error />}
      <View style={rs.actions}>
        <Button label={busy ? "Saving…" : "Reactivate Employee"} icon="check" busy={busy} disabled={busy || (!pin || !confirm)} onPress={reactivate} />
        <Button label="Cancel" secondary disabled={busy} onPress={cancelForm} />
      </View>
    </View>;
  } else if (selected && !selected.is_active) {
    detail = <View>
      <View style={[rs.block, { paddingTop: t.space.xl }]}>
        <Badge label="Inactive" tone="neutral" />
        <Text accessibilityRole="header" style={rs.title}>{selected.display_name}</Text>
        <Text style={ui.body}>{roleLabel(selected.role)}</Text>
        {!!notice && <Notice message={notice.message} error={notice.error} success={!notice.error} />}
        <Text style={ui.meta}>Inactive employees cannot unlock ZUDE devices. Their record is kept.</Text>
      </View>
      {manageable ? <View style={[rs.block, { borderBottomWidth: 0 }]}>
        <Button label="Reactivate" icon="user-check" secondary disabled={busy} onPress={() => open("reactivate", selected)} />
      </View> : <View style={[rs.block, { borderBottomWidth: 0 }]}><Text style={ui.meta}>Only a business owner can manage managers and owners.</Text></View>}
    </View>;
  } else if (selected) {
    detail = <View>
      <View style={[rs.block, { paddingTop: t.space.xl }]}>
        <Badge label="Active" tone="success" />
        <Text accessibilityRole="header" style={rs.title}>{selected.display_name}</Text>
        <Text style={ui.body}>{roleLabel(selected.role)}</Text>
        {!!notice && <Notice message={notice.message} error={notice.error} success={!notice.error} />}
      </View>
      {manageable ? <View style={[rs.block, { borderBottomWidth: 0 }]}>
        <View style={rs.actions}>
          <Button label="Edit" icon="edit-2" secondary disabled={busy} onPress={() => open("edit", selected)} />
          <Button label="Reset PIN" icon="key" secondary disabled={busy} onPress={() => open("pin", selected)} />
        </View>
        {deactivatePrompt ? <>
          <Notice message={`Deactivate ${selected.display_name}? They can no longer unlock ZUDE devices with their PIN, and any active employee session ends. Their record is kept.`} />
          <View style={rs.actions}>
            <Button label="Yes, Deactivate" destructive busy={busy} disabled={busy} onPress={deactivate} />
            <Button label="Keep Active" secondary disabled={busy} onPress={() => setDeactivatePrompt(false)} />
          </View>
        </> : <Button label="Deactivate" icon="user-x" secondary destructive disabled={busy} onPress={() => { setNotice(null); setDeactivatePrompt(true); }} />}
      </View> : <View style={[rs.block, { borderBottomWidth: 0 }]}><Text style={ui.meta}>Only a business owner can manage managers and owners.</Text></View>}
    </View>;
  } else {
    detail = <View style={rs.block}>
      <PaneTitle title="Employee details" />
      {!!notice && <Notice message={notice.message} error={notice.error} success={!notice.error} />}
      <Text style={ui.strong}>Select an employee</Text>
      <Text style={ui.body}>Review an employee’s role, edit their details, reset their PIN, or add a new employee.</Text>
    </View>;
  }

  const master = <>
    <PaneTitle title={status === "active" ? "Active team" : "Inactive employees"} detail={employees ? `${employees.length} ${status}` : undefined}
      action={<IconButton label="Refresh Team" icon="refresh-cw" disabled={busy} onPress={team.refresh} />} />
    <View style={rs.filters}>
      <Button label="Active" secondary selected={status === "active"} disabled={busy} onPress={() => changeStatus("active")} />
      <Button label="Inactive" secondary selected={status === "inactive"} disabled={busy} onPress={() => changeStatus("inactive")} />
    </View>
    {team.loading && <Feedback kind="loading" title="Loading Team" />}
    {team.error && <Feedback kind="error" title="Team unavailable" detail={team.error} retry={team.refresh} />}
    {employees && <>
      {employees.map((employee) => <RecordRow key={employee.id} selected={employee.id === selectedId && mode !== "create"} disabled={busy}
        label={`${employee.display_name}, ${roleLabel(employee.role)}, ${employee.is_active ? "active" : "inactive"}. Open employee`} onPress={() => select(employee.id)}
        trailing={<Badge compact label={employee.is_active ? "Active" : "Inactive"} tone={employee.is_active ? "success" : "neutral"} />}>
        <Text numberOfLines={1} style={rs.name}>{employee.display_name}</Text>
        <Text style={ui.meta}>{roleLabel(employee.role)}</Text>
      </RecordRow>)}
      {!employees.length && (status === "active"
        ? <Feedback title="No active employees yet" detail="Add employees so they can unlock shared ZUDE devices with their own PIN." />
        : <Feedback title="No inactive employees" detail="Deactivated employees appear here and can be reactivated with a new PIN." />)}
    </>}
  </>;

  if (!allowed) return <View style={ws.page}>
    <WorkspaceHeader operational title="Team" business={business.name} />
    <Feedback title="Team is for owners and managers" detail="Ask a business owner or manager to add or change employees." />
  </View>;
  return <View style={ws.page}>
    <WorkspaceHeader operational title="Team" business={business.name} subtitle={employees ? `${employees.length} ${status}` : "Employees"}
      action={<Button brand label={compact ? "Add" : "Add Employee"} icon="user-plus" disabled={busy} onPress={() => open("create")} />} />
    <MasterDetail master={master} detail={detail} showDetail={mode !== "view" || !!selected}
      fixed={{ side: "master", width: 340 }} backLabel="All employees" onBack={() => {
        if (busy) return;
        clearPins(); setFormError("");
        if (mode !== "view") setMode("view"); else setSelectedId(null);
      }} />
  </View>;
}
