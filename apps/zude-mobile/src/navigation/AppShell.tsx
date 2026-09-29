import { useState } from "react";
import { Slot, router, usePathname } from "expo-router";
import { Modal, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { IconButton } from "../components/ui";
import { Brand } from "../components/workspace";
import { useBusiness } from "../features/business/BusinessContext";
import { theme as t } from "../theme/tokens";
import { workspaceLayout } from "../theme/layout";
import type { Customer } from "../lib/appointments-api";
import { appointmentHandoff } from "./handoff";
import { activeNavigationLabel, type NativeRoute } from "./items";
import { WorkspaceContext } from "./WorkspaceContext";
import { Sidebar } from "./Sidebar";

export function AppShell() {
  const { business, userId } = useBusiness();
  const active = activeNavigationLabel(usePathname());
  const { width, height, fontScale } = useWindowDimensions();
  const { persistent } = workspaceLayout(width, height, fontScale);
  const [menuGroup, setMenuGroup] = useState("Operations");
  const [menuOpen, setMenuOpen] = useState(false);
  const [navigationLocked, setNavigationLocked] = useState(false);
  function openMenu(group = "Operations") { setMenuGroup(group); setMenuOpen(true); }
  const [handoff] = useState(appointmentHandoff);
  function select(route: NativeRoute) {
    if (navigationLocked) return;
    setMenuOpen(false); router.replace(route);
  }
  function startAppointment(customer: Customer) {
    if (navigationLocked) return;
    const token = handoff.start(business.id, customer);
    router.replace({ pathname: "/appointments", params: { compose: "new", customer: token } });
  }
  return <SafeAreaView style={s.safe}>
    <StatusBar style="dark" />
    <View style={s.shell}>
      {persistent && <View style={s.sidebar}><Sidebar activeLabel={active} onSelect={select} role={business.role} businessName={business.name} disabled={navigationLocked} onExpand={openMenu} /></View>}
      <View style={s.workspace}>
        {!persistent && <View style={s.topbar}>
          <IconButton label="Open navigation" icon="menu" disabled={navigationLocked} onPress={() => openMenu()} />
          <Brand compact /><Text style={s.context}>Workspace</Text>
        </View>}
        <WorkspaceContext.Provider value={{ navigationLocked, setNavigationLocked, startAppointment, appointmentCustomer: handoff.customer }}>
          <Slot key={`${userId}:${business.id}`} />
        </WorkspaceContext.Provider>
      </View>
    </View>
    <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
      <View style={s.menuBackdrop}><SafeAreaView style={s.menu}>
        <View style={s.menuHeading}><Text style={s.menuText}>{business.name}</Text><IconButton label="Close navigation" icon="x" dark onPress={() => setMenuOpen(false)} /></View>
        <Sidebar expanded initialGroup={menuGroup} activeLabel={active} onSelect={select} role={business.role} businessName={business.name} disabled={navigationLocked} onExpand={openMenu} />
      </SafeAreaView></View>
    </Modal>
  </SafeAreaView>;
}
const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: t.colors.workspace },
  shell: { flex: 1, flexDirection: "row" },
  sidebar: { width: t.layout.sidebar },
  workspace: { flex: 1, minWidth: 0 },
  topbar: { minHeight: 56, paddingHorizontal: t.space.md, flexDirection: "row", alignItems: "center", gap: t.space.md, backgroundColor: t.colors.surface, borderBottomWidth: t.border, borderColor: t.colors.border },
  context: { color: t.colors.muted, fontSize: t.font.caption },
  menuBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)" },
  menu: { flex: 1, width: "100%", maxWidth: 400, backgroundColor: t.colors.shell },
  menuHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: t.space.lg },
  menuText: { color: t.colors.shellText, fontSize: t.font.body, flex: 1 },
});
