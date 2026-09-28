import AsyncStorage from "@react-native-async-storage/async-storage";
import { digestStringAsync, CryptoDigestAlgorithm, randomUUID } from "expo-crypto";
import { ZudeApiError } from "../../lib/api";
import { mutateAppointment } from "../../lib/appointments-api";

// Persist only a hash and UUID, never customer data or bearer tokens. A retry
// after navigation/restart uses the same key for the same user/business/intent.
const running = new Map<string, Promise<Awaited<ReturnType<typeof mutateAppointment>>>>();
export async function performAction(userId: string, businessId: string, body: Record<string, unknown>) {
  const intent = JSON.stringify(Object.fromEntries(Object.entries(body).sort(([a], [b]) => a.localeCompare(b))));
  const hash = await digestStringAsync(CryptoDigestAlgorithm.SHA256, `${userId}:${businessId}:${intent}`);
  const storageKey = `zude.appointment-request.${hash}`;
  const existing = running.get(storageKey);
  if (existing) return existing;
  const action = (async () => {
    let key: string;
    try {
      key = (await AsyncStorage.getItem(storageKey)) || randomUUID();
      await AsyncStorage.setItem(storageKey, key); // Must succeed BEFORE sending.
    } catch {
      throw new ZudeApiError(0, "LOCAL_STORAGE_ERROR", "Unable to prepare a safe appointment request.");
    }
    try {
      const result = await mutateAppointment(businessId, body, key, userId);
      // Failure to clean up must not turn a verified commit into a UI failure.
      await AsyncStorage.removeItem(storageKey).catch(() => {});
      return result;
    } catch (error) {
      if (error instanceof ZudeApiError && [400, 403, 404, 409].includes(error.status)) {
        await AsyncStorage.removeItem(storageKey).catch(() => {});
      }
      throw error;
    }
  })();
  running.set(storageKey, action);
  try { return await action; } finally { running.delete(storageKey); }
}
