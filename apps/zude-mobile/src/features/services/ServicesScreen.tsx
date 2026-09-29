import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Badge, Button, IconButton, styles as ui } from "../../components/ui";
import { DetailLine, Feedback, MasterDetail, PaneTitle, WorkspaceHeader, workspaceStyles as ws } from "../../components/workspace";
import { LabeledField, ReadOnlyValue, RecordRow, recordStyles as rs } from "../../components/records";
import { createService, getServiceCatalog, setServiceActive, updateService, type CatalogService, type ServiceFields } from "../../lib/services-api";
import { useWorkspace } from "../../navigation/WorkspaceContext";
import { theme as t } from "../../theme/tokens";
import { workspaceLayout } from "../../theme/layout";
import { useBusiness } from "../business/BusinessContext";
import { Notice } from "../appointments/controls";
import { useResource } from "../appointments/useResource";
import { durationLockedExplanation, emptyServiceFields, serviceDuration, serviceFields, serviceMessage, servicePrice } from "./state";

type Mode = "view" | "create" | "edit";

export function ServicesScreen() {
  const { business, userId } = useBusiness();
  const { setNavigationLocked } = useWorkspace();
  const { width, height, fontScale } = useWindowDimensions();
  const { compact } = workspaceLayout(width, height, fontScale);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("view");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState<{ message: string; error?: boolean } | null>(null);
  const submitting = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setNavigationLocked(busy); return () => setNavigationLocked(false); }, [busy, setNavigationLocked]);
  const catalog = useResource(`${userId}:${business.id}:services`, (signal) => getServiceCatalog(business.id, signal));
  const services = catalog.data?.services;
  const canManage = catalog.data?.canManage === true;
  const selected = services?.find((service) => service.id === selectedId);
  const activeCount = services?.filter((service) => service.is_active).length ?? 0;

  function select(id: string) {
    if (busy) return;
    setSelectedId(id); setMode("view"); setNotice(null); setFormError("");
  }
  // One submit at a time and no automatic retry (no idempotency contract).
  async function run(work: () => Promise<CatalogService>, message: string, onError: (message: string) => void) {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setFormError(""); setNotice(null);
    try {
      const service = await work();
      if (!alive.current) return;
      setSelectedId(service.id); setMode("view"); setNotice({ message }); catalog.refresh();
    } catch (error) {
      if (alive.current) onError(serviceMessage(error));
    } finally {
      submitting.current = false;
      if (alive.current) setBusy(false);
    }
  }
  function save(fields: ServiceFields) {
    const editing = mode === "edit" && selected;
    void run(() => editing ? updateService(business.id, userId, selected.id, fields) : createService(business.id, userId, fields),
      editing ? "Service updated." : "Service created.", setFormError);
  }
  function toggle(service: CatalogService) {
    const next = !service.is_active;
    void run(() => setServiceActive(business.id, userId, service.id, next), next ? "Service activated." : "Service deactivated.",
      (message) => setNotice({ message, error: true }));
  }

  const master = <>
    <PaneTitle title="Service catalog" detail={services ? `${activeCount} active · ${services.length - activeCount} inactive` : undefined}
      action={<IconButton label="Refresh services" icon="refresh-cw" disabled={busy} onPress={catalog.refresh} />} />
    {catalog.loading && <Feedback kind="loading" title="Loading services" />}
    {catalog.error && <Feedback kind="error" title="Services unavailable" detail={catalog.error} retry={catalog.refresh} />}
    {services && <>
      {!!services.length && !compact && <View style={s.tableHead} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Text style={[s.headText, ui.grow]}>Service</Text>
        <Text style={[s.headText, s.duration]}>Duration</Text>
        <Text style={[s.headText, s.price]}>Price</Text>
        <Text style={[s.headText, s.state]}>Status</Text>
        <View style={{ width: 16 }} />
      </View>}
      {services.map((service) => <RecordRow key={service.id} selected={service.id === selectedId && mode !== "create"} disabled={busy}
        label={`${service.name}, ${serviceDuration(service.duration_minutes)}, ${servicePrice(service.price)}, ${service.is_active ? "active" : "inactive"}. Open service`}
        onPress={() => select(service.id)}
        trailing={compact ? undefined : <>
          <Text style={[ui.body, s.duration]}>{serviceDuration(service.duration_minutes)}</Text>
          <Text style={[ui.body, s.price]}>{servicePrice(service.price)}</Text>
          <View style={s.state}><Badge compact label={service.is_active ? "Active" : "Inactive"} tone={service.is_active ? "success" : "neutral"} /></View>
        </>}>
        <Text numberOfLines={1} style={[rs.name, !service.is_active && rs.inactiveName]}>{service.name}</Text>
        {compact ? <Text style={ui.meta}>{serviceDuration(service.duration_minutes)} · {servicePrice(service.price)}{service.is_active ? "" : " · Inactive"}</Text>
          : !!service.description && <Text numberOfLines={1} style={ui.meta}>{service.description}</Text>}
      </RecordRow>)}
      {!services.length && <Feedback title="No services yet" detail={canManage
        ? "Create your first service so appointments can be scheduled with the correct duration."
        : "An owner or manager can add services for this business."} />}
    </>}
  </>;

  const detail = mode !== "view"
    ? <ServiceForm key={mode === "edit" ? selectedId : "new"} service={mode === "edit" ? selected : undefined} busy={busy} error={formError}
        onCancel={() => { if (!busy) { setMode("view"); setFormError(""); } }} onSave={save} />
    : !selected ? <View style={rs.block}>
        <PaneTitle title="Service details" />
        <Text style={ui.strong}>Select a service</Text>
        <Text style={ui.body}>{canManage ? "Review a service’s duration and price, edit it, or create a new service." : "Review a service’s duration and price."}</Text>
      </View>
      : <View>
        <View style={[rs.block, { paddingTop: t.space.xl }]}>
          <Badge label={selected.is_active ? "Active" : "Inactive"} tone={selected.is_active ? "success" : "neutral"} />
          <Text accessibilityRole="header" style={rs.title}>{selected.name}</Text>
          {!!notice && <Notice message={notice.message} error={notice.error} success={!notice.error} />}
          <Text style={ui.meta}>{selected.is_active ? "Active services can be selected for new appointments." : "Inactive services can’t be selected for new appointments. Existing appointments are unchanged."}</Text>
        </View>
        <View style={rs.block}>
          <DetailLine icon="clock" label="Duration" value={serviceDuration(selected.duration_minutes)} />
          <DetailLine icon="tag" label="Price" value={servicePrice(selected.price)} />
          <View><Text style={ui.meta}>Description</Text><Text style={selected.description ? ui.body : ui.meta}>{selected.description || "No description."}</Text></View>
        </View>
        {canManage ? <View style={[rs.block, rs.actions, { borderBottomWidth: 0 }]}>
          <Button label="Edit" icon="edit-2" secondary disabled={busy} onPress={() => { setMode("edit"); setNotice(null); setFormError(""); }} />
          <Button label={selected.is_active ? "Deactivate" : "Activate"} icon={selected.is_active ? "pause-circle" : "play-circle"} secondary
            busy={busy} disabled={busy} onPress={() => toggle(selected)} />
        </View> : <View style={[rs.block, { borderBottomWidth: 0 }]}><Text style={ui.meta}>Only owners and managers can change services.</Text></View>}
      </View>;

  return <View style={ws.page}>
    <WorkspaceHeader operational title="Services" business={business.name}
      subtitle={services ? `${activeCount} active` : "Service catalog"}
      action={canManage ? <Button brand label={compact ? "New" : "New Service"} icon="plus-circle" disabled={busy}
        onPress={() => { setMode("create"); setNotice(null); setFormError(""); }} /> : undefined} />
    <MasterDetail master={master} detail={detail} showDetail={mode !== "view" || !!selected}
      fixed={{ side: "detail", width: 360 }} backLabel="All services" onBack={() => {
        if (busy) return;
        if (mode === "edit") { setMode("view"); setFormError(""); } else { setMode("view"); setSelectedId(null); setNotice(null); }
      }} />
  </View>;
}

function ServiceForm({ service, busy, error, onCancel, onSave }: {
  service?: CatalogService; busy: boolean; error: string; onCancel: () => void; onSave: (fields: ServiceFields) => void;
}) {
  const [fields, setFields] = useState<ServiceFields>(() => service ? serviceFields(service) : emptyServiceFields);
  const set = (key: "name" | "duration" | "price" | "description") => (value: string) => setFields((previous) => ({ ...previous, [key]: value }));
  return <View style={rs.form}>
    <PaneTitle title={service ? "Edit service" : "New service"} detail={service ? service.name : "Add a service customers can book."} />
    <LabeledField label="Name" value={fields.name} onChangeText={set("name")} editable={!busy} maxLength={200} autoFocus={!service} returnKeyType="next" />
    {service ? <ReadOnlyValue label="Duration" value={serviceDuration(service.duration_minutes)} hint={durationLockedExplanation} />
      : <LabeledField label="Duration (minutes)" value={fields.duration} onChangeText={set("duration")} editable={!busy} keyboardType="number-pad"
          maxLength={4} placeholder="e.g. 45" hint="Used to schedule appointments. It can’t be changed after the service is created." />}
    <LabeledField label="Price" optional value={fields.price} onChangeText={set("price")} editable={!busy} keyboardType="decimal-pad" placeholder="0.00" />
    <LabeledField label="Description" optional value={fields.description} onChangeText={set("description")} editable={!busy} maxLength={2000}
      multiline textAlignVertical="top" style={{ minHeight: 88, alignItems: "stretch" }} />
    <View style={rs.actions}>
      <Button label="Active" secondary selected={fields.active} disabled={busy} onPress={() => setFields((previous) => ({ ...previous, active: true }))} />
      <Button label="Inactive" secondary selected={!fields.active} disabled={busy} onPress={() => setFields((previous) => ({ ...previous, active: false }))} />
    </View>
    <Text style={ui.meta}>Active services can be selected for new appointments.</Text>
    {!!error && <Notice message={error} error />}
    <View style={rs.actions}>
      <Button label={busy ? "Saving…" : service ? "Save Changes" : "Create Service"} icon="check" busy={busy}
        disabled={busy || !fields.name.trim() || (!service && !fields.duration.trim())} onPress={() => onSave(fields)} />
      <Button label="Cancel" secondary disabled={busy} onPress={onCancel} />
    </View>
  </View>;
}

const s = StyleSheet.create({
  tableHead: { flexDirection: "row", alignItems: "center", gap: t.space.md, paddingHorizontal: t.space.md, paddingVertical: t.space.sm,
    borderBottomWidth: t.border, borderColor: t.colors.border },
  headText: { color: t.colors.muted, fontSize: 11, fontWeight: "700", letterSpacing: 1.1, textTransform: "uppercase" },
  duration: { width: 84 },
  price: { width: 80, textAlign: "right", fontVariant: ["tabular-nums"] },
  state: { width: 84, alignItems: "flex-start" },
});
