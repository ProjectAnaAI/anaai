// Set by the root provider before business pages mount.
let activeBusinessId: string | null = null;

export function setActiveBusinessId(id: string | null) {
  activeBusinessId = id;
}

export function activeBusinessHeaders(): Record<string, string> {
  return activeBusinessId ? { "x-anaai-business-id": activeBusinessId } : {};
}
