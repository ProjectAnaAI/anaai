import { useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Image, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps, useWindowDimensions } from "react-native";
import { theme as t } from "../theme/tokens";
import { workspaceLayout } from "../theme/layout";
import { Button, Icon, styles as ui, type IconName } from "./ui";

export function Brand({ compact = false }: { compact?: boolean; dark?: boolean }) {
  return <View style={s.brand} accessibilityLabel="ZUDE">
    <Image source={require("../../assets/brand/zu-logo.png")} accessibilityLabel="ZUDE logo" resizeMode="contain" style={{ width: compact ? 32 : 48, height: compact ? 28 : 40 }} />
  </View>;
}
export function Field({ label, search = false, style, ...props }: TextInputProps & { label: string; search?: boolean }) {
  const [focused, setFocused] = useState(false);
  return <View style={[s.field, focused && s.fieldFocus, props.editable === false && ui.disabled, style]}>
    {search && <Icon name="search" size={17} />}
    <TextInput {...props} accessibilityLabel={props.accessibilityLabel || label} placeholderTextColor={t.colors.muted}
      onFocus={(event) => { setFocused(true); props.onFocus?.(event); }}
      onBlur={(event) => { setFocused(false); props.onBlur?.(event); }} style={s.input} />
  </View>;
}
export function WorkspaceHeader({ title, business, subtitle, search, action, leading, operational = false }: {
  title: string; business: string; subtitle?: string; search?: ReactNode; action?: ReactNode; leading?: ReactNode; operational?: boolean;
}) {
  const { width, height, fontScale } = useWindowDimensions();
  const { compact, workspaceWidth } = workspaceLayout(width, height, fontScale);
  const headerStacks = !!search && (compact || workspaceWidth < 880);
  if (operational) return <View style={s.operationalHeader}>
    <View style={[s.headerRow, !search && { justifyContent: "space-between" }]}>
      <View style={[s.operationalIdentity, !headerStacks && !!search && { flexGrow: 0, flexShrink: 0, flexBasis: 316 }]}>
        <Text style={s.businessName}>{business}</Text>
        <View style={s.pageContext}><Text accessibilityRole="header" style={ui.strong}>{title}</Text>{!!subtitle && <Text style={ui.meta}>{subtitle}</Text>}</View>
      </View>
      {!headerStacks && <>{search && <View style={s.operationalSearch}>{search}</View>}{search && <View style={ui.grow} />}{action}</>}
    </View>
    {headerStacks && <View style={[s.headerRow, { flexWrap: "wrap", gap: t.space.sm }]}><View style={[ui.grow, { minWidth: 140 }]}>{search}</View>{action}</View>}
  </View>;
  return <View style={s.header}>
    <View style={[s.headerRow, compact && { flexWrap: "wrap" }]}>
      {leading}
      <View style={ui.grow}>
        <Text style={s.context}>{business}</Text>
        <Text accessibilityRole="header" style={s.title}>{title}</Text>
        {!!subtitle && <Text style={ui.meta}>{subtitle}</Text>}
      </View>
      {!compact && search && <View style={s.headerSearch}>{search}</View>}
      {!(compact && search) && action}
    </View>
    {compact && search && <View style={[s.headerRow, { flexWrap: "wrap", gap: t.space.sm }]}>
      <View style={[ui.grow, { minWidth: 140 }]}>{search}</View>{action}
    </View>}
  </View>;
}
export function PaneTitle({ title, detail, action, dark = false }: { title: string; detail?: string; action?: ReactNode; dark?: boolean }) {
  return <View style={s.paneTitle}><View style={ui.grow}>
    <Text accessibilityRole="header" style={[s.eyebrow, dark && { color: t.colors.timelineText }]}>{title}</Text>
    {!!detail && <Text style={[ui.meta, dark && { color: t.colors.timelineMuted }]}>{detail}</Text>}
  </View>{action}</View>;
}
// Landscape: independent scroll regions keep context and the action reachable.
// Stacked: one scroll region and a docked action, never nested vertical lists.
export function SplitWorkspace({ main, rail, footer, focusRailOnStack, operational = false }: { main: ReactNode; rail?: ReactNode; footer?: ReactNode; focusRailOnStack?: string | null; operational?: boolean }) {
  const { width, height, fontScale } = useWindowDimensions();
  const layout = workspaceLayout(width, height, fontScale);
  const stackedScroll = useRef<ScrollView>(null);
  useEffect(() => {
    if (!layout.split && focusRailOnStack) stackedScroll.current?.scrollTo({ y: 0, animated: false });
  }, [layout.split, focusRailOnStack]);
  if (!layout.split) return <View style={s.fill}>
    <ScrollView ref={stackedScroll} keyboardShouldPersistTaps="handled" contentContainerStyle={s.stackedContent}>
      {!!focusRailOnStack && rail && <View style={[s.stackedRail, operational && s.operationalRail]}>{rail}</View>}
      <View style={[s.main, operational && s.operationalMain]}>{main}</View>
      {!focusRailOnStack && rail && <View style={[s.stackedRail, operational && s.operationalRail]}>{rail}</View>}
    </ScrollView>
    {footer && <View style={s.footer}>{footer}</View>}
  </View>;
  return <View style={s.columns}>
    <ScrollView style={[s.mainScroll, operational && { backgroundColor: t.colors.timeline }]} keyboardShouldPersistTaps="handled" contentContainerStyle={[s.main, operational && [s.operationalMain, { flexGrow: 1 }]]}>{main}</ScrollView>
    {(rail || footer) && <View style={[s.rail, { width: operational && layout.railWidth === t.layout.contextRail ? t.layout.todayRail : layout.railWidth }, operational && s.operationalRail]}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={s.railContent}>{rail}</ScrollView>
      {footer && <View style={s.footer}>{footer}</View>}
    </View>}
  </View>;
}
export function Feedback({ title, detail, kind = "empty", retry, dark = false }: {
  title: string; detail?: string; kind?: "empty" | "error" | "loading"; retry?: () => void; dark?: boolean;
}) {
  return <View style={s.feedback} accessibilityLiveRegion="polite">
    {kind === "loading" ? <ActivityIndicator color={t.colors.emerald} /> : <Icon name={kind === "error" ? "alert-circle" : "calendar"} color={kind === "error" ? t.colors.destructive : t.colors.muted} size={24} />}
    <Text style={[ui.strong, dark && { color: t.colors.timelineText }]}>{title}</Text>
    {!!detail && <Text style={[ui.body, s.centered, dark && { color: t.colors.timelineMuted }]}>{detail}</Text>}
    {retry && <Button label="Retry" secondary onPress={retry} />}
  </View>;
}
export function DetailLine({ icon, label, value }: { icon: IconName; label: string; value: string }) {
  return <View style={s.detailLine}><Icon name={icon} /><View style={ui.grow}>
    <Text style={ui.meta}>{label}</Text><Text style={ui.strong}>{value}</Text>
  </View></View>;
}
export const workspaceStyles = StyleSheet.create({
  page: { flex: 1, minWidth: 0, backgroundColor: t.colors.workspace },
  toolbar: { paddingHorizontal: t.space.xl, paddingVertical: t.space.sm, borderBottomWidth: t.border, borderColor: t.colors.border, backgroundColor: t.colors.surface, gap: t.space.sm },
  railSection: { gap: t.space.md, paddingVertical: t.space.lg, borderBottomWidth: t.border, borderColor: t.colors.border },
  heading: { fontSize: t.font.section, fontWeight: "600", color: t.colors.text },
});
const s = StyleSheet.create({
  fill: { flex: 1, minWidth: 0 },
  operationalHeader: { backgroundColor: t.colors.warmSurface, paddingHorizontal: t.space.xl, paddingVertical: 10, gap: t.space.sm, minHeight: 68, borderBottomWidth: t.border, borderColor: t.colors.border },
  operationalIdentity: { flexGrow: 1, flexShrink: 1, flexBasis: 0, maxWidth: 316, minWidth: 0, flexDirection: "row", alignItems: "center", gap: t.space.lg },
  businessName: { flex: 1, maxWidth: 140, fontSize: t.font.label, fontWeight: "700", color: t.colors.text },
  pageContext: { flex: 1, borderLeftWidth: t.border, borderColor: t.colors.border, paddingLeft: t.space.lg },
  operationalSearch: { width: 260 },
  operationalMain: { backgroundColor: t.colors.timeline, paddingTop: t.space.md },
  operationalRail: { backgroundColor: t.colors.warmSurface },
  brand: { flexDirection: "row", alignItems: "center", gap: t.space.md },
  mark: { width: t.control.mark, height: t.control.mark, alignItems: "center", justifyContent: "center" },
  wordmark: { fontSize: t.font.brand, fontWeight: "800", letterSpacing: -1, color: t.colors.text },
  field: { flexDirection: "row", alignItems: "center", gap: t.space.sm, minHeight: t.control.height, borderWidth: 1, borderColor: t.colors.border, borderRadius: t.radius.sm, backgroundColor: t.colors.surface, paddingHorizontal: t.space.md },
  fieldFocus: { borderColor: t.colors.focus },
  input: { flex: 1, minWidth: 0, minHeight: t.control.height, color: t.colors.text, fontSize: t.font.body, paddingVertical: t.space.sm },
  header: { paddingHorizontal: t.space.xl, paddingVertical: t.space.md, gap: t.space.sm, borderBottomWidth: t.border, borderColor: t.colors.border, backgroundColor: t.colors.surface },
  headerRow: { flexDirection: "row", alignItems: "center", gap: t.space.lg },
  headerSearch: { width: 205 },
  context: { color: t.colors.muted, fontSize: t.font.caption, fontWeight: "500", marginBottom: t.space.xs },
  title: { fontSize: t.font.title, fontWeight: "700", letterSpacing: -0.7, color: t.colors.text },
  columns: { flex: 1, flexDirection: "row", minWidth: 0 },
  mainScroll: { flex: 1, minWidth: 0, backgroundColor: t.colors.surface },
  main: { paddingHorizontal: t.space.xl, paddingBottom: t.space.xl, minWidth: 0, backgroundColor: t.colors.surface },
  rail: { backgroundColor: t.colors.rail, borderLeftWidth: t.border, borderColor: t.colors.border },
  railContent: { paddingHorizontal: t.space.lg, paddingBottom: t.space.lg },
  stackedContent: { flexGrow: 1 },
  stackedRail: { backgroundColor: t.colors.rail, paddingHorizontal: t.space.xl, paddingBottom: t.space.lg, borderTopWidth: t.border, borderColor: t.colors.border },
  footer: { padding: t.space.lg, gap: t.space.sm, borderTopWidth: t.border, borderColor: t.colors.border, backgroundColor: t.colors.surface },
  paneTitle: { flexDirection: "row", alignItems: "center", gap: t.space.sm, paddingVertical: t.space.lg },
  eyebrow: { color: t.colors.muted, fontSize: 11, fontWeight: "700", letterSpacing: 1.1, textTransform: "uppercase" },
  feedback: { paddingVertical: t.space.xxl, gap: t.space.md, alignItems: "center" },
  centered: { textAlign: "center", color: t.colors.muted },
  detailLine: { flexDirection: "row", gap: t.space.md, alignItems: "center", paddingVertical: t.space.sm },
});
