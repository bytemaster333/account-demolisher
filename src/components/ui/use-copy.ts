"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "@/lib/errors";

export type CopyState = "idle" | "copied" | "failed";

// one clipboard write for every copy button. "copied" shows only after the write
// resolved; a missing clipboard (plain http, some in-app browsers) or a refused
// write ends in "failed" with the reason, so the caller can tell the user to
// copy by hand instead of the click doing nothing.
export function useCopyToClipboard(resetMs = 1400): {
  readonly state: CopyState;
  // why the last copy failed; null unless state is "failed"
  readonly error: string | null;
  readonly copy: (text: string) => Promise<void>;
} {
  const [state, setState] = useState<CopyState>("idle");
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = useCallback(
    async (text: string): Promise<void> => {
      window.clearTimeout(timer.current);
      const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
      if (clipboard === undefined || typeof clipboard.writeText !== "function") {
        setState("failed");
        setError("copying isn't available in this browser");
        return;
      }
      try {
        await clipboard.writeText(text);
      } catch (err) {
        setState("failed");
        setError(errorMessage(err, "the browser refused the clipboard write"));
        return;
      }
      setState("copied");
      setError(null);
      timer.current = window.setTimeout(() => setState("idle"), resetMs);
    },
    [resetMs],
  );

  return { state, error, copy };
}
