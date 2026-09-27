import type { ComponentProps, ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
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
}: {
  label: string;
  onPress: () => void;
  icon?: IconName;
  secondary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        secondary && styles.secondary,
        pressed && styles.pressed,
      ]}
    >
      {icon && (
        <Icon
          name={icon}
          color={secondary ? t.colors.text : t.colors.surface}
        />
      )}
      <Text style={[styles.buttonText, secondary && { color: t.colors.text }]}>
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
}: {
  label: string;
  icon: IconName;
  onPress: () => void;
  dark?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
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
}: {
  label: string;
  tone?: "success" | "warning" | "neutral";
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
    <View style={[styles.badge, { backgroundColor }]}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[styles.badgeText, { color }]}>{label}</Text>
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
    minHeight: t.layout.touch,
    paddingHorizontal: t.space.lg,
    paddingVertical: t.space.md,
    borderRadius: t.radius.sm,
    backgroundColor: t.colors.emerald,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: t.space.sm,
  },
  secondary: { backgroundColor: t.colors.neutral },
  buttonText: {
    fontSize: t.font.body,
    fontWeight: "600",
    color: t.colors.surface,
    flexShrink: 1,
  },
  iconButton: {
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
