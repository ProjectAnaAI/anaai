import { dateLabel } from "../../components/datePresentation";
import { theme as t } from "../../theme/tokens";
import { StyleSheet, Text, View } from "react-native";
import type { Appointment } from "../../lib/appointments-api";
import { Badge, styles as ui } from "../../components/ui";
import { PaneTitle, workspaceStyles as ws } from "../../components/workspace";
import { statusTone } from "../today/presentation";
import { Action, Notice } from "./controls";
import { lifecycleActions, timeLabel } from "./state";

export function AppointmentInspector({ appointment, busy, stale, message, cancelPrompt, onCancelPrompt, onAction, onReschedule }: {
  appointment: Appointment | null; busy: boolean; stale: boolean; message: string; cancelPrompt: boolean;
  onCancelPrompt: (value: boolean) => void; onAction: (status: "Confirmed" | "Cancelled" | "Completed") => void; onReschedule: () => void;
}) {
  return <View style={ws.railSection}>
    <PaneTitle title="Appointment details" />
    {!appointment ? <><Text style={ui.strong}>Your day, in focus</Text><Text style={ui.body}>Select an appointment to view its details and available actions.</Text></> : <>
      <Badge label={appointment.status} tone={statusTone(appointment.status)} />
      <View style={s.identity}>
        <Text accessibilityRole="header" style={s.customer}>{appointment.customer_name || "Customer"}</Text>
        <Text style={ui.body}>{appointment.service || "Service unavailable"} · {appointment.duration_minutes == null ? "Duration unavailable" : `${appointment.duration_minutes} min`}</Text>
      </View>
      <View style={s.schedule}>
        <Text style={s.time}>{timeLabel(appointment.appointment_time)}</Text>
        <Text style={ui.body}>{dateLabel(appointment.appointment_date)}</Text>
      </View>
      {!!appointment.notes && <View><Text style={ui.meta}>Notes</Text><Text style={ui.body}>{appointment.notes}</Text></View>}
      {["Completed", "Cancelled"].includes(appointment.status) && <Text style={ui.meta}>This appointment is {appointment.status.toLowerCase()}. No further actions are available.</Text>}
      {!!message && <Notice message={message} />}
      {lifecycleActions(appointment.status).filter((status) => status !== "Cancelled").map((status) => <Action key={status}
        label={busy ? "Saving…" : status === "Confirmed" ? "Confirm" : "Complete"} busy={busy} disabled={busy || stale} onPress={() => onAction(status)} />)}
      {["Booked", "Confirmed"].includes(appointment.status) && <>
        <Action label="Reschedule" icon="calendar" secondary disabled={busy || stale || !appointment.customer_id || !appointment.service_id} onPress={onReschedule} />
        <View style={s.destructiveSection}>{cancelPrompt ? <><Notice message="Cancel this appointment? This releases its time and cannot be undone here." />
          <Action label="Yes, Cancel Appointment" destructive disabled={busy || stale} onPress={() => onAction("Cancelled")} />
          <Action label="Keep Appointment" secondary disabled={busy} onPress={() => onCancelPrompt(false)} /></>
          : <Action label="Cancel Appointment" secondary destructive disabled={busy || stale} onPress={() => onCancelPrompt(true)} />}</View>
      </>}
    </>}
  </View>;
}

const s = StyleSheet.create({
  identity: { gap: t.space.xs },
  customer: { fontSize: 24, lineHeight: 30, color: t.colors.text, fontWeight: "700" },
  time: { fontSize: t.font.title, fontWeight: "600", color: t.colors.text, fontVariant: ["tabular-nums"] },
  schedule: { gap: t.space.xs, paddingVertical: t.space.md, borderTopWidth: t.border, borderBottomWidth: t.border, borderColor: t.colors.border },
  destructiveSection: { borderTopWidth: t.border, borderColor: t.colors.border, paddingTop: t.space.lg, marginTop: t.space.sm, gap: t.space.sm },
});
