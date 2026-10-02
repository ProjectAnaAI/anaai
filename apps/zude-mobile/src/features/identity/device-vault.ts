import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import type { RegisteredDevice } from "../../lib/employee-identity-api";
const key = "zude.registered-device.v1";
let webDevice: RegisteredDevice | null = null;

// SecureStore itself failed (read, write, or delete could not be trusted). The
// caller must fail closed and offer retry; storage never downgrades to
// AsyncStorage, localStorage, or plaintext.
export class DeviceVaultError extends Error {
  constructor() { super("Secure device storage is unavailable."); this.name = "DeviceVaultError"; }
}

// Shape only. Whether a credential is still valid is decided by the server.
function storedDevice(raw: string): RegisteredDevice | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const { businessId, credential } = value as Record<string, unknown>;
    const token = (text: unknown, max: number): text is string =>
      typeof text === "string" && text.length > 0 && text.length <= max && /^[\x21-\x7e]+$/.test(text);
    return token(businessId, 128) && token(credential, 512) ? { businessId, credential } : null;
  } catch {
    return null;
  }
}

// Web preview is explicitly memory-only. Never persist credentials in localStorage
// or AsyncStorage. On native, storage failures are surfaced without downgrading.
export async function readDevice(): Promise<RegisteredDevice | null> {
  if (Platform.OS === "web") return webDevice;
  let raw: string | null;
  try {
    raw = await SecureStore.getItemAsync(key);
  } catch {
    throw new DeviceVaultError();
  }
  if (!raw) return null;
  const device = storedDevice(raw);
  if (device) return device;
  // Malformed/unsupported value: it can never authenticate, so remove it. Its
  // presence proves this installation was a shared device, so shared-device
  // mode is recorded first: removal never re-opens the account workspace.
  // If either write fails, fail closed.
  await markSharedMode();
  await forgetDevice();
  return null;
}
export async function saveDevice(device: RegisteredDevice) {
  if (Platform.OS === "web") { webDevice = device; return; }
  await SecureStore.setItemAsync(key, JSON.stringify(device), { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
}
// Local only: deletes this installation's copy of the credential. It does not
// revoke the device on the server. Resolves only once the credential is
// verifiably gone, so callers never report a forgotten device that is not.
export async function forgetDevice() {
  if (Platform.OS === "web") { webDevice = null; return; }
  try {
    await SecureStore.deleteItemAsync(key);
    if ((await SecureStore.getItemAsync(key)) !== null) throw new Error();
  } catch {
    throw new DeviceVaultError();
  }
}

// Shared-device mode marker. Not a secret: it records that this installation
// is a shared ZUDE device, so losing the device credential (forget, revocation,
// corruption, reinstall of the credential only) never drops the app back into
// the signed-in account's workspace without employee PIN identity. It survives
// sign-out and restarts; only an owner/manager step-up clears it.
const sharedKey = "zude.shared-device.v1";
let webShared = false;
export async function readSharedMode(): Promise<boolean> {
  if (Platform.OS === "web") return webShared;
  try {
    return (await SecureStore.getItemAsync(sharedKey)) !== null;
  } catch {
    throw new DeviceVaultError();
  }
}
export async function markSharedMode() {
  if (Platform.OS === "web") { webShared = true; return; }
  try {
    await SecureStore.setItemAsync(sharedKey, "1", { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  } catch {
    throw new DeviceVaultError();
  }
}
export async function clearSharedMode() {
  if (Platform.OS === "web") { webShared = false; return; }
  try {
    await SecureStore.deleteItemAsync(sharedKey);
    if ((await SecureStore.getItemAsync(sharedKey)) !== null) throw new Error();
  } catch {
    throw new DeviceVaultError();
  }
}
