// Shared-device policy only. This controller never writes time or account data.
export const EMPLOYEE_INACTIVITY_LOCK_MS = 300_000;

type Options = {
  isCurrent: () => boolean;
  onLock: () => void;
  now?: () => number;
  schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
};
export function employeeInactivity({ isCurrent, onLock, now = Date.now, schedule = setTimeout, cancel = clearTimeout }: Options) {
  let deadline = now() + EMPLOYEE_INACTIVITY_LOCK_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let revision = 0;
  let disposed = false;
  function clear() {
    revision++;
    if (timer !== null) cancel(timer);
    timer = null;
  }
  function dispose() { disposed = true; clear(); }
  function check(): boolean {
    if (disposed || !isCurrent()) { dispose(); return false; }
    if (now() >= deadline) {
      // Invalidate before invoking lock; repeated activity/callbacks cannot revoke twice.
      dispose();
      onLock();
      return false;
    }
    return true;
  }
  function arm() {
    clear();
    const version = revision;
    timer = schedule(() => {
      if (disposed || version !== revision) return;
      timer = null;
      if (check()) arm(); // Early timers must not lock before the wall-clock deadline.
    }, Math.max(0, deadline - now()));
  }
  function activity(): boolean {
    // A suspended timer or late press must never revive an expired identity.
    if (!check()) return false;
    deadline = now() + EMPLOYEE_INACTIVITY_LOCK_MS;
    arm();
    return true;
  }
  arm();
  return { activity, check, dispose };
}
