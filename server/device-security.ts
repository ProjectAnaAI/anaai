import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

// The UUID is a lookup locator, never authority; all 256 random secret bits must
// be verified. Fast salted SHA-256 is appropriate for random credentials, not PINs.
export function issueCredential() {
  const id = randomUUID();
  const credential = `${id}.${randomBytes(32).toString("base64url")}`;
  const salt = randomBytes(16).toString("base64");
  return { id, credential, salt, hash: digest(credential, salt).toString("base64") };
}
function digest(credential: string, salt: string) {
  return createHash("sha256").update(salt).update("\0").update(credential).digest();
}
export function credentialId(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/.test(value)
    ? value.slice(0, 36) : null;
}
export function verifyCredential(value: string, hash: string, salt: string) {
  try {
    const expected = Buffer.from(hash, "base64");
    return !!credentialId(value) && expected.length === 32 && Buffer.from(salt, "base64").length === 16 && timingSafeEqual(digest(value, salt), expected);
  } catch { return false; }
}
