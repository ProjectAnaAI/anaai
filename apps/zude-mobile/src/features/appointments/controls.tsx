import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { theme as t } from "../../theme/tokens";
import { shiftDate } from "./state";
export function Action({ label, onPress, disabled = false, secondary = false, destructive = false }: {
  label: string; onPress: () => void; disabled?: boolean; secondary?: boolean; destructive?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [s.action, secondary && s.secondary, destructive && s.destructive, (disabled || pressed) && { opacity: 0.5 }]}>
    <Text style={[s.actionText, secondary && { color: t.colors.text }, destructive && { color: "#FFFFFF" }]}>{label}</Text>
  </Pressable>;
}
export function DateControls({ date, today, onChange, disabled = false }: { date: string; today: string; onChange: (date: string) => void; disabled?: boolean }) {
  return <View style={s.row}>
    <Action label="Previous day" secondary disabled={disabled} onPress={() => onChange(shiftDate(date, -1))} />
    <Action label="Today" secondary disabled={disabled} onPress={() => onChange(today)} />
    <Action label="Tomorrow" secondary disabled={disabled} onPress={() => onChange(shiftDate(today, 1))} />
    <Action label="Next day" secondary disabled={disabled} onPress={() => onChange(shiftDate(date, 1))} />
    <TextInput accessibilityLabel="Date, YYYY-MM-DD" placeholder="YYYY-MM-DD" value={date} editable={!disabled}
      onChangeText={onChange} maxLength={10} autoCorrect={false} style={[s.input, { width: 150 }]} />
  </View>;
}
export function Notice({ message }: { message: string }) {
  return <Text accessibilityRole="alert" style={s.notice}>{message}</Text>;
}
export const s = StyleSheet.create({
  page: { flex: 1, minWidth: 0, backgroundColor: t.colors.workspace },
  content: { padding: 16, gap: 16 },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  title: { fontSize: 24, fontWeight: "700", color: t.colors.text },
  heading: { fontSize: 18, fontWeight: "600", color: t.colors.text },
  text: { fontSize: 14, color: t.colors.text, lineHeight: 21 },
  muted: { fontSize: 13, color: t.colors.muted, lineHeight: 20 },
  input: { minHeight: 44, backgroundColor: t.colors.surface, borderWidth: 1, borderColor: t.colors.border, borderRadius: 6, paddingHorizontal: 12, color: t.colors.text, fontSize: 16 },
  action: { minHeight: 44, borderRadius: 6, paddingHorizontal: 14, paddingVertical: 11, alignItems: "center", justifyContent: "center", backgroundColor: t.colors.emerald },
  secondary: { backgroundColor: t.colors.surface, borderWidth: 1, borderColor: t.colors.border },
  destructive: { backgroundColor: "#B42318" },
  actionText: { color: t.colors.surface, fontSize: 14, fontWeight: "600" },
  notice: { padding: 12, backgroundColor: t.colors.amberSoft, color: t.colors.amber, fontSize: 14, lineHeight: 21, borderRadius: 6 },
  section: { gap: 10, padding: 16, backgroundColor: t.colors.surface, borderWidth: 1, borderColor: t.colors.border, borderRadius: 8 },
  option: { minHeight: 48, padding: 12, borderBottomWidth: 1, borderBottomColor: t.colors.border, gap: 4 },
  selected: { backgroundColor: t.colors.emeraldSoft, borderColor: t.colors.emerald },
});
