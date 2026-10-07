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
  type TimeClockView,
} from "../../lib/time-clock-api";
import { theme as t } from "../../theme/tokens";
import { useBusiness } from "../business/BusinessContext";
import { useEmployeeIdentity } from "../identity/EmployeeIdentityContext";
import { ClockInLanding } from "./ClockInLanding";
import { postPinRoute, timeMessage } from "./state";

type Decision =
  | { key: string; status: "error"; error: unknown }
  | {
      key: string;
      status: "clock-in";
      view: TimeClockView;
    }
  | {
      key: string;
      status: "admitted";
      route: "/" | "/time-clock";
    };

function decide(
  key: string,
  view: TimeClockView,
): Decision {
  const route = postPinRoute(view.state);

  return route === "clock-in"
    ? { key, status: "clock-in", view }
    : { key, status: "admitted", route };
}

// The single post-PIN routing decision (docs/m05-time-clock.md §8).
//
// Each new employee session (every PIN unlock) fetches the authoritative
// time-clock state before the workspace opens:
//   OFF_CLOCK  -> Clock-In Landing (no workspace until the server says WORKING)
//   WORKING    -> Today
//   ON_*_BREAK -> Time Clock, where the break can be ended
// A failed fetch never falls through to the workspace. PIN unlock itself
// never clocks in; Lock never clocks out.
//
// Account mode (not a shared device, no PIN identity) is unchanged.
export function ShiftGate({
  children,
}: {
  children: ReactNode;
}) {
  const { business } = useBusiness();
  const { sharedMode, identity, lock } =
    useEmployeeIdentity();

  const key =
    sharedMode && identity
      ? `${business.id}:${identity.employee.id}:${identity.expiresAt}`
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
      (view) => {
        if (!cancelled) {
          setDecision(decide(key, view));
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
  }, [key, attempt, business.id]);

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

  if (current?.status === "clock-in") {
    return (
      <ClockInLanding
        view={current.view}
        onDecision={(view) =>
          setDecision(decide(key, view))
        }
        onRefresh={() =>
          setAttempt((value) => value + 1)
        }
        onLock={() => void lock()}
      />
    );
  }

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