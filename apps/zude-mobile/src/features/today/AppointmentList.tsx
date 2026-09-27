import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Badge, Icon, Section, styles as ui } from "../../components/ui";
import { formatDuration, formatTime } from "./todayData";
import { theme as t } from "../../theme/tokens";
import type { Appointment, Preview } from "../../types/today";

export function AppointmentList({
  appointments,
  compact,
  focused,
  now,
  onPreview,
}: {
  appointments: readonly Appointment[];
  compact: boolean;
  focused: boolean;
  now: number | null;
  onPreview: (preview: Preview) => void;
}) {
  const upcoming = appointments.filter(
    (a) =>
      (a.status === "Booked" || a.status === "Confirmed") &&
      (a.start === null || now === null || a.start >= now),
  );
  const [expanded, setExpanded] = useState(false);
  const visibleAppointments =
    focused && !expanded ? upcoming.slice(0, 3) : upcoming;
  function open(appointment: Appointment) {
    onPreview({
      title: appointment.customer,
      detail: `${appointment.service} · ${formatTime(appointment.start)} · ${formatDuration(appointment.duration)}. Status: ${appointment.status}. Appointment details and editing will be available in a future milestone.`,
    });
  }
  return (
    <Section
      title="Up Next"
      subtitle="Today’s booked and confirmed appointments"
      trailing={
        focused && upcoming.length > 3 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              expanded
                ? "Show nearest three appointments"
                : `Show all ${upcoming.length} remaining appointments`
            }
            accessibilityState={{ expanded }}
            onPress={() => setExpanded(!expanded)}
            style={({ pressed }) => [s.expand, pressed && ui.pressed]}
          >
            <Text style={s.expandText}>
              {expanded ? "Show less" : `View all (${upcoming.length})`}
            </Text>
            <Icon
              name={expanded ? "chevron-up" : "chevron-down"}
              color={t.colors.emerald}
              size={14}
            />
          </Pressable>
        ) : (
          <Text style={ui.meta}>{upcoming.length} remaining</Text>
        )
      }
    >
      {!compact && !focused && (
        <View style={s.columns}>
          <Text style={[s.columnLabel, s.time]}>TIME</Text>
          <Text style={[s.columnLabel, ui.grow]}>CUSTOMER / SERVICE</Text>
          <Text style={[s.columnLabel, s.status]}>STATUS</Text>
        </View>
      )}
      {upcoming.length === 0 && (
        <View style={s.row}>
          <Text style={[ui.meta, ui.grow]}>No remaining appointments today.</Text>
        </View>
      )}
      {visibleAppointments.map((a) => (
        <Pressable
          key={a.id}
          accessibilityRole="button"
          accessibilityLabel={`${a.customer}, ${a.service}, ${formatTime(a.start)}, ${a.status}. Preview details`}
          onPress={() => open(a)}
          style={({ pressed }) => [
            s.row,
            pressed && ui.pressed,
          ]}
        >
          <View style={[s.time, compact && s.compactTime]}>
            <Text style={s.timeText}>{a.start === null ? "—" : formatTime(a.start).split(" ")[0]}</Text>
            <Text style={ui.meta}>{a.start === null ? "No time" : formatTime(a.start).split(" ")[1]}</Text>
          </View>
          <View style={ui.grow}>
            <Text style={ui.strong}>{a.customer}</Text>
            <Text style={ui.meta}>
              {a.service} · {formatDuration(a.duration)}
            </Text>
            {compact && (
              <View style={s.inlineBadge}>
                <AppointmentBadge appointment={a} />
              </View>
            )}
          </View>
          {!compact && (
            <View style={s.status}>
              <AppointmentBadge appointment={a} />
            </View>
          )}
          <Icon name="chevron-right" size={16} />
        </Pressable>
      ))}
    </Section>
  );
}
function AppointmentBadge({ appointment }: { appointment: Appointment }) {
  return (
    <Badge
      label={appointment.status}
      tone={appointment.status === "Confirmed" ? "success" : "neutral"}
    />
  );
}
const s = StyleSheet.create({
  columns: {
    flexDirection: "row",
    gap: t.space.md,
    paddingHorizontal: t.space.lg,
    paddingVertical: t.space.sm,
    backgroundColor: t.colors.workspace,
    paddingRight: 44,
  },
  columnLabel: {
    fontSize: 10,
    letterSpacing: 0.8,
    fontWeight: "600",
    color: t.colors.muted,
  },
  time: { width: 66 },
  compactTime: { width: 48 },
  timeText: {
    color: t.colors.text,
    fontSize: t.font.body,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  status: { width: 114 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: t.space.md,
    paddingHorizontal: t.space.lg,
    paddingVertical: t.space.md,
    borderTopWidth: t.border,
    borderTopColor: t.colors.border,
    minHeight: 64,
  },
  inlineBadge: { marginTop: t.space.sm },
  expand: {
    flexDirection: "row",
    alignItems: "center",
    gap: t.space.xs,
    minHeight: t.layout.touch,
    paddingHorizontal: t.space.xs,
  },
  expandText: {
    fontSize: t.font.caption,
    fontWeight: "600",
    color: t.colors.emerald,
  },
});
