import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Badge, styles as ui } from "../../components/ui";
import type { Appointment } from "../../types/today";
import { formatDuration, formatTime } from "./todayData";
import { statusTone, upcomingAppointment, upcomingTimingLabel } from "./presentation";
import { theme as t } from "../../theme/tokens";

export function AppointmentList({ appointments, now, onSelect }: {
  appointments: readonly Appointment[]; now: number | null; onSelect: (appointment: Appointment) => void;
}) {
  const next = upcomingAppointment(appointments, now);
  const [focused, setFocused] = useState(false);
  return <View style={s.section}>
    <Text accessibilityRole="header" style={s.sectionTitle}>Up next</Text>
    {next ? <Pressable accessibilityRole="button" accessibilityLabel={`View appointment for ${next.customer}, ${formatTime(next.start)}`}
      onPress={() => onSelect(next)} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      style={({ pressed }) => [s.upcoming, focused && s.focused, pressed && ui.pressed]}>
      <View style={s.timing}><Text style={s.timingText}>{upcomingTimingLabel(next.start, now)}</Text><Text style={s.timingText}>{formatTime(next.start)}</Text></View>
      <Text style={ui.strong}>{next.customer}</Text>
      <Text style={ui.meta}>{next.service} · {formatDuration(next.duration)}</Text>
      <Badge compact label={next.status} tone={statusTone(next.status)} />
    </Pressable> : <View style={s.empty}><Text style={ui.strong}>Nothing else scheduled</Text><Text style={ui.meta}>No upcoming appointments in today’s loaded schedule.</Text></View>}
  </View>;
}
export const todayRailStyles = StyleSheet.create({
  section: { paddingTop: t.space.xl, gap: t.space.sm },
  title: { color: t.colors.rowMuted, fontSize: 10, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.2 },
});
const s = StyleSheet.create({
  section: todayRailStyles.section,
  sectionTitle: todayRailStyles.title,
  upcoming: { minHeight: t.layout.touch, padding: t.space.md, gap: t.space.xs, borderWidth: t.border, borderColor: t.colors.upcomingBorder, borderRadius: t.radius.md, backgroundColor: t.colors.upcomingSurface },
  focused: { borderColor: t.colors.focus },
  timing: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: t.space.xs, marginBottom: t.space.xs },
  timingText: { color: t.colors.brandText, fontSize: 11, fontWeight: "600" },
  empty: { gap: t.space.xs },
});
