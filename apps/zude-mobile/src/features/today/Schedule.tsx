import { StyleSheet, Text, View } from "react-native";
import { Icon, styles as ui } from "../../components/ui";
import { appointments, demoDay, formatTime } from "../../data/demoToday";
import { theme as t } from "../../theme/tokens";

export function Schedule() {
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
          {appointments.length} appointments · Business-wide
        </Text>
      </View>
      <View style={s.timeline}>
        {appointments.map((a, index) => (
          <View key={a.id}>
            {a.start > demoDay.now &&
              (index === 0 || appointments[index - 1].start <= demoDay.now) && (
                <View style={s.now}>
                  <View style={s.nowDot} />
                  <Text style={s.nowText}>{formatTime(demoDay.now)} · Now</Text>
                  <View style={s.nowLine} />
                </View>
              )}
            <View
              style={s.entry}
              accessible
              accessibilityLabel={`${formatTime(a.start)}, ${a.customer}, ${a.service}, ${a.duration} minutes, ${a.status}`}
            >
              <View style={s.timeColumn}>
                <Text style={ui.meta}>{formatTime(a.start)}</Text>
              </View>
              <View
                style={[
                  s.event,
                  a.status === "In progress" && s.current,
                  a.status === "Completed" && s.completed,
                ]}
              >
                <Text
                  style={[s.eventName, a.status === "Completed" && s.pastText]}
                >
                  {a.customer}
                </Text>
                <Text style={ui.meta}>
                  {a.service}
                  {a.status === "In progress" ? " · In progress" : ""}
                </Text>
              </View>
            </View>
          </View>
        ))}
      </View>
      <View style={s.close}>
        <Icon name="moon" size={15} />
        <Text style={ui.meta}>Open {demoDay.open}</Text>
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
  current: {
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
  close: {
    flexDirection: "row",
    gap: t.space.sm,
    padding: t.space.lg,
    borderTopWidth: t.border,
    borderTopColor: t.colors.border,
  },
});
