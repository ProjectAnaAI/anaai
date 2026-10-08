import { useEmployeeIdentity } from "../features/identity/EmployeeIdentityContext";
import { useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Icon, styles as ui } from "../components/ui";
import { Brand } from "../components/workspace";
import type { BusinessRole } from "../lib/today-api";
import { design as d, theme as t } from "../theme/tokens";
import { visibleNavigation, type NativeRoute, type NavItem, capabilityLabel } from "./items";

export function Sidebar({ activeLabel, onSelect, expanded = false, disabled = false, role, businessName, onExpand, initialGroup }: {
  activeLabel: string; onSelect: (route: NativeRoute) => void;
  expanded?: boolean; disabled?: boolean; role: BusinessRole; businessName: string; onExpand?: (group: string) => void; initialGroup?: string;
}) {
  const identity = useEmployeeIdentity();
  const scroll = useRef<ScrollView>(null);
  const [focused, setFocused] = useState<string | null>(null);
  function itemView(item: NavItem, utility = false) {
    const unavailable = item.state !== "AVAILABLE_NATIVE";
    const selected = item.label === activeLabel;
    return <Pressable key={item.label} accessibilityRole="button" accessibilityLabel={`${item.label}${unavailable ? ", unavailable on this device" : ""}`}
      accessibilityState={{ selected, disabled: disabled || unavailable }} disabled={disabled || unavailable}
      onFocus={() => setFocused(item.label)} onBlur={() => setFocused(null)} onPress={() => { if (disabled || unavailable) return; if (item.label === "Lock") { void identity.lock(); return; } if (item.route) onSelect(item.route); }}
      style={({ pressed }) => [s.item, expanded && s.expanded, utility && s.utility, selected && s.active, expanded && selected && s.expandedActive,
        focused === item.label && s.focused, expanded && focused === item.label && s.expandedFocused, (disabled || unavailable) && ui.disabled, pressed && ui.pressed]}>
      <Icon name={item.icon} color={expanded ? d.color.textSecondary : selected ? t.colors.brandText : t.colors.shellMuted} size={20} />
      {!utility && <Text style={[s.label, expanded && s.expandedLabel, selected && s.selectedText, expanded && selected && s.expandedSelectedText]}>{item.label === "Appointments" && !expanded ? "Appts" : item.label}</Text>}
      {expanded && unavailable && <Text style={s.badge}>{capabilityLabel(item.state)}</Text>}
    </Pressable>;
  }
  return <View style={[s.sidebar, expanded && s.drawer]}>
    {!expanded && <View style={s.brand}><Brand compact={!expanded} dark />{expanded && <Text style={s.business}>{businessName}</Text>}</View>}
    <ScrollView ref={scroll} contentContainerStyle={[s.items, expanded && s.drawerItems]}>
      {visibleNavigation(role, identity.sharedMode ? identity.identity?.permissions ?? [] : null).filter((g) => expanded || g.title === "Operations" || g.title === "My Work").map((group) => <View key={group.title} style={[s.group, expanded && s.drawerGroup]} onLayout={(event) => {
        if (expanded && initialGroup === group.title) scroll.current?.scrollTo({ y: event.nativeEvent.layout.y, animated: false });
      }}>
        {expanded ? <><Text style={s.groupTitle}>{group.title}</Text>{group.items.map((item) => itemView(item))}</>
          : group.items.map((item) => itemView(item))}
      </View>)}
      {!expanded && <Pressable accessibilityRole="button" accessibilityLabel="Browse ZUDE" disabled={disabled} accessibilityState={{ disabled }}
        onPress={() => onExpand?.("Operations")} onFocus={() => setFocused("more")} onBlur={() => setFocused(null)}
        style={({ pressed }) => [s.item, focused === "more" && s.focused, pressed && ui.pressed, disabled && ui.disabled]}>
        <Icon name="more-horizontal" color={t.colors.shellMuted} size={22} /><Text style={s.label}>More</Text>
      </Pressable>}
      {expanded && <Text style={s.legend}>Dimmed destinations are not available on this device.</Text>}
    </ScrollView>
    {!expanded && <View style={s.bottom}>{itemView({ label: "Settings", icon: "settings", state: "EXISTING_WEB_CAPABILITY", webRoute: "/settings" }, true)}{itemView({ label: "Lock", icon: "lock", state: "AVAILABLE_NATIVE", route: "/device" }, true)}</View>}
  </View>;
}
const s = StyleSheet.create({
  drawer: { backgroundColor: d.color.canvas },
  drawerItems: { paddingHorizontal: d.space.lg, gap: d.space.lg },
  drawerGroup: { borderTopWidth: 1, borderTopColor: d.color.divider, paddingTop: d.space.sm, gap: d.space.xs },
  expandedActive: { backgroundColor: d.color.selection },
  expandedFocused: { borderColor: d.color.focus },
  expandedSelectedText: { color: d.color.textPrimary, fontWeight: "600" },
  badge: { color: d.color.textSecondary, fontSize: d.type.metadata, backgroundColor: d.color.surfaceSubtle, paddingHorizontal: d.space.sm, paddingVertical: d.space.xs, borderRadius: d.radius.sm },
  sidebar: { flex: 1, minHeight: 0, backgroundColor: t.colors.shell },
  brand: { minHeight: 64, alignItems: "center", justifyContent: "center", paddingVertical: t.space.md, gap: t.space.sm },
  business: { color: t.colors.shellMuted, fontSize: 10, lineHeight: 14, textAlign: "center" },
  items: { paddingHorizontal: t.space.xs, paddingBottom: t.space.lg, gap: t.space.sm },
  group: { gap: t.space.xs },
  groupTitle: { color: d.color.textSecondary, fontSize: 11, padding: t.space.sm, textTransform: "uppercase", letterSpacing: 1 },
  item: { minHeight: 52, minWidth: t.layout.touch, borderWidth: 1, borderColor: "transparent", borderRadius: t.radius.sm, alignItems: "center", justifyContent: "center", paddingVertical: t.space.sm, gap: t.space.xs },
  expanded: { backgroundColor: d.color.surface, minHeight: d.control.primary, flexDirection: "row", justifyContent: "flex-start", paddingHorizontal: t.space.lg, gap: t.space.md },
  active: { backgroundColor: t.colors.warmSurface },
  focused: { borderColor: t.colors.brand },
  label: { color: t.colors.shellMuted, fontSize: 9, fontWeight: "500" },
  expandedLabel: { flex: 1, minWidth: 0, fontSize: d.type.body, lineHeight: 22, color: d.color.textPrimary },
  selectedText: { color: t.colors.brandText, fontWeight: "600" },
  utility: { minHeight: t.layout.touch },
  bottom: { paddingHorizontal: t.space.xs, paddingBottom: t.space.lg, gap: t.space.xs },
  legend: { color: d.color.textSecondary, fontSize: t.font.caption, lineHeight: 19, padding: t.space.lg },
});
