import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { Preview } from "../types/today";
import { theme as t } from "../theme/tokens";
import { Badge, Button, styles as ui } from "./ui";

export function PreviewDialog({
  preview,
  onClose,
}: {
  preview: Preview | null;
  onClose: () => void;
}) {
  return (
    <SafeAreaView style={s.backdrop}>
      <View accessibilityViewIsModal style={s.dialog}>
        <ScrollView contentContainerStyle={s.content}>
          <Badge label="Milestone 01 · Demo preview" />
          <Text accessibilityRole="header" style={s.title}>
            {preview?.title}
          </Text>
          <Text style={ui.body}>{preview?.detail}</Text>
          <Text style={ui.meta}>
            Local demo only. No records have been changed.
          </Text>
          <Button label="Back to Today" onPress={onClose} />
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}
const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(16,18,20,0.55)",
    justifyContent: "center",
    alignItems: "center",
    padding: t.space.xl,
  },
  dialog: {
    width: "100%",
    maxWidth: 440,
    maxHeight: "100%",
    backgroundColor: t.colors.surface,
    borderRadius: t.radius.md,
  },
  content: { padding: t.space.xl, gap: t.space.lg },
  title: { fontSize: 22, fontWeight: "600", color: t.colors.text },
});
