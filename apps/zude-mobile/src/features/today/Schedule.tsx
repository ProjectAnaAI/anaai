import { StyleSheet, Text, View } from "react-native";
import { Icon, styles as ui } from "../../components/ui";
import type { Appointment } from "../../types/today";
import { formatDuration, formatTime } from "./todayData";
import { theme as t } from "../../theme/tokens";

export function Schedule({ appointments, now, status }: {
  appointments: readonly Appointment[];
  now: number | null;
  status: string;
}) {
  const nowIndex = now === null ? -1 : appointments.findIndex((a) => a.start !== null && a.start > now);
  const indicator = now !== null && status === "success" ? (
    <View style={s.now}>
      <View style={s.nowDot} />
      <Text style={s.nowText}>{formatTime(now)} · Now</Text>
      <View style={s.nowLine} />
    </View>
  ) : null;
  return (
    <View style={s.panel}>
      <View style={s.heading}>
        <View style={ui.row}>
          <Icon name="calendar" />
          <Text accessibilityRole="header" style={[ui.sectionTitle, ui.grow]}>
            Today’s Schedule
          </Text>
        </View>
        <Text style={ui.meta}>
          {status === "success" ? `${appointments.length} appointments · Business-wide` : status === "loading" ? "Loading appointments…" : "Appointments unavailable"}
        </Text>
      </View>
      <View style={s.timeline}>
        {appointments.map((a, index) => (
          <View key={a.id}>
            {index === nowIndex && indicator}
            <View
              style={s.entry}
              accessible
              accessibilityLabel={`${formatTime(a.start)}, ${a.customer}, ${a.service}, ${formatDuration(a.duration)}, ${a.status}`}
            >
              <View style={s.timeColumn}>
                <Text style={ui.meta}>{formatTime(a.start)}</Text>
              </View>
              <View
                style={[
                  s.event,
                  a.status === "Confirmed" && s.confirmed,
                  (a.status === "Completed" || a.status === "Cancelled") && s.completed,
                ]}
              >
                <Text
                  style={[s.eventName, a.status === "Completed" && s.pastText]}
                >
                  {a.customer}
                </Text>
                <Text style={ui.meta}>
                  {a.service} · {formatDuration(a.duration)}
                </Text>
                <Text style={ui.meta}>
                  {a.status}
                </Text>
              </View>
            </View>
          </View>
        ))}
        {nowIndex === -1 && indicator}
        {status === "success" && appointments.length === 0 && (
          <Text style={[ui.meta, s.empty]}>No appointments scheduled today.</Text>
        )}
      </View>
    </View>
  );
}
const s = StyleSheet.create({
  panel: {
    backgroundColor: t.colors.surface,
    borderWidth: t.border,
    borderColor: t.colors.border,
    borderRadius: t.radius.md,
    overflow: "hidden",
  },
  heading: { padding: t.space.lg, gap: t.space.xs },
  timeline: {
    paddingHorizontal: t.space.md,
    borderTopWidth: t.border,
    borderTopColor: t.colors.border,
    paddingTop: t.space.sm,
  },
  entry: { flexDirection: "row", gap: t.space.sm, paddingBottom: t.space.sm },
  timeColumn: { width: 59, paddingTop: t.space.sm },
  event: {
    flex: 1,
    padding: t.space.sm,
    borderLeftWidth: 2,
    borderLeftColor: t.colors.border,
    gap: 2,
  },
  confirmed: {
    backgroundColor: t.colors.emeraldSoft,
    borderLeftColor: t.colors.emeraldBright,
    borderTopRightRadius: t.radius.sm,
    borderBottomRightRadius: t.radius.sm,
  },
  completed: { backgroundColor: t.colors.workspace },
  eventName: { fontSize: 13, color: t.colors.text, fontWeight: "600" },
  pastText: { color: t.colors.muted },
  now: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: t.space.sm,
  },
  nowDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: t.colors.emerald,
  },
  nowText: { color: t.colors.emerald, fontSize: 11, fontWeight: "600" },
  nowLine: { flex: 1, height: 1, backgroundColor: t.colors.emerald },
  empty: { paddingBottom: t.space.lg },
});
