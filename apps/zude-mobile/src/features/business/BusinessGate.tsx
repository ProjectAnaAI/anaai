import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { theme as t } from "../../theme/tokens";
import { BusinessProvider, type Business } from "./BusinessContext";

function StateFrame({
  title,
  detail,
}: {
  title: string;
  detail: string;
}) {
  return (
    <View style={s.page}>
      <Text style={s.wordmark}>ZUDE</Text>

      <View style={s.card}>
        <Text accessibilityRole="header" style={s.title}>
          {title}
        </Text>
        <Text style={s.detail}>{detail}</Text>
      </View>
    </View>
  );
}

function BusinessSelection({
  businesses,
  onSelect,
}: {
  businesses: Business[];
  onSelect: (businessId: string) => Promise<void>;
}) {
  return (
    <View style={s.page}>
      <Text style={s.wordmark}>ZUDE</Text>

      <View style={s.card}>
        <Text accessibilityRole="header" style={s.title}>
          Choose a business
        </Text>

        <Text style={s.detail}>
          Select the workspace you want to open.
        </Text>

        <View style={s.businesses}>
          {businesses.map((business) => (
            <Pressable
              key={business.id}
              accessibilityRole="button"
              onPress={() => void onSelect(business.id)}
              style={({ pressed }) => [
                s.business,
                pressed && s.pressed,
              ]}
            >
              <View style={s.businessText}>
                <Text style={s.businessName}>{business.name}</Text>
                <Text style={s.role}>{business.role}</Text>
              </View>

              <Text style={s.arrow}>→</Text>
            </Pressable>
          ))}
        </View>
      </View>
    </View>
  );
}

export function BusinessGate({ children }: { children: ReactNode }) {
  return (
    <BusinessProvider
      loading={
        <StateFrame
          title="Opening ZUDE"
          detail="Loading your business workspace…"
        />
      }
      noMembership={
        <StateFrame
          title="Business setup required"
          detail="This account does not have a ZUDE business membership yet."
        />
      }
      error={(message) => (
        <StateFrame title="Unable to open workspace" detail={message} />
      )}
      selectBusiness={(businesses, onSelect) => (
        <BusinessSelection businesses={businesses} onSelect={onSelect} />
      )}
    >
      {children}
    </BusinessProvider>
  );
}

const s = StyleSheet.create({
  page: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: t.colors.workspace,
    padding: t.space.xl,
    gap: t.space.xl,
  },
  wordmark: {
    color: t.colors.brand,
    fontSize: t.font.brand,
    fontWeight: "800",
    letterSpacing: 2,
  },
  card: {
    width: "100%",
    maxWidth: 480,
    padding: t.space.xl,
    gap: t.space.lg,
    backgroundColor: t.colors.surface,
    borderWidth: t.border,
    borderColor: t.colors.border,
    borderRadius: t.radius.md,
  },
  title: {
    color: t.colors.text,
    fontSize: t.font.section,
    fontWeight: "700",
  },
  detail: {
    color: t.colors.muted,
    fontSize: t.font.body,
    lineHeight: 21,
  },
  businesses: {
    gap: t.space.sm,
  },
  business: {
    minHeight: 60,
    flexDirection: "row",
    alignItems: "center",
    gap: t.space.md,
    paddingHorizontal: t.space.lg,
    paddingVertical: t.space.md,
    borderWidth: t.border,
    borderColor: t.colors.border,
    borderRadius: t.radius.sm,
  },
  businessText: {
    flex: 1,
    minWidth: 0,
  },
  businessName: {
    color: t.colors.text,
    fontSize: t.font.body,
    fontWeight: "600",
  },
  role: {
    marginTop: t.space.xs,
    color: t.colors.muted,
    fontSize: t.font.caption,
    textTransform: "capitalize",
  },
  arrow: {
    color: t.colors.emerald,
    fontSize: 20,
  },
  pressed: {
    opacity: 0.65,
  },
});
