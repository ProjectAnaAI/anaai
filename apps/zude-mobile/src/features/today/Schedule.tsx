import { useState } from "react";
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Badge, Icon, styles as ui } from "../../components/ui";
import type { Appointment } from "../../types/today";
import { formatDuration, formatTime } from "./todayData";
import { appointmentTiming, statusTone, timelinePresentation } from "./presentation";
import { theme as t } from "../../theme/tokens";
import { workspaceLayout } from "../../theme/layout";

export function Schedule({ appointments, now, status, selectedId, onSelect, disabled = false, operational = false }: {
  appointments: readonly Appointment[]; now: number | null; status: string;
  selectedId?: string | null; onSelect?: (appointment: Appointment) => void; disabled?: boolean; operational?: boolean;
}) {
  const { width, height, fontScale } = useWindowDimensions();
  const { compact } = workspaceLayout(width, height, fontScale);
  const { ordered, nowIndex } = timelinePresentation(appointments, status === "success" ? now : null);
  const [focused, setFocused] = useState<string | null>(null);
  const indicator = <View style={[s.now, operational && s.operationalNow]} accessibilityLabel={`Now, ${formatTime(now)}`}>
    <View style={[s.nowPill, !operational && { backgroundColor: t.colors.emerald }]}><View style={s.nowDot} /><Text style={s.nowText}>{`${formatTime(now)} NOW`}</Text></View><View style={s.nowLine} /><View style={s.nowEnd} />
  </View>;
  return <View>

    {ordered.map((a, index) => {
      const timing = appointmentTiming(a, now);
      return <View key={a.id}>
        {index === nowIndex && indicator}
        <Pressable accessibilityRole="button" disabled={disabled || !onSelect} onPress={() => onSelect?.(a)}
          accessibilityLabel={`${formatTime(a.start)}, ${a.customer}, ${a.service}, ${formatDuration(a.duration)}, ${a.status}. Open appointment`}
          accessibilityState={{ selected: selectedId === a.id, disabled: disabled || !onSelect }}
          onFocus={() => setFocused(a.id)} onBlur={() => setFocused(null)}
          style={({ pressed }) => [s.entry, selectedId === a.id && s.selected, timing.current && s.current,
            focused === a.id && s.focused, operational && s.operationalEntry,
            operational && (timing.current || selectedId === a.id) && s.emphasized,
            operational && focused === a.id && { borderColor: t.colors.brand }, pressed && ui.pressed]}>
          {operational && (timing.current || selectedId === a.id) && <View style={s.appointmentMarker} />}
          <View style={[s.time, compact && { width: 60 }, operational && s.operationalTime]}>
            <Text style={[s.timeText, timing.past && s.receded, operational && s.operationalTimeText, operational && timing.past && s.operationalReceded]}>{operational ? formatTime(a.start) : a.start === null ? "—" : formatTime(a.start).split(" ")[0]}</Text>
            <Text style={ui.meta}>{operational ? formatDuration(a.duration) : a.start === null ? "No time" : formatTime(a.start).split(" ")[1]}</Text>
          </View>
          <View style={ui.grow}>
            <Text style={[s.customer, timing.past && s.receded, operational && s.operationalCustomer, operational && timing.past && s.operationalReceded]}>{a.customer}</Text>
            <Text style={ui.meta}>{a.service}{!operational && ` · ${formatDuration(a.duration)}`}</Text>
            {compact && <View style={s.inlineStatus}><Badge compact={operational} label={a.status} tone={operational && timing.past ? "neutral" : statusTone(a.status)} /></View>}
          </View>
          {!compact && <View><Badge compact={operational} label={a.status} tone={operational && timing.past ? "neutral" : statusTone(a.status)} /></View>}
          <Icon name="chevron-right" size={16} />
        </Pressable>
      </View>;
    })}
    {nowIndex === ordered.length && indicator}
  </View>;
}
const s = StyleSheet.create({
  operationalEntry: { backgroundColor: t.colors.surface, minHeight: t.control.timelineRow, paddingVertical: t.space.sm, paddingHorizontal: t.space.md, marginBottom: t.space.md, borderWidth: t.border, borderLeftWidth: t.border, borderColor: t.colors.border, borderLeftColor: t.colors.border, borderRadius: t.radius.md },
  operationalTime: { width: 76, borderRightWidth: 0, alignSelf: "auto" },
  operationalTimeText: { fontSize: t.font.body, lineHeight: 19, fontWeight: "700" },
  operationalCustomer: { fontSize: t.font.label, lineHeight: 21 },
  operationalReceded: { color: t.colors.rowMuted, fontWeight: "500" },
  emphasized: { paddingLeft: 28, borderWidth: 2, borderBottomWidth: 2, borderLeftWidth: 2, borderColor: t.colors.timelineRule, borderLeftColor: t.colors.timelineRule },
  appointmentMarker: { position: "absolute", left: t.space.md, top: t.space.md, bottom: t.space.md, width: 3, borderRadius: 2, backgroundColor: t.colors.text },
  operationalNow: { paddingVertical: 0, minHeight: 20, marginBottom: t.space.md, gap: 0 },
  time: { width: 80, alignSelf: "stretch", justifyContent: "center", borderRightWidth: t.border, borderRightColor: t.colors.border },
  entry: { flexDirection: "row", alignItems: "center", gap: t.space.md, minHeight: t.control.row, paddingVertical: t.space.lg, paddingHorizontal: t.space.xs, borderBottomWidth: t.border, borderColor: t.colors.border, borderLeftWidth: 2, borderLeftColor: "transparent" },
  timeText: { color: t.colors.text, fontSize: 24, fontWeight: "600", fontVariant: ["tabular-nums"] },
  customer: { color: t.colors.text, fontSize: t.font.section, fontWeight: "600", lineHeight: 25 },
  selected: { backgroundColor: t.colors.emeraldSoft, borderLeftColor: t.colors.emerald },
  current: { borderLeftColor: t.colors.emerald, backgroundColor: t.colors.emeraldSoft },
  focused: { borderLeftColor: t.colors.focus, backgroundColor: t.colors.neutral },
  receded: { color: t.colors.muted, fontWeight: "400" },
  inlineStatus: { marginTop: t.space.xs },
  now: { flexDirection: "row", alignItems: "center", gap: t.space.sm, paddingVertical: t.space.md },
  nowPill: { flexDirection: "row", alignItems: "center", gap: 3, borderRadius: 16, backgroundColor: t.colors.timelineRule, paddingHorizontal: 8, paddingVertical: 4, marginRight: 12 },
  nowDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: t.colors.surface },
  nowText: { color: t.colors.surface, fontSize: 11, fontWeight: "700" },
  nowLine: { flex: 1, height: 2, backgroundColor: t.colors.timelineRule },
  nowEnd: { width: 8, height: 8, borderRadius: 4, backgroundColor: t.colors.timelineRule },
});
