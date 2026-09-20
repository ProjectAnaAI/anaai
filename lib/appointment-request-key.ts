// Retain the current submission through network retries and same-tab refresh.
// Session storage is optional; blocked storage falls back to in-memory identity.

function createUuid(): string {
  if (
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.randomUUID === 'function'
  ) {
    return globalThis.crypto.randomUUID();
  }

  if (
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.getRandomValues === 'function'
  ) {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);

    // RFC 4122 version 4 UUID.
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    const hex = Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, '0'),
    );

    return [
      hex.slice(0, 4).join(''),
      hex.slice(4, 6).join(''),
      hex.slice(6, 8).join(''),
      hex.slice(8, 10).join(''),
      hex.slice(10, 16).join(''),
    ].join('-');
  }

  throw new Error('Secure random number generation is unavailable.');
}

export function createRequestKeyStore() {
  let current: { signature: string; key: string } | null = null;
  const storageKey = 'anaai:appointment-submission';

  return {
    forRequest(value: unknown) {
      const signature = JSON.stringify(value);

      if (!current) {
        try {
          const stored = JSON.parse(
            sessionStorage.getItem(storageKey) || 'null',
          );

          if (
            stored &&
            stored.signature === signature &&
            typeof stored.key === 'string' &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
              stored.key,
            )
          ) {
            current = stored;
          }
        } catch {
          /* Optional storage. */
        }
      }

      if (current?.signature !== signature) {
        current = {
          signature,
          key: createUuid(),
        };
      }

      try {
        sessionStorage.setItem(storageKey, JSON.stringify(current));
      } catch {
        /* In-memory fallback. */
      }

      return current.key;
    },

    clear() {
      current = null;

      try {
        sessionStorage.removeItem(storageKey);
      } catch {
        /* Optional storage. */
      }
    },
  };
}