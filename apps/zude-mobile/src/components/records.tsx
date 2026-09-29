import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, type TextInputProps } from "react-native";
import { theme as t } from "../theme/tokens";
import { Icon, styles as ui } from "./ui";
import { Field } from "./workspace";

// Shared building blocks for record workspaces (Customers, Services), matching
// the timeline's selection treatment and the composer's control sizing.
export function RecordRow({ label, selected, disabled = false, onPress, children, trailing }: {
  label: string; selected: boolean; disabled?: boolean; onPress: () => void; children: ReactNode; trailing?: ReactNode;
}) {
  const [focused, setFocused] = useState(false);
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected, disabled }} disabled={disabled}
    onPress={onPress} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
    style={({ pressed }) => [s.row, selected && s.selected, focused && s.focused, disabled && ui.disabled, pressed && ui.pressed]}>
    <View style={ui.grow}>{children}</View>
    {trailing}
    <Icon name="chevron-right" size={16} />
  </Pressable>;
}

export function LabeledField({ label, hint, optional = false, ...props }: TextInputProps & { label: string; hint?: string; optional?: boolean }) {
  return <View style={s.labeled}>
    <Text style={s.label}>{label}{optional && <Text style={ui.meta}>  Optional</Text>}</Text>
    <Field label={label} {...props} />
    {!!hint && <Text style={ui.meta}>{hint}</Text>}
  </View>;
}

export function ReadOnlyValue({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return <View style={s.labeled}>
    <Text style={s.label}>{label}</Text>
    <View style={s.readOnly}><Text style={ui.body}>{value}</Text></View>
    {!!hint && <Text style={ui.meta}>{hint}</Text>}
  </View>;
}

export const recordStyles = StyleSheet.create({
  name: { fontSize: t.font.label, fontWeight: "600", color: t.colors.text, lineHeight: 21 },
  inactiveName: { color: t.colors.muted },
  title: { fontSize: 24, lineHeight: 30, fontWeight: "700", color: t.colors.text },
  block: { gap: t.space.md, paddingVertical: t.space.lg, borderBottomWidth: t.border, borderColor: t.colors.border },
  actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: t.space.sm },
  filters: { flexDirection: "row", gap: t.space.sm, paddingBottom: t.space.md },
  form: { gap: t.space.lg, paddingVertical: t.space.lg },
});

const s = StyleSheet.create({
  row: { minHeight: 60, flexDirection: "row", alignItems: "center", gap: t.space.md, paddingVertical: t.space.md, paddingHorizontal: t.space.md,
    borderBottomWidth: t.border, borderColor: t.colors.border, borderLeftWidth: 2, borderLeftColor: "transparent" },
  selected: { backgroundColor: t.colors.emeraldSoft, borderLeftColor: t.colors.emerald },
  focused: { borderLeftColor: t.colors.focus, backgroundColor: t.colors.neutral },
  labeled: { gap: t.space.xs },
  label: { fontSize: t.font.body, fontWeight: "600", color: t.colors.text },
  readOnly: { minHeight: t.control.height, justifyContent: "center", paddingHorizontal: t.space.md, borderRadius: t.radius.sm, backgroundColor: t.colors.neutral },
});
