import { useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Icon } from "../../components/ui";
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
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: normalizedEmail,
        password,
      });

      if (signInError) {
        setError(signInError.message);
      }
    } catch {
      setError("Unable to sign in. Please try again.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={s.safe}>
      <KeyboardAvoidingView
        style={s.keyboard}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={s.page}>
          <View style={s.brand}>
            <Text style={s.wordmark}>ZUDE</Text>
            <Text style={s.brandDetail}>Business operations</Text>
          </View>

          <View style={s.card}>
            <View style={s.heading}>
              <Text accessibilityRole="header" style={s.title}>
                Welcome back
              </Text>
              <Text style={s.description}>
                Sign in to open your business workspace.
              </Text>
            </View>

            <View style={s.fields}>
              <View style={s.field}>
                <Text style={s.label}>Email address</Text>
                <TextInput
                  accessibilityLabel="Email address"
                  autoCapitalize="none"
                  autoComplete="email"
                  autoCorrect={false}
                  editable={!busy}
                  keyboardType="email-address"
                  onChangeText={setEmail}
                  placeholder="you@yourbusiness.com"
                  placeholderTextColor={t.colors.muted}
                  returnKeyType="next"
                  style={s.input}
                  value={email}
                />
              </View>

              <View style={s.field}>
                <Text style={s.label}>Password</Text>

                <View style={s.passwordField}>
                  <TextInput
                    accessibilityLabel="Password"
                    autoCapitalize="none"
                    autoComplete="current-password"
                    editable={!busy}
                    onChangeText={setPassword}
                    onSubmitEditing={() => void signIn()}
                    returnKeyType="go"
                    secureTextEntry={!visible}
                    style={s.passwordInput}
                    value={password}
                  />

                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={
                      visible ? "Hide password" : "Show password"
                    }
                    disabled={busy}
                    hitSlop={8}
                    onPress={() => setVisible((value) => !value)}
                    style={({ pressed }) => [
                      s.visibilityButton,
                      pressed && s.pressed,
                    ]}
                  >
                    <Icon name={visible ? "eye-off" : "eye"} size={19} />
                  </Pressable>
                </View>
              </View>

              {error ? (
                <Text accessibilityRole="alert" style={s.error}>
                  {error}
                </Text>
              ) : null}

              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: busy }}
                disabled={busy}
                onPress={() => void signIn()}
                style={({ pressed }) => [
                  s.button,
                  pressed && !busy && s.pressed,
                  busy && s.buttonDisabled,
                ]}
              >
                {busy ? (
                  <ActivityIndicator color={t.colors.surface} />
                ) : (
                  <>
                    <Text style={s.buttonText}>Sign in</Text>
                    <Icon
                      name="arrow-right"
                      color={t.colors.surface}
                      size={17}
                    />
                  </>
                )}
              </Pressable>
            </View>
          </View>

          <Text style={s.footer}>
            Secure access to your ZUDE business workspace.
          </Text>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: t.colors.workspace,
  },
  keyboard: {
    flex: 1,
  },
  page: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: t.space.xl,
    gap: t.space.xl,
  },
  brand: {
    alignItems: "center",
    gap: t.space.xs,
  },
  wordmark: {
    color: t.colors.brand,
    fontSize: t.font.brand,
    fontWeight: "800",
    letterSpacing: 2,
  },
  brandDetail: {
    color: t.colors.muted,
    fontSize: t.font.caption,
  },
  card: {
    width: "100%",
    maxWidth: 440,
    backgroundColor: t.colors.surface,
    borderWidth: t.border,
    borderColor: t.colors.border,
    borderRadius: t.radius.md,
    padding: t.space.xl,
    gap: t.space.xl,
  },
  heading: {
    gap: t.space.sm,
  },
  title: {
    color: t.colors.text,
    fontSize: 26,
    fontWeight: "700",
    letterSpacing: -0.5,
  },
  description: {
    color: t.colors.muted,
    fontSize: t.font.body,
    lineHeight: 21,
  },
  fields: {
    gap: t.space.lg,
  },
  field: {
    gap: t.space.sm,
  },
  label: {
    color: t.colors.text,
    fontSize: t.font.body,
    fontWeight: "600",
  },
  input: {
    minHeight: t.layout.touch,
    borderWidth: t.border,
    borderColor: t.colors.border,
    borderRadius: t.radius.sm,
    backgroundColor: t.colors.surface,
    paddingHorizontal: t.space.md,
    color: t.colors.text,
    fontSize: t.font.body,
  },
  passwordField: {
    minHeight: t.layout.touch,
    flexDirection: "row",
    alignItems: "center",
    borderWidth: t.border,
    borderColor: t.colors.border,
    borderRadius: t.radius.sm,
    backgroundColor: t.colors.surface,
  },
  passwordInput: {
    flex: 1,
    minWidth: 0,
    minHeight: t.layout.touch,
    paddingHorizontal: t.space.md,
    color: t.colors.text,
    fontSize: t.font.body,
  },
  visibilityButton: {
    width: t.layout.touch,
    minHeight: t.layout.touch,
    alignItems: "center",
    justifyContent: "center",
  },
  button: {
    minHeight: t.layout.touch,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: t.space.sm,
    borderRadius: t.radius.sm,
    backgroundColor: t.colors.emerald,
    paddingHorizontal: t.space.lg,
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  buttonText: {
    color: t.colors.surface,
    fontSize: t.font.body,
    fontWeight: "600",
  },
  error: {
    color: "#B42318",
    fontSize: t.font.caption,
    lineHeight: 19,
  },
  footer: {
    color: t.colors.muted,
    fontSize: t.font.caption,
    textAlign: "center",
  },
  pressed: {
    opacity: 0.65,
  },
});
