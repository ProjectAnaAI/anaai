import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { Button } from "../../components/ui";
import { Feedback } from "../../components/workspace";
import { ZudeApiError } from "../../lib/api";
import {
  getTimeClock,
} from "../../lib/time-clock-api";
import { theme as t } from "../../theme/tokens";
import { useBusiness } from "../business/BusinessContext";
import { useEmployeeIdentity } from "../identity/EmployeeIdentityContext";
import { defaultWorkspaceRoute } from "../../navigation/items";
import { timeMessage } from "./state";

type Decision =
  | { key: string; status: "error"; error: unknown }
  | { key: string; status: "admitted"; route: "/" | "/appointments-today" };

// Validate the current PIN session against the authoritative time-clock read.
// Landing is role-based for every shift state; admission never mutates time.
// Failed reads remain closed, and each new PIN session gets its own decision.
// Account mode (not a shared device, no PIN identity) is unchanged.
export function ShiftGate({
  children,
}: {
  children: ReactNode;
}) {
  const { business } = useBusiness();
  const { sharedMode, identity, lock, managementRole } =
    useEmployeeIdentity();

  const key =
    sharedMode && identity
      ? `${business.id}:${identity.employee.id}:${identity.expiresAt}:${managementRole}`
      : null;

  const [decision, setDecision] =
    useState<Decision | null>(null);
  const [attempt, setAttempt] = useState(0);
  const navigated = useRef<string | null>(null);

  const current =
    decision?.key === key ? decision : null;

  useEffect(() => {
    if (key === null) {
      return;
    }

    const controller = new AbortController();
    let cancelled = false;

    void getTimeClock(
      business.id,
      controller.signal,
    ).then(
      () => {
        if (!cancelled) {
          setDecision({ key, status: "admitted", route: defaultWorkspaceRoute(managementRole) });
        }
      },
      (error: unknown) => {
        if (
          cancelled ||
          (error instanceof ZudeApiError &&
            error.code === "CANCELLED")
        ) {
          return;
        }

        setDecision({
          key,
          status: "error",
          error,
        });
      },
    );

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [key, attempt, business.id, managementRole]);

  // Enter the decided destination once per employee session.
  const admittedRoute =
    current?.status === "admitted"
      ? current.route
      : null;

  useEffect(() => {
    if (
      key === null ||
      admittedRoute === null ||
      navigated.current === key
    ) {
      return;
    }

    navigated.current = key;
    router.replace(admittedRoute);
  }, [key, admittedRoute]);

  if (key === null) {
    return children;
  }

  if (current?.status === "admitted") {
    return children;
  }

  const leave = (
    <Button
      label="Lock"
      icon="lock"
      secondary
      onPress={() => void lock()}
    />
  );

  return (
    <View style={s.page}>
      {current?.status === "error" ? (
        <Feedback
          kind="error"
          title="ZUDE couldn’t check your time clock"
          detail={timeMessage(
            current.error,
          )}
          retry={() => {
            setDecision(null);
            setAttempt((value) => value + 1);
          }}
        />
      ) : (
        <Feedback
          kind="loading"
          title="Checking your time clock"
        />
      )}

      <View style={s.actions}>{leave}</View>
    </View>
  );
}

const s = StyleSheet.create({
  page: {
    flex: 1,
    justifyContent: "center",
    backgroundColor: t.colors.workspace,
    padding: t.space.xl,
  },
  actions: {
    alignItems: "center",
  },
});