import { useState } from "react";
import { router } from "expo-router";
import { StyleSheet, Text, View } from "react-native";
import { Button, IconButton, styles as ui } from "../../components/ui";
import { Feedback, Field, SplitWorkspace, WorkspaceHeader, workspaceStyles as ws } from "../../components/workspace";
import { useTodayAppointments } from "./useTodayAppointments";
import type { Appointment } from "../../types/today";
import { AppointmentList, todayRailStyles } from "./AppointmentList";
import { Schedule } from "./Schedule";
import { theme as t } from "../../theme/tokens";

export function TodayScreen() {
  const { business, clock, appointments, status, errorMessage, retry } = useTodayAppointments();
  const [search, setSearch] = useState("");
  const rows = appointments.filter((a) => `${a.customer} ${a.service}`.toLowerCase().includes(search.toLowerCase()));
  function open(appointment: Appointment) {
    router.replace({ pathname: "/appointments", params: { date: clock?.date, appointment: appointment.id } });
  }
  return <View style={ws.page}>
    <WorkspaceHeader operational title="Today" business={business.name} subtitle={clock?.label ?? "Date unavailable"}
      search={<Field label="Search today's appointments" search placeholder="Search appointments…" style={{ backgroundColor: t.colors.workspace }} value={search} onChangeText={setSearch} />}
      action={<Button brand label="New Appointment" icon="plus-circle" onPress={() => router.replace({ pathname: "/appointments", params: { compose: "new" } })} />} />
    <SplitWorkspace operational main={<>
      <View style={s.timelineHeading}>
        <Text accessibilityRole="header" style={s.timelineTitle}>Day Timeline</Text>
        <Text numberOfLines={1} style={s.businessTag}>{business.name}</Text>
        <View style={ui.grow} />
        <IconButton label="Refresh today" icon="refresh-cw" onPress={retry} />
      </View>
      {status === "loading" && <Feedback kind="loading" title="Loading today’s appointments" />}
      {status === "error" && <Feedback kind="error" title="Appointments unavailable" detail={errorMessage} retry={retry} />}
      {status === "success" && <>
        <Schedule operational appointments={rows} now={clock?.minutes ?? null} status={status} onSelect={open} />
        {!rows.length && <Feedback title={search ? "No matching appointments" : "A clear day ahead"} detail={search ? "Try another customer or service name." : "No appointments are scheduled for this day."} />}
      </>}
    </>} rail={<>
      {status === "success" ? <AppointmentList appointments={appointments} now={clock?.minutes ?? null} onSelect={open} />
        : <Feedback title="Up next" detail={status === "loading" ? "Loading the day’s schedule…" : "Available when the schedule is loaded."} kind={status === "loading" ? "loading" : "empty"} />}
      <View style={todayRailStyles.section}>
        <Text accessibilityRole="header" style={todayRailStyles.title}>Next available times</Text>
        <Text style={ui.meta}>Choose a service in New Appointment to see available times for your date.</Text>
      </View>
    </>} />
  </View>;
}

const s = StyleSheet.create({
  timelineHeading: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: t.space.sm, minHeight: t.control.height, marginBottom: t.space.sm },
  timelineTitle: { color: t.colors.timelineText, fontSize: t.font.section, fontWeight: "700" },
  businessTag: { maxWidth: 160, color: t.colors.text, backgroundColor: t.colors.neutral, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 2, fontSize: 10 },
});
