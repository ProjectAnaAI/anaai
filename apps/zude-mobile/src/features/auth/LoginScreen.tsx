import { useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button, IconButton, styles as ui } from "../../components/ui";
import { Brand, Field } from "../../components/workspace";
import { recordAccountSignIn } from "../../lib/account-proof";
import { supabase } from "../../lib/supabase";
import { theme as t } from "../../theme/tokens";

export function LoginScreen() {
  const inFlight = useRef(false);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function signIn() {
    if (inFlight.current) return;

    const normalizedEmail = email.trim();

    if (!normalizedEmail || !password) {
      setError("Enter your email address and password.");
      return;
    }

    inFlight.current = true;
    setBusy(true);
    setError("");

    try {
      const { data, error: signInError } = await supabase.auth.signInWithPassword({
        email: normalizedEmail,
        password,
      });

      if (signInError) {
        setError(signInError.message);
      } else if (data.user) {
        // Interactive password sign-in is the account step-up for changing a
        // shared device's registration (lib/account-proof.ts).
        recordAccountSignIn(data.user.id);
      }
    } catch {
      setError("Unable to sign in. Please try again.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return <SafeAreaView style={s.safe}>
    <KeyboardAvoidingView style={s.safe} behavior={Platform.OS === "ios" ? "padding" : "height"}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={s.page}>
        <Brand />
        <View style={s.form}>
          <Text accessibilityRole="header" style={s.title}>Welcome back</Text>
          <Text style={ui.body}>Sign in to open your business workspace.</Text>
          <Text style={ui.strong}>Email address</Text>
          <Field label="Email address" autoCapitalize="none" autoComplete="email" autoCorrect={false}
            editable={!busy} keyboardType="email-address" onChangeText={setEmail} placeholder="you@yourbusiness.com"
            returnKeyType="next" value={email} />
          <Text style={ui.strong}>Password</Text>
          <View style={ui.row}>
            <Field label="Password" autoCapitalize="none" autoComplete="current-password" editable={!busy}
              onChangeText={setPassword} onSubmitEditing={() => void signIn()} returnKeyType="go"
              secureTextEntry={!visible} value={password} style={ui.grow} />
            <IconButton label={visible ? "Hide password" : "Show password"} icon={visible ? "eye-off" : "eye"}
              disabled={busy} onPress={() => setVisible((value) => !value)} />
          </View>
          {!!error && <Text accessibilityRole="alert" style={s.error}>{error}</Text>}
          <Button label="Sign in" busy={busy} disabled={busy} icon="arrow-right" onPress={() => void signIn()} />
        </View>
        <Text style={ui.meta}>Secure access to your ZUDE business workspace.</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  </SafeAreaView>;
}
const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: t.colors.workspace },
  page: { flexGrow: 1, justifyContent: "center", alignItems: "center", padding: t.space.xl, gap: t.space.xl },
  form: { width: "100%", maxWidth: 440, padding: t.space.xl, gap: t.space.lg, backgroundColor: t.colors.surface, borderWidth: t.border, borderColor: t.colors.border, borderRadius: t.radius.md },
  title: { color: t.colors.text, fontSize: t.font.title, fontWeight: "700", letterSpacing: -0.7 },
  error: { color: t.colors.destructive, fontSize: t.font.body, lineHeight: 21 },
});
