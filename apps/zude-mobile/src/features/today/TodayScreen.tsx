import type { ReactNode } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { Button, Icon, Section, styles as ui } from "../../components/ui";
import {
  appointments,
  attentionItems,
  availableSlots,
  demoDay,
  formatTime,
  voiceDemo,
} from "../../data/demoToday";
import { theme as t } from "../../theme/tokens";
import type { Preview } from "../../types/today";
import { AppointmentList } from "./AppointmentList";
import { Schedule } from "./Schedule";

export function TodayScreen({
  wide,
  compact,
  currentUser,
  onPreview,
}: {
  wide: boolean;
  compact: boolean;
  currentUser?: ReactNode;
  onPreview: (preview: Preview) => void;
}) {
  const { width: windowWidth } = useWindowDimensions();

  const sidebarWidth =
    windowWidth >= t.layout.sidebarBreakpoint ? t.layout.sidebar : 0;

  const workspaceWidth = Math.max(0, windowWidth - sidebarWidth);

  const contentWidth = Math.min(
    t.layout.maxContent,
    Math.max(0, workspaceWidth - t.space.lg * 2),
  );

  const columnsGap = t.space.lg;
  const availableColumnsWidth = Math.max(0, contentWidth - columnsGap);

  const mainWidth = wide
    ? availableColumnsWidth * t.layout.mainFraction
    : undefined;

  const railWidth = wide
    ? availableColumnsWidth * t.layout.railFraction
    : undefined;

  function booking(time?: string) {
    onPreview({
      title: time ? `New appointment · ${time}` : "New appointment",
      detail: `${
        time ? `${time} is a sample business-wide opening. ` : ""
      }The booking flow will be added in a future milestone. Service selection, customer details, and appointment creation are not connected in this preview.`,
    });
  }

  return (
    <ScrollView
      style={s.scroll}
      contentContainerStyle={s.content}
      horizontal={false}
      showsHorizontalScrollIndicator={false}
    >
      <View style={[s.header, compact && s.stacked]}>
        <View style={ui.grow}>
          <View style={ui.wrap}>
            <Text accessibilityRole="header" style={s.title}>
              Today
            </Text>
          </View>
          <Text style={s.context}>
            {demoDay.date} · {demoDay.business}
          </Text>
        </View>

        {currentUser}

        <Button label="New Appointment" icon="plus" onPress={() => booking()} />
      </View>

      <View style={s.pulse}>
        <View style={s.pulseDot} />

        <Text style={[ui.body, ui.grow]}>
          <Text style={s.emphasis}>The day is underway.</Text>{" "}
          {appointments.filter((a) => a.status === "In progress").length} in
          progress ·{" "}
          {appointments.filter((a) => a.status === "Checked in").length}{" "}
          customer checked in
        </Text>

        <Text style={ui.meta}>{formatTime(demoDay.now)}</Text>
      </View>

      <View
        style={[
          s.columns,
          !wide && s.stacked,
          wide && { width: contentWidth },
        ]}
      >
        <View
          style={[
            s.main,
            wide && {
              width: mainWidth,
              flexBasis: mainWidth,
              flexGrow: 0,
              flexShrink: 1,
            },
          ]}
        >
          <AppointmentList
            compact={compact}
            focused={wide}
            onPreview={onPreview}
          />

          <Section
            title="Next Available"
            trailing={<Text style={ui.meta}>30 min</Text>}
          >
            <View style={s.slots}>
              {availableSlots.map((slot) => (
                <Pressable
                  key={slot.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Preview booking at ${formatTime(
                    slot.start,
                  )}, ${slot.duration} minutes`}
                  onPress={() => booking(formatTime(slot.start))}
                  style={({ pressed }) => [
                    s.slot,
                    pressed && ui.pressed,
                  ]}
                >
                  <Text style={s.slotTime}>{formatTime(slot.start)}</Text>
                  <Icon name="plus" color={t.colors.emerald} size={15} />
                </Pressable>
              ))}
            </View>
          </Section>

          <Section
            title="Needs Attention"
            trailing={
              <Text style={ui.meta}>{attentionItems.length} to review</Text>
            }
          >
            {attentionItems.map((item) => (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${item.action}: ${item.title}`}
                key={item.id}
                onPress={() =>
                  onPreview({ title: item.title, detail: item.preview })
                }
                style={({ pressed }) => [
                  s.attention,
                  pressed && ui.pressed,
                ]}
              >
                <View style={s.attentionIcon}>
                  <Icon name="alert-circle" color={t.colors.amber} />
                </View>

                <View style={ui.grow}>
                  <Text style={ui.strong}>{item.title}</Text>
                  <Text style={ui.meta}>{item.detail}</Text>
                </View>

                <Icon name="chevron-right" size={16} />
              </Pressable>
            ))}
          </Section>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="AnaAI Voice Assistant, coming soon"
            onPress={() =>
              onPreview({
                title: voiceDemo.title,
                detail:
                  "Voice functionality is not enabled. This space will eventually surface useful call summaries and follow-ups for your business.",
              })
            }
            style={({ pressed }) => [s.voice, pressed && ui.pressed]}
          >
            <Icon name="mic" />

            <View style={ui.grow}>
              <Text style={ui.strong}>{voiceDemo.title}</Text>
              <Text style={ui.meta}>{voiceDemo.detail}</Text>
            </View>

            <Icon name="chevron-right" />
          </Pressable>
        </View>

        <View
          style={[
            wide
              ? {
                  width: railWidth,
                  flexBasis: railWidth,
                  flexGrow: 0,
                  flexShrink: 1,
                  minWidth: 0,
                }
              : undefined,
          ]}
        >
          <Schedule />
        </View>
      </View>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  scroll: {
    flex: 1,
    width: "100%",
  },

  content: {
    padding: t.space.lg,
    gap: t.space.lg,
    maxWidth: t.layout.maxContent,
    width: "100%",
    alignSelf: "center",
  },

  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: t.space.lg,
  },

  title: {
    fontSize: t.font.title,
    fontWeight: "700",
    letterSpacing: -0.7,
    color: t.colors.text,
  },

  context: {
    color: t.colors.muted,
    fontSize: t.font.body,
    lineHeight: 21,
    marginTop: t.space.xs,
  },

  stacked: {
    flexDirection: "column",
    alignItems: "stretch",
  },

  pulse: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: t.space.sm,
    paddingBottom: t.space.sm,
    borderBottomWidth: t.border,
    borderBottomColor: t.colors.border,
  },

  pulseDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: t.colors.emeraldBright,
  },

  emphasis: {
    fontWeight: "600",
  },

  columns: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: t.space.lg,
    minWidth: 0,
    maxWidth: "100%",
  },

  main: {
    minWidth: 0,
    gap: t.space.lg,
    alignSelf: "stretch",
  },

  slots: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: t.space.sm,
    paddingHorizontal: t.space.lg,
    paddingBottom: t.space.lg,
  },

  slot: {
    flexGrow: 1,
    flexBasis: 96,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderWidth: t.border,
    borderColor: t.colors.border,
    borderRadius: t.radius.sm,
    padding: t.space.sm,
    gap: t.space.xs,
    minHeight: t.layout.touch,
  },

  slotTime: {
    fontSize: t.font.body,
    flexShrink: 1,
    fontWeight: "600",
    color: t.colors.text,
    fontVariant: ["tabular-nums"],
  },

  attention: {
    flexDirection: "row",
    gap: t.space.md,
    paddingHorizontal: t.space.lg,
    paddingVertical: t.space.sm,
    minHeight: t.layout.touch,
    alignItems: "center",
    borderTopWidth: t.border,
    borderTopColor: t.colors.border,
  },

  attentionIcon: {
    paddingTop: 2,
  },

  voice: {
    flexDirection: "row",
    gap: t.space.md,
    alignItems: "center",
    paddingVertical: t.space.sm,
  },
});