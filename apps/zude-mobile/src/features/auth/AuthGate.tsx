import type { Session } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Brand } from "../../components/workspace";
import { BusinessGate } from "../business/BusinessGate";
import { supabase } from "../../lib/supabase";
import { AppShell } from "../../navigation/AppShell";
import { theme as t } from "../../theme/tokens";
import { EmployeeIdentityProvider } from "../identity/EmployeeIdentityContext";
import { EmployeeIdentityGate } from "../identity/DeviceIdentityScreen";
import { LoginScreen } from "./LoginScreen";

export function AuthGate() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let mounted = true;

    void supabase.auth.getSession().then(({ data, error }) => {
      if (!mounted) return;

      if (error) {
        console.error("ZUDE session restore error:", error);
      }

      setSession(data.session ?? null);
      setReady(true);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!mounted) return;

      setSession(nextSession);
      setReady(true);
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  if (!ready) {
    return (
      <View style={s.loading}>
        <Brand />
        <ActivityIndicator color={t.colors.emerald} />
      </View>
    );
  }

  if (!session) {
    return <LoginScreen />;
  }

  return (
    <BusinessGate key={session.user.id}>
      <EmployeeIdentityProvider><EmployeeIdentityGate><AppShell /></EmployeeIdentityGate></EmployeeIdentityProvider>
    </BusinessGate>
  );
}

const s = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: t.space.lg,
    backgroundColor: t.colors.workspace,
  },
  wordmark: {
    color: t.colors.brand,
    fontSize: t.font.brand,
    fontWeight: "800",
    letterSpacing: 2,
  },
});
