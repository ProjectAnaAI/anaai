import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Text, View, useWindowDimensions } from "react-native";
import { Button, IconButton, styles as ui } from "../../components/ui";
import { Feedback, Field, MasterDetail, PaneTitle, WorkspaceHeader, workspaceStyles as ws } from "../../components/workspace";
import { RecordRow, recordStyles as rs } from "../../components/records";
import { createCustomer, getCustomerDetail, getCustomerDirectory, setCustomerActive, updateCustomer,
  type CustomerFields, type CustomerStatusFilter } from "../../lib/customers-api";
import { useWorkspace } from "../../navigation/WorkspaceContext";
import { theme as t } from "../../theme/tokens";
import { workspaceLayout } from "../../theme/layout";
import { useBusiness } from "../business/BusinessContext";
import { useResource } from "../appointments/useResource";
import { CustomerDetailPane, CustomerForm } from "./CustomerDetail";
import { appointmentCustomer, customerMessage } from "./state";

type Mode = { kind: "view" } | { kind: "create" } | { kind: "edit" };

export function CustomersScreen() {
  const { business, userId } = useBusiness();
  const { setNavigationLocked, startAppointment } = useWorkspace();
  const { width, height, fontScale } = useWindowDimensions();
  // Phone header: keep the title readable next to the primary action.
  const { compact } = workspaceLayout(width, height, fontScale);
  const scope = `${userId}:${business.id}`;
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<CustomerStatusFilter>("active");
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "view" });
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState<{ message: string; error?: boolean } | null>(null);
  const [archivePrompt, setArchivePrompt] = useState(false);
  const submitting = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setNavigationLocked(busy); return () => setNavigationLocked(false); }, [busy, setNavigationLocked]);
  useEffect(() => {
    const timer = setTimeout(() => { setQuery(search.trim()); setOffset(0); }, 250);
    return () => clearTimeout(timer);
  }, [search]);
  const list = useResource(`${scope}:customers:${status}:${query}:${offset}`,
    (signal) => getCustomerDirectory(business.id, { q: query, status, offset }, signal));
  const detail = useResource(selectedId ? `${scope}:customer:${selectedId}` : null,
    (signal) => getCustomerDetail(business.id, selectedId!, signal));
  const selected = detail.data?.customer.id === selectedId ? detail.data : undefined;

  function select(id: string) {
    if (busy) return;
    setSelectedId(id); setMode({ kind: "view" }); setNotice(null); setFormError(""); setArchivePrompt(false);
  }
  function changeStatus(next: CustomerStatusFilter) { setStatus(next); setOffset(0); }
  function closeForm() { if (!busy) { setMode({ kind: "view" }); setFormError(""); } }

  // One submit at a time; failures are never retried automatically because
  // customer writes have no idempotency contract.
  async function run<T>(work: () => Promise<T>, done: (result: T) => void, onError: (message: string) => void) {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setFormError(""); setNotice(null);
    try {
      const result = await work();
      if (alive.current) done(result);
    } catch (error) {
      if (alive.current) onError(customerMessage(error));
    } finally {
      submitting.current = false;
      if (alive.current) setBusy(false);
    }
  }
  function save(fields: CustomerFields) {
    const editing = mode.kind === "edit" && selectedId;
    void run(() => editing ? updateCustomer(business.id, userId, selectedId, fields) : createCustomer(business.id, userId, fields),
      (customer) => {
        if (!editing) { setSearch(""); setQuery(""); setStatus("active"); setOffset(0); }
        setSelectedId(customer.id); setMode({ kind: "view" });
        setNotice({ message: editing ? "Customer updated." : "Customer created." });
        list.refresh(); detail.refresh();
      }, setFormError);
  }
  function toggleActive() {
    if (!selected) return;
    const next = !selected.customer.is_active;
    void run(() => setCustomerActive(business.id, userId, selected.customer.id, next), () => {
      setArchivePrompt(false);
      setNotice({ message: next ? "Customer reactivated." : "Customer archived. Appointment history was preserved." });
      list.refresh(); detail.refresh();
    }, (message) => setNotice({ message, error: true }));
  }

  const directory = list.data;
  const master = <>
    <PaneTitle title={status === "active" ? "Active customers" : "Archived customers"}
      detail={directory ? `${directory.total} ${query ? "matching" : "total"}` : undefined}
      action={<IconButton label="Refresh customers" icon="refresh-cw" disabled={busy} onPress={list.refresh} />} />
    <Field label="Search customers by name, phone or email" search placeholder="Name, phone or email" value={search}
      onChangeText={setSearch} autoCorrect={false} autoCapitalize="none" returnKeyType="search" />
    <View style={[rs.filters, { paddingTop: t.space.md }]}>
      <Button label={`Active${directory ? ` ${directory.counts.active}` : ""}`} secondary selected={status === "active"} onPress={() => changeStatus("active")} />
      <Button label={`Archived${directory ? ` ${directory.counts.archived}` : ""}`} secondary selected={status === "archived"} onPress={() => changeStatus("archived")} />
    </View>
    {list.loading && <Feedback kind="loading" title="Loading customers" />}
    {list.error && <Feedback kind="error" title="Customers unavailable" detail={list.error} retry={list.refresh} />}
    {directory && <>
      {directory.customers.map((customer) => <RecordRow key={customer.id} selected={customer.id === selectedId && mode.kind !== "create"} disabled={busy}
        label={`${customer.full_name}${customer.is_active ? "" : ", archived"}. Open customer`} onPress={() => select(customer.id)}>
        <Text numberOfLines={1} style={[rs.name, !customer.is_active && rs.inactiveName]}>{customer.full_name}</Text>
        <Text numberOfLines={1} style={ui.meta}>{customer.phone || customer.email || "No contact details"}</Text>
      </RecordRow>)}
      {!directory.customers.length && (query
        ? <Feedback title="No matching customers" detail="Try another name, phone number or email." />
        : status === "archived" ? <Feedback title="No archived customers" detail="Archived customers keep their history and appear here." />
          : <Feedback title="No customers yet" detail="Add your first customer to start booking appointments." />)}
      {(offset > 0 || directory.nextOffset != null) && <View style={[rs.actions, { paddingTop: t.space.md }]}>
        {offset > 0 && <Button label="Previous" icon="chevron-left" secondary disabled={busy} onPress={() => setOffset(Math.max(0, offset - 50))} />}
        {directory.nextOffset != null && <Button label="More customers" secondary disabled={busy} onPress={() => setOffset(directory.nextOffset!)} />}
      </View>}
    </>}
  </>;

  const detailPane = mode.kind !== "view"
    ? <CustomerForm key={mode.kind === "edit" ? selectedId : "new"} customer={mode.kind === "edit" ? selected?.customer : undefined}
        busy={busy} error={formError} onCancel={closeForm} onSave={save} />
    : !selectedId ? <View style={rs.block}>
        <PaneTitle title="Customer details" />
        <Text style={ui.strong}>Select a customer</Text>
        <Text style={ui.body}>View contact details, notes and appointment history, or add a new customer.</Text>
      </View>
      : detail.loading && !selected ? <Feedback kind="loading" title="Loading customer" />
        : detail.error && !selected ? <Feedback kind="error" title="Customer unavailable" detail={detail.error} retry={detail.refresh} />
          : selected ? <CustomerDetailPane detail={selected} busy={busy} stale={detail.loading} notice={notice} archivePrompt={archivePrompt}
              onArchivePrompt={setArchivePrompt} onToggleActive={toggleActive}
              onEdit={() => { setMode({ kind: "edit" }); setNotice(null); setFormError(""); }}
              onNewAppointment={() => startAppointment(appointmentCustomer(selected.customer))} />
            : <ActivityIndicator color={t.colors.emerald} />;

  return <View style={ws.page}>
    <WorkspaceHeader operational title="Customers" business={business.name}
      subtitle={directory ? `${directory.counts.active} active · ${directory.counts.archived} archived` : "Customer records"}
      action={<Button brand label={compact ? "New" : "New Customer"} icon="user-plus" disabled={busy}
        onPress={() => { setMode({ kind: "create" }); setNotice(null); setFormError(""); setArchivePrompt(false); }} />} />
    <MasterDetail master={master} detail={detailPane} showDetail={mode.kind !== "view" || !!selectedId}
      fixed={{ side: "master", width: 340 }} backLabel="All customers" onBack={() => {
        if (busy) return;
        if (mode.kind === "edit") closeForm(); else { setMode({ kind: "view" }); setSelectedId(null); setNotice(null); }
      }} />
  </View>;
}
