import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Icon, type IconName, styles as ui } from "../components/ui";
import { theme as t } from "../theme/tokens";

type NavItem = { label: string; icon: IconName };
const groups: { title: string; items: NavItem[] }[] = [
  {
    title: "OPERATIONS",
    items: [
      { label: "Today", icon: "grid" },
      { label: "Appointments", icon: "calendar" },
      { label: "Customers", icon: "users" },
      { label: "Services", icon: "scissors" },
    ],
  },
  {
    title: "MY WORK",
    items: [
      { label: "Time Clock", icon: "clock" },
      { label: "My Time", icon: "watch" },
    ],
  },
  {
    title: "MANAGE",
    items: [
      { label: "Team", icon: "user-check" },
      { label: "Timesheets", icon: "clipboard" },
      { label: "Corrections", icon: "edit-3" },
      { label: "Reports", icon: "bar-chart-2" },
      { label: "Analytics", icon: "trending-up" },
    ],
  },
  {
    title: "ANA AI",
    items: [
      { label: "Voice Assistant", icon: "mic" },
      { label: "Calls", icon: "phone" },
    ],
  },
];
export function Sidebar({
  onSelect,
  activeLabel,
  businessName,
  timezone,
}: {
  activeLabel: string;
  onSelect: (label: string) => void;
  businessName: string;
  timezone: string;
}) {
  function item({ label, icon }: NavItem) {
    const active = label === activeLabel;
    return (
      <Pressable
        key={label}
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
        accessibilityLabel={["Today", "Appointments"].includes(label) ? label : `${label}, coming soon`}
        onPress={() => onSelect(label)}
        style={({ pressed }) => [
          s.item,
          active && s.active,
          pressed && ui.pressed,
        ]}
      >
        <Icon
          name={icon}
          color={active ? "#78DDB3" : t.colors.shellMuted}
          size={17}
        />
        <Text style={[s.label, active && s.activeLabel]}>{label}</Text>
        {active && <View style={s.activeDot} />}
      </Pressable>
    );
  }
  return (
    <View style={s.sidebar}>
      <View style={s.brandBlock}>
        <Text style={s.brand}>
          ZUDE<Text style={s.brandDot}>.</Text>
        </Text>
        <Text style={s.business}>{businessName}</Text>
        <Text style={s.location}>{timezone}</Text>
      </View>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={s.groups}
      >
        {groups.map((group) => (
          <View key={group.title}>
            <Text style={s.groupTitle}>{group.title}</Text>
            {group.items.map(item)}
          </View>
        ))}
      </ScrollView>
      <View style={s.bottom}>
        {item({ label: "Settings", icon: "settings" })}
        {item({ label: "Lock", icon: "lock" })}
      </View>
    </View>
  );
}
const s = StyleSheet.create({
  sidebar: { flex: 1, backgroundColor: t.colors.shell },
  brandBlock: {
    paddingHorizontal: t.space.xl,
    paddingTop: t.space.xl,
    paddingBottom: t.space.lg,
  },
  brand: {
    color: t.colors.brand,
    fontSize: t.font.brand,
    fontWeight: "800",
    letterSpacing: 2,
  },
  brandDot: { color: t.colors.surface },
  business: {
    color: t.colors.shellText,
    fontSize: t.font.body,
    fontWeight: "600",
    marginTop: t.space.lg,
  },
  location: { color: t.colors.shellMuted, fontSize: 11, marginTop: t.space.xs },
  groups: {
    paddingHorizontal: t.space.md,
    paddingBottom: t.space.lg,
    gap: t.space.lg,
  },
  groupTitle: {
    color: t.colors.shellMuted,
    fontSize: 10,
    fontWeight: "600",
    letterSpacing: 1.3,
    marginLeft: t.space.md,
    marginBottom: t.space.xs,
  },
  item: {
    minHeight: t.layout.touch,
    flexDirection: "row",
    alignItems: "center",
    gap: t.space.md,
    paddingHorizontal: t.space.md,
    paddingVertical: t.space.sm,
    borderRadius: t.radius.sm,
  },
  active: { backgroundColor: "#18372C" },
  label: { color: t.colors.shellText, fontSize: 13, flex: 1 },
  activeLabel: { color: "#A1ECCB", fontWeight: "600" },
  activeDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: t.colors.emeraldBright,
  },
  bottom: {
    borderTopWidth: t.border,
    borderColor: t.colors.shellRaised,
    padding: t.space.md,
  },
});
