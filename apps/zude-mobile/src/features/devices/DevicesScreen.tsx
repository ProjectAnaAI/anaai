import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { Badge, Button, IconButton, styles as ui } from "../../components/ui";
import { DetailLine, Feedback, MasterDetail, PaneTitle, WorkspaceHeader, workspaceStyles as ws } from "../../components/workspace";
import { RecordRow, recordStyles as rs } from "../../components/records";
import { getRegisteredDevices, revokeRegisteredDevice } from "../../lib/devices-api";
import { useWorkspace } from "../../navigation/WorkspaceContext";
import { theme as t } from "../../theme/tokens";
import { useBusiness } from "../business/BusinessContext";
import { useEmployeeIdentity } from "../identity/EmployeeIdentityContext";
import { Notice } from "../appointments/controls";
import { useResource } from "../appointments/useResource";
import { deviceMessage, deviceTime, sortDevices } from "./state";

// Server registrations for this business. Revoking here never touches this
// app's own stored credential: a revoked iPad learns DEVICE_REVOKED on its next
// device-authenticated request and runs its own secure recovery.
export function RegisteredDevicesScreen() {
  const { business, userId } = useBusiness();
  const { managementRole } = useEmployeeIdentity();
  const { setNavigationLocked } = useWorkspace();
  const allowed = managementRole === "owner" || managementRole === "manager";
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ message: string; error?: boolean } | null>(null);
  const submitting = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setNavigationLocked(busy); return () => setNavigationLocked(false); }, [busy, setNavigationLocked]);
  const directory = useResource(allowed ? `${userId}:${business.id}:devices` : null, (signal) => getRegisteredDevices(business.id, signal));
  const devices = directory.data ? sortDevices(directory.data) : undefined;
  const selected = devices?.find((device) => device.id === selectedId);
  const activeCount = devices?.filter((device) => !device.revokedAt).length ?? 0;

  function select(id: string) {
    if (busy) return;
    setSelectedId(id); setPrompt(false); setNotice(null);
  }
  async function revoke() {
    if (!selected || selected.revokedAt || submitting.current) return;
    submitting.current = true; setBusy(true); setNotice(null);
    try {
      await revokeRegisteredDevice(business.id, userId, selected.id);
      if (!alive.current) return;
      setPrompt(false); setNotice({ message: `${selected.name} was revoked. It must be registered again before it can be used.` }); directory.refresh();
    } catch (error) {
      if (alive.current) setNotice({ message: deviceMessage(error), error: true });
    } finally {
      submitting.current = false;
      if (alive.current) setBusy(false);
    }
  }

  if (!allowed) return <View style={ws.page}>
    <WorkspaceHeader operational title="Registered Devices" business={business.name} />
    <Feedback title="Registered Devices is for owners and managers" detail="Ask a business owner or manager to review or revoke devices." />
  </View>;

  const master = <>
    <PaneTitle title="Devices" detail={devices ? `${activeCount} active · ${devices.length - activeCount} revoked` : undefined}
      action={<IconButton label="Refresh Registered Devices" icon="refresh-cw" disabled={busy} onPress={directory.refresh} />} />
    {directory.loading && <Feedback kind="loading" title="Loading devices" />}
    {directory.error && <Feedback kind="error" title="Registered devices unavailable" detail={directory.error} retry={directory.refresh} />}
    {devices && <>
      {devices.map((device) => <RecordRow key={device.id} selected={device.id === selectedId} disabled={busy}
        label={`${device.name}, ${device.revokedAt ? "revoked" : "active"}. Open device`} onPress={() => select(device.id)}
        trailing={<Badge compact label={device.revokedAt ? "Revoked" : "Active"} tone={device.revokedAt ? "neutral" : "success"} />}>
        <Text numberOfLines={1} style={[rs.name, !!device.revokedAt && rs.inactiveName]}>{device.name}</Text>
        <Text style={ui.meta}>Registered {deviceTime(device.registeredAt, business.timezone)}</Text>
      </RecordRow>)}
      {!devices.length && <Feedback title="No registered devices yet" detail="Register a shared iPad from Device & PIN on that iPad." />}
    </>}
  </>;

  const detail = !selected ? <View style={rs.block}>
    <PaneTitle title="Device details" />
    {!!notice && <Notice message={notice.message} error={notice.error} success={!notice.error} />}
    <Text style={ui.strong}>Select a device</Text>
    <Text style={ui.body}>Review when a device was registered and last used, or revoke a device that should no longer unlock with employee PINs.</Text>
  </View> : <View>
    <View style={[rs.block, { paddingTop: t.space.xl }]}>
      <Badge label={selected.revokedAt ? "Revoked" : "Active"} tone={selected.revokedAt ? "neutral" : "success"} />
      <Text accessibilityRole="header" style={rs.title}>{selected.name}</Text>
      {!!notice && <Notice message={notice.message} error={notice.error} success={!notice.error} />}
    </View>
    <View style={rs.block}>
      <DetailLine icon="calendar" label="Registered" value={deviceTime(selected.registeredAt, business.timezone)} />
      <DetailLine icon="clock" label="Last used" value={deviceTime(selected.lastSeenAt, business.timezone)} />
      {!!selected.revokedAt && <DetailLine icon="slash" label="Revoked" value={deviceTime(selected.revokedAt, business.timezone)} />}
    </View>
    <View style={[rs.block, { borderBottomWidth: 0 }]}>
      {selected.revokedAt ? <Text style={ui.meta}>This device is revoked and kept for history. It cannot unlock with employee PINs until it is registered again as a new device.</Text>
        : prompt ? <>
          <Notice message={`Revoke ${selected.name}? It will no longer unlock with employee PINs, anyone using it is signed out, and it must be registered again before it can be used.`} />
          <View style={rs.actions}>
            <Button label="Yes, Revoke Device" destructive busy={busy} disabled={busy} onPress={() => void revoke()} />
            <Button label="Keep Device" secondary disabled={busy} onPress={() => setPrompt(false)} />
          </View>
        </> : <Button label="Revoke Device" icon="slash" secondary destructive disabled={busy} onPress={() => { setNotice(null); setPrompt(true); }} />}
    </View>
  </View>;

  return <View style={ws.page}>
    <WorkspaceHeader operational title="Registered Devices" business={business.name} subtitle={devices ? `${activeCount} active` : "Shared devices"} />
    <MasterDetail master={master} detail={detail} showDetail={!!selected} fixed={{ side: "master", width: 340 }}
      backLabel="All devices" onBack={() => { if (!busy) { setSelectedId(null); setPrompt(false); } }} />
  </View>;
}
