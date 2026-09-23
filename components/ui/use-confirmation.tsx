"use client";

import { useEffect, useId, useRef, useState } from "react";
import { DialogSurface } from "./dialog-surface";
import { Button } from "./button";

/** Resolve cancellation on unmount, including a business switch, before any action proceeds. */
export function useConfirmation() {
  const [message, setMessage] = useState<string | null>(null);
  const [destructive, setDestructive] = useState(false);
  const pending = useRef<((confirmed: boolean) => void) | null>(null);
  const titleId = useId();
  useEffect(
    () => () => {
      pending.current?.(false);
      pending.current = null;
    },
    [],
  );
  function finish(confirmed: boolean) {
    const resolve = pending.current;
    pending.current = null;
    setMessage(null);
    resolve?.(confirmed);
  }
  function confirm(
    message: string,
    options: { destructive?: boolean } = {},
  ): Promise<boolean> {
    if (pending.current) return Promise.resolve(false);
    return new Promise((resolve) => {
      pending.current = resolve;
      setDestructive(options.destructive ?? false);
      setMessage(message);
    });
  }
  const confirmation =
    message === null ? null : (
      <DialogSurface
        aria-labelledby={titleId}
        className="confirmation-dialog"
        onClose={() => finish(false)}
      >
        <div className="p-6">
          <p className="eyebrow">Please confirm</p>
          <h2 id={titleId} className="mt-3 text-lg font-semibold leading-7">
            {message}
          </h2>
          <div className="mt-6 flex flex-wrap justify-end gap-3">
            <Button variant="outline" autoFocus onClick={() => finish(false)}>
              Go back
            </Button>
            <Button
              variant={destructive ? "destructive" : "default"}
              onClick={() => finish(true)}
            >
              Confirm
            </Button>
          </div>
        </div>
      </DialogSurface>
    );
  return { confirm, confirmation };
}
