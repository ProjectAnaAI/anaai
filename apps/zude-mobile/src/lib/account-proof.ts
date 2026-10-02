// Recent interactive account sign-in, held in memory only.
//
// On a shared ZUDE device the account session is restored silently for days,
// so its mere presence does not prove that an owner or manager is standing at
// the device. Changing a shared device's registration (forgetting it,
// re-registering it, or leaving shared-device mode) therefore needs a recent
// interactive password sign-in on this device.
export const ACCOUNT_PROOF_WINDOW_MS = 10 * 60 * 1000;
export type AccountProof = { userId: string; at: number } | null;
let proof: AccountProof = null;
const listeners = new Set<(proof: AccountProof) => void>();

function emit() { for (const listener of [...listeners]) listener(proof); }
export function recordAccountSignIn(userId: string, now = Date.now()) {
  proof = { userId, at: now };
  emit();
}
export function clearAccountProof() {
  proof = null;
  emit();
}
export function currentAccountProof(): AccountProof {
  return proof;
}
export function accountRecentlyProven(userId: string, now = Date.now()) {
  return !!proof && proof.userId === userId && now >= proof.at && now - proof.at < ACCOUNT_PROOF_WINDOW_MS;
}
export function onAccountProofChange(listener: (proof: AccountProof) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
