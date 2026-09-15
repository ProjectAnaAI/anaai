// Retain the current submission through network retries and same-tab refresh.
// Session storage is optional; blocked storage falls back to in-memory identity.
export function createRequestKeyStore() {
  let current: { signature: string; key: string } | null = null;
  const storageKey = 'anaai:appointment-submission';
  return {
    forRequest(value: unknown) {
      const signature = JSON.stringify(value);
      if (!current) {
        try {
          const stored = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
          if (stored && stored.signature === signature && typeof stored.key === 'string' &&
              /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(stored.key)) current = stored;
        } catch { /* Optional storage. */ }
      }
      if (current?.signature !== signature) current = { signature, key: crypto.randomUUID() };
      try { sessionStorage.setItem(storageKey, JSON.stringify(current)); } catch { /* In-memory fallback. */ }
      return current.key;
    },
    clear() {
      current = null;
      try { sessionStorage.removeItem(storageKey); } catch { /* Optional storage. */ }
    },
  };
}
