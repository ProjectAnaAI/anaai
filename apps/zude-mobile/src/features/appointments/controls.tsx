import { dateLabel } from "../../components/datePresentation";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Button, IconButton, styles as ui } from "../../components/ui";
import { Field } from "../../components/workspace";
import { theme as t } from "../../theme/tokens";
import { shiftDate } from "./state";

// Compatibility names keep the existing appointment state/UI tests meaningful;
// controls now share the same implementation as the rest of ZUDE.
export const Action = Button;
export function DateControls({ date, today, onChange, disabled = false, composing = false }: {
  date: string; today: string; onChange: (date: string) => void; disabled?: boolean; composing?: boolean;
}) {
  const [choosing, setChoosing] = useState(false);
  return <View style={s.row}>
    {!composing && <IconButton label="Previous day" icon="chevron-left" disabled={disabled} onPress={() => onChange(shiftDate(date, -1))} />}
    <Action label="Today" secondary selected={date === today} disabled={disabled} onPress={() => onChange(today)} />
    {composing && <Action label="Tomorrow" secondary selected={date === shiftDate(today, 1)} disabled={disabled} onPress={() => onChange(shiftDate(today, 1))} />}
    {!composing && <IconButton label="Next day" icon="chevron-right" disabled={disabled} onPress={() => onChange(shiftDate(date, 1))} />}
    <Action label={choosing ? "Hide date entry" : composing ? "Choose Date" : dateLabel(date, true)} icon="calendar" secondary disabled={disabled} onPress={() => setChoosing(!choosing)} />
    {choosing && <Field label="Date, YYYY-MM-DD" placeholder="YYYY-MM-DD" value={date} editable={!disabled}
      onChangeText={onChange} maxLength={10} autoCorrect={false} style={s.dateInput} />}
  </View>;
}
export function Notice({ message, error = false, success = false }: { message: string; error?: boolean; success?: boolean }) {
  return <Text accessibilityRole="alert" style={[s.notice, error && s.error, success && s.success]}>{message}</Text>;
}
export const s = StyleSheet.create({
  page: { flex: 1, minWidth: 0, backgroundColor: t.colors.workspace },
  content: { padding: t.space.lg, gap: t.space.lg },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: t.space.sm },
  title: { fontSize: t.font.title, fontWeight: "700", color: t.colors.text },
  heading: { fontSize: t.font.section, fontWeight: "600", color: t.colors.text },
  text: ui.body,
  muted: ui.meta,
  dateInput: { width: 160 },
  notice: { padding: t.space.md, backgroundColor: t.colors.amberSoft, color: t.colors.amber, fontSize: t.font.body, lineHeight: 21, borderRadius: t.radius.sm },
  error: { backgroundColor: t.colors.destructiveSoft, color: t.colors.destructive },
  success: { backgroundColor: t.colors.emeraldSoft, color: t.colors.emerald },
  section: { gap: t.space.md, paddingVertical: t.space.lg, borderBottomWidth: t.border, borderColor: t.colors.border },
  option: { minHeight: t.layout.touch, paddingVertical: t.space.md, paddingHorizontal: t.space.md, borderBottomWidth: t.border, borderBottomColor: t.colors.border, gap: t.space.xs },
  selected: { backgroundColor: t.colors.emeraldSoft, borderColor: t.colors.emerald },
});
