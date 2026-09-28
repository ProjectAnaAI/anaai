import { useState, type ComponentProps, type ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import Feather from "@expo/vector-icons/Feather";
import { theme as t } from "../theme/tokens";

export type IconName = ComponentProps<typeof Feather>["name"];
export function Icon({
  name,
  color = t.colors.muted,
  size = 18,
}: {
  name: IconName;
  color?: string;
  size?: number;
}) {
  return <Feather name={name} size={size} color={color} accessible={false} />;
}
export function Button({
  label,
  onPress,
  icon,
  secondary = false,
  brand = false,
  destructive = false,
  disabled = false,
  busy = false,
  selected,
}: {
  label: string;
  onPress: () => void;
  icon?: IconName;
  secondary?: boolean;
  brand?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  busy?: boolean;
  selected?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || busy, busy, selected }}
      disabled={disabled || busy}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        brand && styles.brandButton,
        secondary && styles.secondary,
        destructive && (secondary ? styles.destructiveSecondary : styles.destructive),
        selected && styles.selected,
        focused && styles.focused,
        (disabled || busy) && styles.disabled,
        pressed && styles.pressed,
      ]}
    >
      {busy && <ActivityIndicator color={secondary ? t.colors.emerald : t.colors.surface} />}
      {icon && !busy && (
        <Icon
          name={icon}
          color={brand ? t.colors.brandInk : secondary ? (destructive ? t.colors.destructive : t.colors.text) : t.colors.surface}
        />
      )}
      <Text style={[styles.buttonText, brand && { color: t.colors.brandInk }, secondary && { color: destructive ? t.colors.destructive : t.colors.text }]}>
        {label}
      </Text>
    </Pressable>
  );
}
export function IconButton({
  label,
  icon,
  onPress,
  dark = false,
  disabled = false,
}: {
  label: string;
  icon: IconName;
  onPress: () => void;
  dark?: boolean;
  disabled?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <Pressable
      disabled={disabled}
      accessibilityState={{ disabled }}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.iconButton, focused && styles.focused, disabled && styles.disabled, pressed && styles.pressed]}
    >
      <Icon
        name={icon}
        color={dark ? t.colors.shellText : t.colors.text}
        size={21}
      />
    </Pressable>
  );
}
export function Badge({
  label,
  tone = "neutral",
  compact = false,
}: {
  label: string;
  tone?: "success" | "warning" | "neutral";
  compact?: boolean;
}) {
  const color =
    tone === "success"
      ? t.colors.emerald
      : tone === "warning"
        ? t.colors.amber
        : t.colors.muted;
  const backgroundColor =
    tone === "success"
      ? t.colors.emeraldSoft
      : tone === "warning"
        ? t.colors.amberSoft
        : t.colors.neutral;
  return (
    <View style={[styles.badge, compact && { paddingVertical: 3 }, { backgroundColor }]}>
      {!compact && <View style={[styles.dot, { backgroundColor: color }]} />}
      <Text style={[styles.badgeText, compact && { fontSize: 10 }, { color }]}>{label}</Text>
    </View>
  );
}
export function Section({
  title,
  subtitle,
  trailing,
  children,
}: {
  title: string;
  subtitle?: string;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <View style={styles.grow}>
          <Text accessibilityRole="header" style={styles.sectionTitle}>
            {title}
          </Text>
          {subtitle && <Text style={styles.meta}>{subtitle}</Text>}
        </View>
        {trailing}
      </View>
      {children}
    </View>
  );
}
export const styles = StyleSheet.create({
  grow: { flex: 1, minWidth: 0 },
  row: { flexDirection: "row", alignItems: "center", gap: t.space.md },
  wrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: t.space.sm,
  },
  body: { fontSize: t.font.body, color: t.colors.text, lineHeight: 21 },
  strong: {
    fontSize: t.font.label,
    fontWeight: "600",
    color: t.colors.text,
    lineHeight: 22,
  },
  meta: { fontSize: t.font.caption, color: t.colors.muted, lineHeight: 19 },
  button: {
    minHeight: t.control.height,
    borderWidth: 1,
    borderColor: "transparent",
    paddingHorizontal: t.space.lg,
    paddingVertical: t.space.md,
    borderRadius: t.radius.sm,
    backgroundColor: t.colors.emerald,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: t.space.sm,
  },
  brandButton: { backgroundColor: t.colors.brand },
  secondary: { backgroundColor: t.colors.surface, borderColor: t.colors.border },
  destructive: { backgroundColor: t.colors.destructive, borderColor: t.colors.destructive },
  destructiveSecondary: { backgroundColor: t.colors.surface, borderColor: t.colors.border },
  selected: { backgroundColor: t.colors.emeraldSoft, borderColor: t.colors.emerald },
  focused: { borderColor: t.colors.focus, borderWidth: 2 },
  disabled: { opacity: 0.45 },
  buttonText: {
    fontSize: t.font.body,
    fontWeight: "600",
    color: t.colors.surface,
    flexShrink: 1,
  },
  iconButton: {
    borderRadius: t.radius.sm,
    borderWidth: 1,
    borderColor: "transparent",
    minWidth: t.layout.touch,
    minHeight: t.layout.touch,
    alignItems: "center",
    justifyContent: "center",
  },
  pressed: { opacity: 0.65 },
  badge: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: t.space.sm,
    paddingVertical: t.space.xs,
    borderRadius: t.radius.sm,
    flexShrink: 1,
  },
  badgeText: { fontSize: t.font.caption, fontWeight: "600", flexShrink: 1 },
  dot: { width: 5, height: 5, borderRadius: 3 },
  section: {
    backgroundColor: t.colors.surface,
    borderWidth: t.border,
    borderColor: t.colors.border,
    borderRadius: t.radius.md,
    overflow: "hidden",
  },
  sectionHeader: {
    padding: t.space.lg,
    flexDirection: "row",
    alignItems: "center",
    gap: t.space.sm,
  },
  sectionTitle: {
    fontSize: t.font.section,
    fontWeight: "600",
    color: t.colors.text,
    lineHeight: 26,
  },
});
