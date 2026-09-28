import { router } from "expo-router";
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
import { voiceDemo } from "../../data/demoToday";
import { formatTime } from "./todayData";
import { useTodayAppointments } from "./useTodayAppointments";
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
  const { business, clock, appointments, status, errorMessage, retry } = useTodayAppointments();
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

  function booking() {
    router.replace({ pathname: "/appointments", params: { compose: "new" } });
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
            {clock?.label ?? "Date unavailable"} · {business.name}
          </Text>
        </View>

        {currentUser}

        <Button label="New Appointment" icon="plus" onPress={() => booking()} />
      </View>

      <View style={s.pulse}>
        <View style={s.pulseDot} />

        <Text style={[ui.body, ui.grow]}>
          {status === "loading" ? "Loading today’s appointments…" : status === "error"
            ? "Appointments unavailable" : `${appointments.length} appointments today`}
        </Text>

        <Text style={ui.meta}>{clock ? formatTime(clock.minutes) : "Time unavailable"}</Text>
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
          {status === "success" ? (
            <AppointmentList
              key={`${business.id}:${clock?.date}`}
              appointments={appointments}
              compact={compact}
              focused={wide}
              now={clock?.minutes ?? null}
              onPreview={onPreview}
            />
          ) : (
            <Section title="Up Next">
              <View style={s.notice}>
                <Text style={ui.body} accessibilityLiveRegion="polite">
                  {status === "loading" ? "Loading today’s appointments…" : errorMessage}
                </Text>
                {status === "error" && <Button label="Retry" onPress={retry} secondary />}
              </View>
            </Section>
          )}

          <Section title="Next Available">
            <Text style={[ui.meta, s.notice]}>Availability is not connected yet.</Text>
          </Section>

          <Section title="Needs Attention">
            <Text style={[ui.meta, s.notice]}>Operational alerts are not connected yet.</Text>
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
          <Schedule appointments={appointments} now={clock?.minutes ?? null} status={status} />
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

  notice: { padding: t.space.lg, paddingTop: 0, gap: t.space.md },

  voice: {
    flexDirection: "row",
    gap: t.space.md,
    alignItems: "center",
    paddingVertical: t.space.sm,
  },
});