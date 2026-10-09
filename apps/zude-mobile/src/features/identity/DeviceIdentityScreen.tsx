import type { ReactNode } from "react";
import { Platform, ScrollView, Text, View } from "react-native";
import { Button, styles as ui } from "../../components/ui";
import { Field, WorkspaceHeader, workspaceStyles as ws } from "../../components/workspace";
import { theme as t } from "../../theme/tokens";
import { useEmployeeIdentity } from "./EmployeeIdentityContext";
import { AuthorityDiagnostic } from "./AuthorityDiagnostic";

// The workspace gate.
// - Not a shared device: the signed-in account's workspace (setup, personal use).
// - Shared device: the workspace only with a PIN-verified employee of this
//   business. Losing the device credential never re-opens the account
//   workspace; secure-storage failure fails closed.
export function EmployeeIdentityGate({ children }: { children: ReactNode }) {
  const { vault, device, identity, business, message, sharedMode } = useEmployeeIdentity();
  if (vault === "opening") return <View style={ws.page}><Text style={ui.body}>{message || "Opening secure device storage…"}</Text></View>;
  if (vault === "unavailable") return <DeviceIdentityScreen />;
  if (!sharedMode) return children;
  if (device && device.businessId === business.id && identity) return children;
  return <DeviceIdentityScreen />;
}

type Identity = ReturnType<typeof useEmployeeIdentity>;
// Local-only recovery, separate from server revocation (Registered Devices).
function forgetControls({ canAdministerDevice, forgetPrompt, setForgetPrompt, forgetting, busy, forget }: Identity) {
  if (!canAdministerDevice) return null;
  if (!forgetPrompt) return <Button label="Forget This Device" icon="trash-2" secondary destructive disabled={busy || forgetting} onPress={() => setForgetPrompt(true)} />;
  return <View style={{ gap: t.space.sm }}>
    <Text style={ui.body}>Forget this device on this iPad? Its saved registration is deleted from this app and any employee identity is cleared. This does not revoke the device on the server, and the iPad stays a shared device until it is registered again.</Text>
    <Button label="Yes, Forget This Device" destructive busy={forgetting} disabled={forgetting} onPress={() => void forget()} />
    <Button label="Keep Device Registration" secondary disabled={forgetting} onPress={() => setForgetPrompt(false)} />
  </View>;
}
// Signing out is how an owner or manager re-proves account authority on a
// shared device; it does not unregister the device.
function signOutControls({ signOutPrompt, setSignOutPrompt, signOut, busy, forgetting }: Identity) {
  if (!signOutPrompt) return <Button label="Sign Out of ZUDE" icon="log-out" secondary disabled={busy || forgetting} onPress={() => setSignOutPrompt(true)} />;
  return <View style={{ gap: t.space.sm }}>
    <Text style={ui.body}>Sign out of ZUDE on this iPad? An owner or manager will need to sign in again. The device stays registered.</Text>
    <Button label="Yes, Sign Out" destructive onPress={() => void signOut()} />
    <Button label="Stay Signed In" secondary onPress={() => setSignOutPrompt(false)} />
  </View>;
}
const authorityNote = <Text style={ui.meta}>To change this device’s registration, an owner or manager must sign out and sign in again on this iPad.</Text>;

export function DeviceIdentityScreen() {
  const context = useEmployeeIdentity();
  const { business, device, identity, pin, setPin, name, setName, message, vault, busy, forgetting, needsLock, sharedMode, accountAdmin, canRegister, canAdministerDevice, canLeaveSharedMode, retryVault, run, register, unlock, lock, leaveSharedMode } = context;
  const wrongBusiness = !!device && device.businessId !== business.id;
  return <View style={ws.page}>
    <WorkspaceHeader title="Device & PIN" business={business.name} />
    <ScrollView contentContainerStyle={{ padding: t.space.xl, alignItems: "center" }} keyboardShouldPersistTaps="handled">
      <View style={{ width: "100%", maxWidth: 400, gap: t.space.lg }}>
        {Platform.OS === "web" && <Text style={ui.meta}>Web preview keeps device registration only until this page is reloaded.</Text>}
        {!!message && <Text accessibilityLiveRegion="polite" style={ui.body}>{message}</Text>}
        {vault === "opening" ? <Text style={ui.body}>Opening secure device storage…</Text> : vault === "unavailable" ? <>
          <Text style={ui.strong}>Secure device storage is unavailable</Text>
          <Text style={ui.body}>ZUDE cannot confirm this device’s registration, so PIN access and the workspace stay locked.</Text>
          <Button label="Retry Secure Storage" disabled={forgetting} onPress={retryVault} />
          {forgetControls(context)}
          {signOutControls(context)}
        </> : wrongBusiness ? <>
          <Text style={ui.strong}>Registered to another ZUDE workspace</Text>
          <Text style={ui.body}>This iPad is registered to a different business. Open that business to use its PIN access{canAdministerDevice ? `, or forget the registration here to register this iPad for ${business.name}` : ""}.</Text>
          {forgetControls(context)}
          {!canAdministerDevice && accountAdmin && authorityNote}
          {signOutControls(context)}
        </> : !device ? <>
          <Text style={ui.strong}>{sharedMode ? "Register this shared ZUDE device" : "Register this ZUDE device"}</Text>
          {sharedMode
            ? <Text style={ui.body}>This iPad is a shared ZUDE device. It needs to be registered before employees can unlock it with their PIN.</Text>
            : <Text style={ui.body}>After registration, this iPad opens only with an employee PIN. Add employees in Team first — including a manager PIN for yourself.</Text>}
          {canRegister ? <>
            <Field label="Device name" placeholder="Device name" value={name} onChangeText={setName} maxLength={100} />
            <Button label="Register device" disabled={!name.trim() || busy} busy={busy} onPress={() => void run(register)} />
          </> : accountAdmin ? authorityNote : <Text style={ui.body}>A business owner or manager must register this device before PIN access is available.</Text>}
          {canLeaveSharedMode && <Button label="Stop Shared-Device Use" secondary disabled={busy} onPress={() => void leaveSharedMode()} />}
          {sharedMode && signOutControls(context)}
        </> : identity ? <>
          <Text style={ui.strong}>{identity.employee.name}</Text><Text style={ui.meta}>{identity.employee.role}</Text>
          <Text style={ui.body}>Employee identity is active. PIN access does not clock you in.</Text>
          <Button label="Lock" onPress={() => void lock()} />
          {forgetControls(context)}
        </> : <>
          <Text style={ui.strong}>Enter your PIN</Text>
          <Text accessibilityLabel={`${pin.length} PIN digits entered`} style={{ ...ui.strong, textAlign: "center", fontSize: 28, minHeight: 40 }}>{"●".repeat(pin.length) || "—"}</Text>
          {[['1','2','3'],['4','5','6'],['7','8','9'],['Clear','0','Delete']].map((row,index) => <View key={index} style={ui.row}>{row.map(key => <View key={key} style={ui.grow}><Button secondary label={key} disabled={busy || needsLock || forgetting} onPress={() => setPin(value => key === 'Clear' ? '' : key === 'Delete' ? value.slice(0,-1) : (value+key).slice(0,6))} /></View>)}</View>)}
          <Button label="Unlock" disabled={pin.length < 4 || busy || needsLock || forgetting} busy={busy} onPress={() => void run(unlock)} />
          {needsLock && <Button label="Retry Lock" secondary onPress={() => void lock()} />}
          {forgetControls(context)}
          {signOutControls(context)}
        </>}
        {__DEV__ && <AuthorityDiagnostic />}
      </View>
    </ScrollView>
  </View>;
}
