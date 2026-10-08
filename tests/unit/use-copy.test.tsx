// @vitest-environment happy-dom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCopyToClipboard } from "@/components/ui/use-copy";

const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");

function setClipboard(value: unknown): void {
  Object.defineProperty(navigator, "clipboard", { value, configurable: true });
}

afterEach(() => {
  if (original) Object.defineProperty(navigator, "clipboard", original);
  else Reflect.deleteProperty(navigator, "clipboard");
  vi.useRealTimers();
});

describe("useCopyToClipboard", () => {
  it("reports copied once the write resolved, then goes back to idle", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(() => Promise.resolve());
    setClipboard({ writeText });
    const { result } = renderHook(() => useCopyToClipboard(1000));
    await act(() => result.current.copy("GABC"));
    expect(writeText).toHaveBeenCalledWith("GABC");
    expect(result.current.state).toBe("copied");
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.state).toBe("idle");
  });

  it("reports a refused write with its reason instead of ignoring it", async () => {
    setClipboard({ writeText: () => Promise.reject(new Error("denied")) });
    const { result } = renderHook(() => useCopyToClipboard());
    await act(() => result.current.copy("GABC"));
    expect(result.current.state).toBe("failed");
    expect(result.current.error).toBe("denied");
  });

  it("reports a missing clipboard as failed", async () => {
    setClipboard(undefined);
    const { result } = renderHook(() => useCopyToClipboard());
    await act(() => result.current.copy("GABC"));
    expect(result.current.state).toBe("failed");
    expect(result.current.error).toBe("copying isn't available in this browser");
  });
});
