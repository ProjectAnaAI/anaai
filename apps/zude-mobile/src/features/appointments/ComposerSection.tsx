import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Icon, styles as ui } from "../../components/ui";
import { theme as t } from "../../theme/tokens";

export function ComposerSection({ number, title, complete, value, trailing, children }: {
  number: number; title: string; complete?: boolean; value?: string; trailing?: ReactNode; children?: ReactNode;
}) {
  return <View style={s.section}>
    <View style={s.heading}>
      <View style={[s.number, complete && s.complete]}>
        {complete ? <Icon name="check" color={t.colors.emerald} size={15} /> : <Text style={s.numberText}>{number}</Text>}
      </View>
      <View style={ui.grow}><Text style={s.title}>{title}</Text>{!!value && <Text style={ui.body}>{value}</Text>}</View>
      {trailing}
    </View>
    {!!children && <View style={s.body}>{children}</View>}
  </View>;
}
const s = StyleSheet.create({
  section: { paddingVertical: t.space.lg, borderBottomWidth: t.border, borderColor: t.colors.border },
  heading: { flexDirection: "row", alignItems: "center", gap: t.space.md },
  number: { width: 28, height: 28, borderRadius: t.radius.sm, backgroundColor: t.colors.neutral, alignItems: "center", justifyContent: "center" },
  complete: { backgroundColor: t.colors.emeraldSoft },
  numberText: { color: t.colors.muted, fontSize: t.font.caption, fontWeight: "600" },
  title: { fontSize: t.font.label, fontWeight: "600", color: t.colors.text, lineHeight: 23 },
  body: { marginTop: t.space.md, gap: t.space.md },
});
