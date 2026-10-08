import { useEffect, useState } from "react";
import { Navigator, Slot, router, usePathname } from "expo-router";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { Action, BottomNavigation, ZudeHeader, o } from "../components/operations";
import { useEmployeeIdentity } from "../features/identity/EmployeeIdentityContext";
import { useBusiness } from "../features/business/BusinessContext";
import { design as d } from "../theme/tokens";
import type { Customer } from "../lib/appointments-api";
import { appointmentHandoff } from "./handoff";
import { activeNavigationLabel, primaryTabs, shellDestination, type NativeRoute } from "./items";
import { Sidebar } from "./Sidebar";
import { WorkspaceContext } from "./WorkspaceContext";

export function AppShell() {
  const { business, userId } = useBusiness();
  const pathname = usePathname();
  const { managementRole, identity, sharedMode, lock, recordEmployeeActivity } = useEmployeeIdentity();
  const permissions = sharedMode ? identity?.permissions ?? [] : null;
  const destination = shellDestination(managementRole, pathname, permissions);
  useEffect(() => { if (destination !== pathname) router.replace(destination); }, [destination, pathname]);
  const identityLabel = identity?.employee.name ?? (managementRole === "owner" ? "Owner account" : managementRole === "manager" ? "Manager account" : "My account");
  const [menuOpen, setMenuOpen] = useState(false);
  const [navigationLocked, setNavigationLocked] = useState(false);
  function openMenu() { setMenuOpen(true); }
  function switchUser() { setMenuOpen(false); void lock(); }
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
  // Keep the router mounted even while an unauthorized route is withheld.
  // Slot alone also owns a navigator; withholding it on cold entry would leave
  // router.replace without a ready navigator. Here Slot only renders content.
  return <Navigator initialRouteName="index"><SafeAreaView style={s.safe}>
    <StatusBar style="dark" />
    <ZudeHeader business={business.name} identity={identityLabel} disabled={navigationLocked} onAccount={openMenu} menuOpen={menuOpen} onSwitchUser={sharedMode && identity ? switchUser : undefined} />
    <View style={o.page}>
      <WorkspaceContext.Provider value={{ navigationLocked, setNavigationLocked, startAppointment, appointmentCustomer: handoff.customer }}>
        {destination === pathname
          ? <Slot key={`${userId}:${business.id}:${managementRole}:${identity?.employee.id ?? "account"}`} />
          : <Text style={o.body}>Opening {managementRole === "staff" ? "Today’s Appointments" : "Today"}…</Text>}
      </WorkspaceContext.Provider>
    </View>
    <BottomNavigation tabs={primaryTabs(managementRole)} pathname={pathname} onSelect={select} disabled={navigationLocked} />
    <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
      <View style={s.menuBackdrop}
        onStartShouldSetResponderCapture={() => !recordEmployeeActivity()}
        onMoveShouldSetResponderCapture={() => !recordEmployeeActivity()}>
        <Pressable accessibilityRole="button" accessibilityLabel="Dismiss account menu" onPress={() => setMenuOpen(false)} style={StyleSheet.absoluteFill} />
        <SafeAreaView style={s.menuPosition} pointerEvents="box-none">
          <View style={s.menu}>
            <View style={s.menuHeading}>
              <Text accessibilityRole="header" style={o.section}>Menu</Text>
              <Action quiet label="Close menu" onPress={() => setMenuOpen(false)} />
            </View>
            <Sidebar expanded activeLabel={activeNavigationLabel(pathname)} onSelect={select}
              role={managementRole} businessName={business.name} disabled={navigationLocked} />
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  </SafeAreaView></Navigator>;
}
const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: d.color.canvas },
  menuBackdrop: { flex: 1, backgroundColor: d.color.scrim },
  menuPosition: { flex: 1, minHeight: 0, alignItems: "flex-end" },
  menu: { flex: 1, minHeight: 0, width: "100%", maxWidth: 400, backgroundColor: d.color.surface },
  menuHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: d.space.lg },
});
