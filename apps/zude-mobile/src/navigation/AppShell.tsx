import { useState } from "react";
import {
  Modal,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { Badge, IconButton, styles as ui } from "../components/ui";
import { PreviewDialog } from "../components/PreviewDialog";
import { demoDay } from "../data/demoToday";
import { TodayScreen } from "../features/today/TodayScreen";
import { useBusiness } from "../features/business/BusinessContext";
import { theme as t } from "../theme/tokens";
import type { Preview } from "../types/today";
import { Sidebar } from "./Sidebar";

export function AppShell() {
  const { business } = useBusiness();
  const { width, height, fontScale } = useWindowDimensions();
  const persistent = width >= t.layout.sidebarBreakpoint && fontScale < 1.5;
  const wide =
    width >= t.layout.railBreakpoint && width > height && fontScale < 1.3;
  const compact = width < 650 || fontScale >= 1.3;
  const [menuOpen, setMenuOpen] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  function select(label: string) {
    setMenuOpen(false);
    if (label === "Today") return;
    setPreview({
      title: label,
      detail:
        label === "Lock"
          ? "Lock is a navigation placeholder. In a future milestone it will return to PIN entry without clocking you out. No lock or authentication is active in this demo."
          : `${label} is planned for a future milestone. Today is the only implemented workspace. This demo does not connect to live business data.`,
    });
  }
  const currentUser = (
    <View style={s.user}>
      <View style={s.avatar}>
        <Text style={s.initials}>{demoDay.initials}</Text>
      </View>
      <View style={s.userDetails}>
        <Text style={s.userName}>{demoDay.user}</Text>
        <Badge label="Clocked in" tone="success" />
      </View>
    </View>
  );
  return (
    <SafeAreaView style={s.safe}>
      <StatusBar style="dark" />
      <View style={s.shell}>
        {persistent && (
          <View style={s.sidebar}>
            <Sidebar onSelect={select} businessName={business.name} timezone={business.timezone} />
          </View>
        )}
        <View style={s.workspace}>
          {!wide && (
            <View style={[s.topbar, compact && s.compactTopbar]}>
              <View style={ui.row}>
                {!persistent && (
                  <IconButton
                    label="Open navigation"
                    icon="menu"
                    onPress={() => setMenuOpen(true)}
                  />
                )}
                {!persistent && <Text style={s.wordmark}>ZUDE</Text>}
              </View>
              {currentUser}
            </View>
          )}
          <TodayScreen
            wide={wide}
            compact={compact}
            currentUser={wide ? currentUser : undefined}
            onPreview={setPreview}
          />
        </View>
      </View>
      <Modal
        visible={preview !== null || (menuOpen && !persistent)}
        transparent
        animationType="fade"
        onRequestClose={() => {
          setMenuOpen(false);
          setPreview(null);
        }}
      >
        {preview ? (
          <PreviewDialog preview={preview} onClose={() => setPreview(null)} />
        ) : (
          <SafeAreaView style={s.menuSafe}>
            <View style={s.menuHeader}>
              <Text style={s.menuTitle}>Navigation</Text>
              <IconButton
                dark
                label="Close navigation"
                icon="x"
                onPress={() => setMenuOpen(false)}
              />
            </View>
            <Sidebar onSelect={select} businessName={business.name} timezone={business.timezone} />
          </SafeAreaView>
        )}
      </Modal>
    </SafeAreaView>
  );
}
const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: t.colors.workspace },
  shell: { flex: 1, flexDirection: "row" },
  sidebar: { width: t.layout.sidebar },
  workspace: { flex: 1, minWidth: 0 },
  topbar: {
    minHeight: 56,
    paddingHorizontal: t.space.xl,
    paddingVertical: t.space.sm,
    backgroundColor: t.colors.surface,
    borderBottomWidth: t.border,
    borderBottomColor: t.colors.border,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: t.space.md,
    flexWrap: "wrap",
  },
  compactTopbar: { paddingHorizontal: t.space.lg },
  wordmark: {
    color: t.colors.brand,
    fontSize: 20,
    fontWeight: "800",
    letterSpacing: 1.5,
  },
  user: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: t.space.md,
  },
  userDetails: { gap: t.space.xs },
  avatar: {
    width: 34,
    height: 34,
    backgroundColor: t.colors.neutral,
    borderRadius: t.radius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  initials: { color: t.colors.muted, fontSize: 11, fontWeight: "600" },
  userName: {
    color: t.colors.text,
    fontSize: t.font.caption,
    fontWeight: "600",
  },
  menuSafe: { flex: 1, backgroundColor: t.colors.shell },
  menuHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: t.space.xl,
  },
  menuTitle: {
    color: t.colors.shellText,
    fontSize: t.font.body,
    fontWeight: "600",
  },
});
