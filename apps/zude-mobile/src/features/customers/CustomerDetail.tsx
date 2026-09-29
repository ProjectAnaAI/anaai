import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { dateLabel } from "../../components/datePresentation";
import { Badge, Button, styles as ui } from "../../components/ui";
import { DetailLine, PaneTitle } from "../../components/workspace";
import { LabeledField, recordStyles as rs } from "../../components/records";
import type { CustomerDetail, CustomerFields, CustomerHistoryItem, CustomerRecord } from "../../lib/customers-api";
import { theme as t } from "../../theme/tokens";
import { Notice } from "../appointments/controls";
import { timeLabel } from "../appointments/state";
import { statusTone } from "../today/presentation";
import { canBook, customerFields, emptyCustomerFields, historyCountLabel, historyPresentation } from "./state";

const historyPage = 10;

function AppointmentLine({ appointment, emphasized = false }: { appointment: CustomerHistoryItem; emphasized?: boolean }) {
  return <View style={[s.appointment, emphasized && s.upcoming]} accessible
    accessibilityLabel={`${dateLabel(appointment.appointment_date, true)}, ${timeLabel(appointment.appointment_time)}, ${appointment.service || "Service unavailable"}, ${appointment.status}`}>
    <View style={s.when}>
      <Text style={ui.strong}>{dateLabel(appointment.appointment_date, true)}</Text>
      <Text style={ui.meta}>{timeLabel(appointment.appointment_time)}</Text>
    </View>
    <View style={ui.grow}>
      <Text numberOfLines={1} style={ui.body}>{appointment.service || "Service unavailable"}</Text>
      {appointment.duration_minutes != null && <Text style={ui.meta}>{appointment.duration_minutes} min</Text>}
    </View>
    <Badge compact label={appointment.status} tone={statusTone(appointment.status)} />
  </View>;
}

export function CustomerDetailPane({ detail, busy, stale, notice, archivePrompt, onArchivePrompt, onToggleActive, onEdit, onNewAppointment }: {
  detail: CustomerDetail; busy: boolean; stale: boolean; notice: { message: string; error?: boolean } | null; archivePrompt: boolean;
  onArchivePrompt: (open: boolean) => void; onToggleActive: () => void; onEdit: () => void; onNewAppointment: () => void;
}) {
  const [visible, setVisible] = useState(historyPage);
  const { customer } = detail;
  const { upcoming, history } = historyPresentation(detail);
  return <View>
    <View style={[rs.block, { paddingTop: t.space.xl }]}>
      <Badge label={customer.is_active ? "Active" : "Archived"} tone={customer.is_active ? "success" : "neutral"} />
      <Text accessibilityRole="header" style={rs.title}>{customer.full_name}</Text>
      {!!notice && <Notice message={notice.message} error={notice.error} success={!notice.error} />}
      <View style={rs.actions}>
        {canBook(customer) && <Button label="New Appointment" icon="plus-circle" disabled={busy || stale} onPress={onNewAppointment} />}
        <Button label="Edit" icon="edit-2" secondary disabled={busy || stale} onPress={onEdit} />
      </View>
      {!canBook(customer) && <Text style={ui.meta}>Archived customers keep their history but can’t be booked until reactivated.</Text>}
    </View>
    <View style={rs.block}>
      <PaneTitle title="Contact" />
      <DetailLine icon="phone" label="Phone" value={customer.phone || "Not provided"} />
      <DetailLine icon="mail" label="Email" value={customer.email || "Not provided"} />
    </View>
    <View style={rs.block}>
      <PaneTitle title="Notes" />
      <Text style={customer.notes ? ui.body : ui.meta}>{customer.notes || "No notes for this customer."}</Text>
    </View>
    <View style={rs.block}>
      <PaneTitle title="Upcoming appointment" />
      {upcoming ? <AppointmentLine appointment={upcoming} emphasized />
        : <Text style={ui.meta}>No upcoming appointment.</Text>}
    </View>
    <View style={rs.block}>
      <PaneTitle title="Appointment history" detail={historyCountLabel(detail)} />
      {history.slice(0, visible).map((appointment) => <AppointmentLine key={appointment.id} appointment={appointment} />)}
      {!history.length && <Text style={ui.meta}>{upcoming ? "No other appointments." : "Appointments booked for this customer will appear here."}</Text>}
      {history.length > visible && <Button label={`Show all ${history.length}`} secondary onPress={() => setVisible(history.length)} />}
    </View>
    <View style={[rs.block, { borderBottomWidth: 0 }]}>
      {archivePrompt ? <>
        <Notice message={customer.is_active
          ? `Archive ${customer.full_name}? Their appointment history will be preserved and you can reactivate them later.`
          : `Reactivate ${customer.full_name}? They can be selected for new appointments again.`} />
        <View style={rs.actions}>
          <Button label={customer.is_active ? "Yes, Archive Customer" : "Yes, Reactivate"} destructive={customer.is_active}
            busy={busy} disabled={busy || stale} onPress={onToggleActive} />
          <Button label="Keep As Is" secondary disabled={busy} onPress={() => onArchivePrompt(false)} />
        </View>
      </> : <Button label={customer.is_active ? "Archive Customer" : "Reactivate Customer"} icon={customer.is_active ? "archive" : "rotate-ccw"}
        secondary destructive={customer.is_active} disabled={busy || stale} onPress={() => onArchivePrompt(true)} />}
    </View>
  </View>;
}

export function CustomerForm({ customer, busy, error, onCancel, onSave }: {
  customer?: CustomerRecord; busy: boolean; error: string; onCancel: () => void; onSave: (fields: CustomerFields) => void;
}) {
  const [fields, setFields] = useState<CustomerFields>(() => customer ? customerFields(customer) : emptyCustomerFields);
  const set = (key: keyof CustomerFields) => (value: string) => setFields((previous) => ({ ...previous, [key]: value }));
  return <View style={rs.form}>
    <PaneTitle title={customer ? "Edit customer" : "New customer"} detail={customer ? customer.full_name : "Add a customer to your business."} />
    <LabeledField label="Name" value={fields.name} onChangeText={set("name")} editable={!busy} maxLength={200}
      autoCapitalize="words" autoComplete="name" textContentType="name" returnKeyType="next" autoFocus={!customer} />
    <LabeledField label="Phone" optional value={fields.phone} onChangeText={set("phone")} editable={!busy}
      keyboardType="phone-pad" autoComplete="tel" textContentType="telephoneNumber" hint="Used to recognize returning customers. Each phone number belongs to one customer." />
    <LabeledField label="Email" optional value={fields.email} onChangeText={set("email")} editable={!busy} maxLength={254}
      keyboardType="email-address" autoCapitalize="none" autoCorrect={false} autoComplete="email" textContentType="emailAddress" />
    <LabeledField label="Notes" optional value={fields.notes} onChangeText={set("notes")} editable={!busy} multiline
      textAlignVertical="top" style={{ minHeight: 96, alignItems: "stretch" }} />
    {!!error && <Notice message={error} error />}
    <View style={rs.actions}>
      <Button label={busy ? "Saving…" : customer ? "Save Changes" : "Create Customer"} icon="check" busy={busy}
        disabled={busy || !fields.name.trim()} onPress={() => onSave(fields)} />
      <Button label="Cancel" secondary disabled={busy} onPress={onCancel} />
    </View>
  </View>;
}

const s = StyleSheet.create({
  appointment: { flexDirection: "row", alignItems: "center", gap: t.space.md, minHeight: t.layout.touch, paddingVertical: t.space.sm,
    paddingHorizontal: t.space.md, borderRadius: t.radius.sm, backgroundColor: t.colors.surface, borderWidth: t.border, borderColor: t.colors.border },
  upcoming: { backgroundColor: t.colors.upcomingSurface, borderColor: t.colors.upcomingBorder },
  when: { width: 116 },
});
