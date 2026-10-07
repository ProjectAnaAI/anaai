import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppState } from "react-native";
import { useBusiness } from "../business/BusinessContext";
import {
  deviceCredentialRejected,
  identityRequest,
  isDeviceRejectionCode,
  registerDevice,
  type IdentityResult,
  type IssuedSession,
  type RegisteredDevice,
} from "../../lib/employee-identity-api";
import { ZudeApiError } from "../../lib/api";
import {
  accountRecentlyProven,
  currentAccountProof,
  onAccountProofChange,
} from "../../lib/account-proof";
import { signOutAccount } from "../../lib/account-session";
import {
  effectiveManagementRole,
  onOperationalRejection,
  publishOperationalIdentity,
  type OperationalRejection,
} from "../../lib/operational-identity";
import {
  clearSharedMode,
  forgetDevice,
  markSharedMode,
  readDevice,
  readSharedMode,
  saveDevice,
} from "./device-vault";

// Secure storage state. "opening" always settles: "ready" or "unavailable"
// (SecureStore failed; fail closed with retry).
export type VaultState =
  | "opening"
  | "ready"
  | "unavailable";

const REJECTED_MESSAGE =
  "This device registration is no longer valid. An owner or manager must register this device again.";
const NOT_FORGOTTEN_MESSAGE =
  "ZUDE could not remove this device registration from secure storage. The device was not forgotten. Retry Forget This Device.";
const AUTHORITY_MESSAGE =
  "An owner or manager must sign in again on this device to change its registration.";

// Shared-device rule (docs/m04-team-device-pin.md):
// - Once registered, an installation stays a shared device (persisted marker)
//   until an owner/manager leaves shared mode. The account workspace is then
//   only reachable through an employee PIN.
// - Changing the registration (forget, re-register, leave shared mode) needs a
//   recent interactive account sign-in, or — for forget — a PIN-unlocked
//   employee with devices:manage.
function useIdentityFoundation() {
  const { business, userId } = useBusiness();

  const [vault, setVault] =
    useState<VaultState>("opening");
  const [shared, setShared] = useState(false);
  const [device, setDevice] =
    useState<RegisteredDevice | null>(null);
  const [identity, setIdentity] =
    useState<IdentityResult | null>(null);
  const [pin, setPin] = useState("");
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [needsLock, setNeedsLock] =
    useState(false);
  const [forgetPrompt, setForgetPrompt] =
    useState(false);
  const [signOutPrompt, setSignOutPrompt] =
    useState(false);
  const [forgetting, setForgetting] =
    useState(false);
  const [proof, setProof] = useState(
    currentAccountProof,
  );

  const active = useRef(true);
  const pending = useRef(false);
  const generation = useRef(0);
  const current =
    useRef<RegisteredDevice | null>(null);
  const forgetInFlight = useRef(false);
  const session = useRef<{
    device: RegisteredDevice;
    token: string;
  } | null>(null);
  const revokePending = useRef(false);

  const accountAdmin =
    business.role === "owner" ||
    business.role === "manager";

  const sharedMode = shared || !!device;

  // Display only; every action re-checks the 10-minute window when run.
  const accountProven =
    accountAdmin && proof?.userId === userId;

  const employeeDeviceAdmin =
    !!identity?.permissions.includes(
      "devices:manage",
    );

  const canAdministerDevice =
    accountAdmin &&
    (accountProven || employeeDeviceAdmin);

  const canRegister =
    accountAdmin &&
    (!sharedMode || accountProven);

  const canLeaveSharedMode =
    accountAdmin &&
    accountProven &&
    shared &&
    !device;

  const managementRole =
    effectiveManagementRole(
      business.role,
      sharedMode,
      identity?.permissions,
    );

  const authorityNow = (
    allowEmployee: boolean,
  ) =>
    accountAdmin &&
    (accountRecentlyProven(userId) ||
      (allowEmployee && employeeDeviceAdmin));

  // State changes happen only once the async reads settle. The device is read
  // first (a malformed value records the marker while being removed), then the
  // marker. A registered device without the marker (registered before the
  // marker existed) is migrated.
  function loadVault() {
    return readDevice()
      .then(
        async (value) =>
          [
            value,
            await readSharedMode(),
          ] as const,
      )
      .then(async ([value, marked]) => {
        if (value && !marked) {
          await markSharedMode();
        }

        return [
          value,
          marked || !!value,
        ] as const;
      })
      .then(
        ([value, isShared]) => {
          current.current = value;

          if (active.current) {
            setDevice(value);
            setShared(isShared);
            setVault("ready");
          }
        },
        () => {
          if (active.current) {
            setVault("unavailable");
            setMessage(
              "Secure device storage is unavailable. Retry, or restart ZUDE.",
            );
          }
        },
      );
  }

  async function forget() {
    if (forgetInFlight.current) {
      return;
    }

    if (!authorityNow(true)) {
      setMessage(AUTHORITY_MESSAGE);
      setForgetPrompt(false);
      return;
    }

    forgetInFlight.current = true;
    publishOperationalIdentity(business.id, { mode: "locked" });

    // Any in-flight PIN reply now belongs to an older generation and is revoked.
    generation.current += 1;

    const held = session.current;
    session.current = null;

    if (active.current) {
      setForgetting(true);
      setIdentity(null);
      setPin("");
      setNeedsLock(false);
      setForgetPrompt(false);
    }

    try {
      // Best effort: end the employee session while the credential still exists.
      if (held) {
        await identityRequest(
          "/api/employee-session/lock",
          held.device,
          { session: held.token },
        ).catch(() => {});
      }

      await forgetDevice();
      current.current = null;

      if (active.current) {
        setDevice(null);
        setVault("ready");
        setMessage(
          "This device was forgotten on this iPad. It was not revoked on the server. It stays a shared ZUDE device until it is registered again or an owner or manager stops shared-device use.",
        );
      }
    } catch {
      if (active.current) {
        setMessage(NOT_FORGOTTEN_MESSAGE);
      }
    } finally {
      forgetInFlight.current = false;

      if (active.current) {
        setForgetting(false);
      }
    }
  }

  async function leaveSharedMode() {
    if (
      current.current ||
      !authorityNow(false)
    ) {
      setMessage(AUTHORITY_MESSAGE);
      return;
    }

    try {
      await clearSharedMode();

      if (active.current) {
        setShared(false);
        setMessage(
          "This iPad is no longer a shared ZUDE device.",
        );
      }
    } catch {
      if (active.current) {
        setMessage(
          "ZUDE could not update secure storage. This iPad is still a shared device. Please retry.",
        );
      }
    }
  }

  async function signOut() {
    setSignOutPrompt(false);

    try {
      await signOutAccount();
    } catch {
      if (active.current) {
        setMessage(
          "Unable to sign out. Please retry.",
        );
      }
    }
  }

  // Explicit identity lock/revocation.
  //
  // This function may revoke the current employee session on the server.
  // Therefore it must be called only for an intentional security event:
  // user Lock, app backgrounding, session expiry, clock-out completion,
  // Forget Device, or an authoritative identity rejection.
  //
  // React component cleanup must never call this function.
  async function lock(
    rejection?: OperationalRejection,
    notice?: string,
  ) {
    const held = session.current;
    generation.current += 1;

    async function forgetRejected() {
      if (forgetInFlight.current) {
        return;
      }

      forgetInFlight.current = true;

      try {
        await forgetDevice();
        current.current = null;

        if (active.current) {
          setDevice(null);
          setVault("ready");
          setMessage(REJECTED_MESSAGE);
        }
      } catch {
        if (active.current) {
          setMessage(NOT_FORGOTTEN_MESSAGE);
        }
      } finally {
        forgetInFlight.current = false;
      }
    }

    if (rejection) {
      // A request was refused for identity reasons. A device rejection forgets
      // the credential only if it is still the stored one; a session rejection
      // locks only if it concerns the current session.
      if (
        isDeviceRejectionCode(rejection.code)
      ) {
        if (
          current.current?.credential !==
          rejection.credential
        ) {
          return;
        }

        publishOperationalIdentity(business.id, { mode: "locked" });
        session.current = null;

        if (active.current) {
          setIdentity(null);
          setPin("");
          setNeedsLock(false);
        }

        await forgetRejected();
      } else if (
        held &&
        held.token === rejection.session
      ) {
        publishOperationalIdentity(business.id, { mode: "locked" });
        session.current = null;

        if (active.current) {
          setIdentity(null);
          setPin("");
          setNeedsLock(false);
          setMessage(
            "Your employee session ended. Enter your PIN to unlock.",
          );
        }
      }

      return;
    }

    // Remove employee authority before React renders or revocation awaits.
    // Account-only installations have no employee session to lock.
    if (held || current.current) {
      publishOperationalIdentity(business.id, { mode: "locked" });
    }

    if (active.current) {
      setIdentity(null);
      setPin("");
      setNeedsLock(!!held);
    }

    if (!held || revokePending.current) {
      return;
    }

    revokePending.current = true;

    try {
      await identityRequest(
        "/api/employee-session/lock",
        held.device,
        { session: held.token },
      );

      if (session.current === held) {
        session.current = null;
      }

      if (active.current) {
        setNeedsLock(false);
        setMessage(
          notice ??
            "Locked. Device registration is retained.",
        );
      }
    } catch (error) {
      if (
        error instanceof ZudeApiError &&
        error.status === 401
      ) {
        if (session.current === held) {
          session.current = null;
        }

        if (active.current) {
          setNeedsLock(false);
          setMessage(
            "Session ended. Enter your PIN to unlock.",
          );
        }

        if (
          deviceCredentialRejected(error) &&
          current.current === held.device
        ) {
          await forgetRejected();
        }

        return;
      }

      // Keep only the in-memory revocation handle; never allow another unlock
      // until a server retry succeeds (or the session expires on the server).
      if (active.current) {
        setMessage(
          "Locked locally. Reconnect and retry Lock to revoke the server session.",
        );
      }
    } finally {
      revokePending.current = false;
    }
  }

  useEffect(() => {
    active.current = true;
    void loadVault();

    const subscription =
      AppState.addEventListener(
        "change",
        (state) => {
          if (state !== "active") {
            void lock();
          }
        },
      );

    const stopProof =
      onAccountProofChange(setProof);

    const stopRejections =
      onOperationalRejection(
        (rejection) => {
          void lock(rejection);
        },
      );

    return () => {
      // Lifecycle cleanup is local only.
      //
      // Do NOT call lock() here. React may unmount/remount this provider for
      // development lifecycle checks, navigation/tree changes, Fast Refresh,
      // or application teardown. None of those events is an intentional
      // employee Lock and none may revoke a real server session.
      active.current = false;
      subscription.remove();
      stopProof();
      stopRejections();
    };
  }, []);

  // Only leaving this business/provider owns lifecycle cleanup. Dependency
  // changes (especially PIN unlock) are not security lock events.
  useLayoutEffect(() => {
    return () => {
      publishOperationalIdentity(business.id, { mode: "locked" });
    };
  }, [business.id]);

  // Synchronize vault/account/device transitions before descendant passive
  // request effects. Unlock publishes synchronously; intentional locks also
  // remove authority synchronously. Never undo either in dependency cleanup.
  useLayoutEffect(() => {
    const held = session.current;

    publishOperationalIdentity(
      business.id,
      vault !== "ready"
        ? { mode: "locked" }
        : !(shared || device)
          ? { mode: "account" }
          : device &&
              device.businessId ===
                business.id &&
              identity &&
              held &&
              held.device === device
            ? {
                mode: "employee",
                credential:
                  device.credential,
                session: held.token,
              }
            : { mode: "locked" },
    );
  }, [
    business.id,
    vault,
    shared,
    device,
    identity,
  ]);

  useEffect(() => {
    if (!identity) {
      return;
    }

    const timer = setTimeout(
      () => {
        void lock();
      },
      Math.max(
        0,
        Date.parse(identity.expiresAt) -
          Date.now(),
      ),
    );

    return () => clearTimeout(timer);
  }, [identity]);

  async function run(
    action: () => Promise<void>,
  ) {
    if (
      pending.current ||
      forgetInFlight.current
    ) {
      return;
    }

    pending.current = true;
    setBusy(true);
    setMessage("");

    try {
      await action();
    } catch (error) {
      if (active.current) {
        setMessage(
          error instanceof ZudeApiError
            ? error.message
            : "Unable to complete device access. Check your connection or registration and retry.",
        );
      }
    } finally {
      pending.current = false;

      if (active.current) {
        setBusy(false);
      }
    }
  }

  async function register() {
    // First registration happens in account mode; re-registering a shared
    // device needs a recent account sign-in.
    if (
      !accountAdmin ||
      (sharedMode &&
        !accountRecentlyProven(userId))
    ) {
      setMessage(AUTHORITY_MESSAGE);
      return;
    }

    // Mark shared mode BEFORE the server issues a credential, so any later
    // failure still leaves the installation fail-closed.
    await markSharedMode();
    publishOperationalIdentity(business.id, { mode: "locked" });

    if (active.current) {
      setShared(true);
    }

    const result = await registerDevice(
      name.trim(),
      business.id,
      userId,
    );

    const registered = {
      businessId:
        result.device.business_id,
      credential: result.credential,
    };

    await saveDevice(registered);
    current.current = registered;

    if (active.current) {
      setDevice(registered);
    }
  }

  async function unlock() {
    const registered = current.current;

    if (
      !registered ||
      registered.businessId !==
        business.id ||
      session.current
    ) {
      return;
    }

    const version = generation.current;
    const enteredPin = pin;

    setPin("");

    let result: IssuedSession;

    try {
      result =
        await identityRequest<IssuedSession>(
          "/api/device/pin",
          registered,
          { pin: enteredPin },
        );
    } catch (error) {
      // Only an authoritative device rejection forgets the credential, and
      // only if nothing (forget, lock, re-registration) happened meanwhile.
      if (
        deviceCredentialRejected(error) &&
        generation.current === version &&
        current.current === registered
      ) {
        await lock({
          code: (error as ZudeApiError)
            .code,
          credential:
            registered.credential,
          session: "",
        });

        return;
      }

      throw error;
    }

    if (
      result.employee.businessId !==
        business.id ||
      !active.current ||
      generation.current !== version ||
      current.current !== registered
    ) {
      await identityRequest(
        "/api/employee-session/lock",
        registered,
        { session: result.session },
      );

      return;
    }

    session.current = {
      device: registered,
      token: result.session,
    };

    // Publication-order invariant:
    //
    // Once React exposes this PIN-unlocked employee identity to descendants,
    // operational requests must already be able to carry the exact device
    // credential and employee session that produced it.
    //
    // publishOperationalIdentity() is synchronous and memory-only. Publish
    // before setIdentity() so ShiftGate cannot observe an unlocked React
    // identity while operationalIdentity() still reports "locked".
    publishOperationalIdentity(
      business.id,
      {
        mode: "employee",
        credential:
          registered.credential,
        session: result.session,
      },
    );

    setIdentity({
      success: true,
      employee: result.employee,
      permissions: result.permissions,
      expiresAt: result.expiresAt,
    });
  }

  return {
    business,
    device,
    identity,
    pin,
    setPin,
    name,
    setName,
    message,
    vault,
    ready: vault === "ready",
    busy,
    needsLock,
    sharedMode,
    shared,
    accountAdmin,
    accountProven,
    canRegister,
    canAdministerDevice,
    canLeaveSharedMode,
    managementRole,
    forgetPrompt,
    setForgetPrompt,
    forgetting,
    forget,
    leaveSharedMode,
    retryVault: () => {
      publishOperationalIdentity(business.id, { mode: "locked" });
      setVault("opening");
      setMessage("");
      void loadVault();
    },
    signOutPrompt,
    setSignOutPrompt,
    signOut,
    run,
    register,
    unlock,
    lock: (notice?: string) =>
      lock(undefined, notice),
  };
}

const IdentityContext =
  createContext<
    ReturnType<
      typeof useIdentityFoundation
    > | null
  >(null);

export function EmployeeIdentityProvider({
  children,
}: {
  children: ReactNode;
}) {
  const value = useIdentityFoundation();

  return (
    <IdentityContext.Provider value={value}>
      {children}
    </IdentityContext.Provider>
  );
}

export function useEmployeeIdentity() {
  const context =
    useContext(IdentityContext);

  if (!context) {
    throw new Error(
      "Employee identity is unavailable.",
    );
  }

  return context;
}