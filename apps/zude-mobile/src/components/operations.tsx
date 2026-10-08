import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle, type AccessibilityState } from "react-native";
import { design as d } from "../theme/tokens";
import type { NativeRoute } from "../navigation/items";

export function Action({ label, onPress, disabled = false, selected = false, quiet = false, role = "button", children, style, accessibilityState }: {
  label: string; onPress: () => void; disabled?: boolean; selected?: boolean; quiet?: boolean; role?: "button" | "tab"; children?: ReactNode; style?: StyleProp<ViewStyle>; accessibilityState?: AccessibilityState;
}) {
  const [focused, setFocused] = useState(false);
  return <Pressable accessibilityRole={role} accessibilityLabel={label} accessibilityState={{ ...accessibilityState, disabled, selected }}
    aria-expanded={accessibilityState?.expanded} aria-disabled={disabled} aria-selected={role === "tab" ? selected : undefined}
    disabled={disabled} onPress={onPress} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
    style={({ pressed }) => [o.action, quiet && o.quiet, selected && o.selected, pressed && (quiet ? o.pressed : o.primaryPressed), focused && o.focused, disabled && o.disabled, style]}>
    {children ?? <Text style={[o.actionText, quiet && o.quietText]}>{label}</Text>}
  </Pressable>;
}
export function ZudeHeader({ business, identity, onAccount, disabled, menuOpen = false, onSwitchUser }: {
  business: string; identity: string; onAccount: () => void; disabled: boolean; menuOpen?: boolean; onSwitchUser?: () => void;
}) {
  return <View style={o.header}>
    <Text numberOfLines={2} style={o.business}>{business}</Text>
    <View style={o.identityActions}>
      <Action quiet label={`${identity} · Open account menu`} disabled={disabled} onPress={onAccount}
        accessibilityState={{ expanded: menuOpen }} style={o.account}>
        <Text numberOfLines={2} style={o.identity}>{identity}</Text>
        <Text accessibilityElementsHidden style={o.chevron}>{"▾"}</Text>
      </Action>
      {onSwitchUser && <Action quiet label="Switch User" onPress={onSwitchUser} />}
    </View>
  </View>;
}
export function BottomNavigation({ tabs, pathname, onSelect, disabled }: {
  tabs: readonly { label: string; route: NativeRoute }[]; pathname: string; onSelect: (route: NativeRoute) => void; disabled: boolean;
}) {
  return <View accessibilityRole="tablist" style={o.navigation}>{tabs.map(tab =>
    <Action key={tab.route} label={tab.label} role="tab" quiet disabled={disabled} selected={pathname === tab.route}
      onPress={() => onSelect(tab.route)} style={o.tab}>
      <Text style={[o.tabText, pathname === tab.route && o.tabSelected]}>{tab.label}</Text>
    </Action>)}</View>;
}
export function SectionHeader({ title, detail, action }: { title: string; detail?: string; action?: ReactNode }) {
  return <View style={o.sectionHeading}><View style={o.grow}><Text accessibilityRole="header" style={o.section}>{title}</Text>
    {detail && <Text style={o.meta}>{detail}</Text>}</View>{action}</View>;
}
export function Surface({ children }: { children: ReactNode }) { return <View style={o.surface}>{children}</View>; }
export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <View style={o.empty}><Text style={o.rowTitle}>{title}</Text><Text style={o.body}>{detail}</Text></View>;
}
export function AvatarInitials({ name }: { name: string }) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const initials = [parts[0]?.[0], parts.length > 1 ? parts[parts.length - 1]?.[0] : ""].join("").toUpperCase();
  return <View accessibilityElementsHidden style={o.avatar}><Text style={o.initials}>{initials}</Text></View>;
}
export type StatusTone = "working" | "break" | "off";
export function StatusIndicator({ label, tone }: { label: string; tone: StatusTone }) {
  return <Text style={[o.status, tone === "working" ? o.working : tone === "break" ? o.break : o.off]}>{label}</Text>;
}
export function StatusSummary({ items }: { items: { label: string; count: number; selected: boolean; onPress: () => void }[] }) {
  return <View style={o.summary}>{items.map(item => <Action key={item.label} quiet label={`${item.count} ${item.label}`} selected={item.selected} onPress={item.onPress} style={o.summaryItem}>
    <Text style={o.count}>{item.count}</Text><Text style={o.body}>{item.label}</Text>
  </Action>)}</View>;
}
export function EmployeeStatusRow({ name, status, tone, context, elapsed, evidence, onPress }: {
  name: string; status: string; tone: StatusTone; context: string; elapsed?: string; evidence?: string; onPress: () => void;
}) {
  return <Action quiet label={`${name}, ${status}. View time`} onPress={onPress} style={o.employee}>
    <AvatarInitials name={name} /><View style={o.grow}><Text style={o.rowTitle}>{name}</Text>
      <Text style={o.meta}>{context}</Text>{evidence && <Text style={o.evidence}>{evidence}</Text>}</View>
    <View style={o.rowTiming}><StatusIndicator label={status} tone={tone} />{elapsed && <Text style={o.meta}>{elapsed}</Text>}</View>
  </Action>;
}
export function AttentionRow({ name, detail, label, onPress }: { name: string; detail: string; label: string; onPress: () => void }) {
  return <Action quiet label={label} onPress={onPress} style={o.attention}>
    <Text style={o.rowTitle}>{name}</Text><Text numberOfLines={3} style={o.body}>{detail}</Text>
    <Text style={o.evidence}>{label}</Text>
  </Action>;
}
export const o = StyleSheet.create({
  page: { flex: 1, minWidth: 0, backgroundColor: d.color.canvas },
  header: { flexDirection: "row", alignItems: "center", gap: d.space.lg, paddingHorizontal: d.space.xl, paddingVertical: d.space.sm, minHeight: 76, borderBottomWidth: 1, borderColor: d.color.border, backgroundColor: d.color.canvas },
  business: { flex: 1, minWidth: 0, color: d.color.textPrimary, fontSize: d.type.section, fontWeight: "600" },
  identityActions: { maxWidth: "60%", flexDirection: "row", alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end", gap: d.space.xs, flexShrink: 1 },
  account: { flexDirection: "row", gap: d.space.sm, flexShrink: 1, minWidth: d.control.minimum },
  chevron: { color: d.color.actionPrimary, fontSize: d.type.section },
  identity: { flexShrink: 1, color: d.color.textPrimary, fontSize: d.type.supporting },
  navigation: { flexDirection: "row", borderTopWidth: 1, borderColor: d.color.border, paddingHorizontal: d.space.sm, paddingVertical: d.space.sm, backgroundColor: d.color.surface },
  tab: { flex: 1, minWidth: 0, minHeight: d.control.navigation, borderRadius: d.radius.sm, paddingHorizontal: d.space.xs },
  tabText: { color: d.color.textSecondary, fontSize: d.type.body, textAlign: "center" },
  tabSelected: { color: d.color.actionPrimary, fontWeight: "600" },
  action: { minHeight: d.control.primary, paddingHorizontal: d.space.lg, paddingVertical: d.space.sm, alignItems: "center", justifyContent: "center", borderRadius: d.radius.sm, borderWidth: 2, borderColor: "transparent", backgroundColor: d.color.actionPrimary },
  actionText: { fontSize: d.type.body, color: d.color.onAction, fontWeight: "600" },
  quiet: { backgroundColor: "transparent" }, quietText: { color: d.color.actionPrimary },
  selected: { backgroundColor: d.color.selection }, pressed: { backgroundColor: d.color.surfaceSubtle },
  primaryPressed: { backgroundColor: d.color.actionPrimaryPressed },
  focused: { borderColor: d.color.focus }, disabled: { opacity: 0.5 },
  sectionHeading: { flexDirection: "row", alignItems: "center", gap: d.space.sm, marginBottom: d.space.md },
  section: { color: d.color.textPrimary, fontSize: d.type.section, fontWeight: "600" },
  grow: { flex: 1, minWidth: 0 }, surface: { backgroundColor: d.color.surface, borderRadius: d.radius.md, overflow: "hidden" },
  empty: { padding: d.space.xl, gap: d.space.sm },
  body: { color: d.color.textSecondary, fontSize: d.type.body }, meta: { color: d.color.textMuted, fontSize: d.type.metadata, lineHeight: 20, fontVariant: ["tabular-nums"] },
  rowTitle: { color: d.color.textPrimary, fontSize: d.type.row, fontWeight: "500", flexShrink: 1 },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: d.color.surfaceSubtle, justifyContent: "center", alignItems: "center" },
  initials: { fontSize: d.type.supporting, color: d.color.textSecondary, fontWeight: "600" },
  status: { fontSize: d.type.supporting, fontWeight: "500" }, working: { color: d.color.statusWorking }, break: { color: d.color.statusBreak }, off: { color: d.color.statusOff },
  summary: { flexDirection: "row", gap: d.space.sm, marginVertical: d.space.lg },
  summaryItem: { flex: 1, minWidth: 0, alignItems: "flex-start", backgroundColor: d.color.surface, padding: d.space.lg, gap: d.space.xs },
  count: { color: d.color.textPrimary, fontSize: d.type.display, fontVariant: ["tabular-nums"] },
  employee: { flexDirection: "row", alignItems: "center", gap: d.space.md, minHeight: 88, paddingHorizontal: d.space.lg, paddingVertical: d.space.md, borderBottomWidth: 1, borderBottomColor: d.color.divider, borderRadius: 0 },
  rowTiming: { maxWidth: "35%", gap: d.space.xs, alignItems: "flex-end" }, evidence: { fontSize: d.type.supporting, color: d.color.statusAttention },
  attention: { alignItems: "flex-start", gap: d.space.sm, padding: d.space.lg, borderBottomWidth: 1, borderBottomColor: d.color.divider, borderRadius: 0 },
});
