// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent, cleanup } from "@testing-library/react";

import { TypedConfirmation } from "@/components/confirmations/TypedConfirmation";

// The final destructive gate combines a typed last-4 match AND a timed unlock
// delay (canConfirm = matches && delayElapsed). These lock in that the DELAY half
// of the gate actually fires — the previously-untested safety control.
describe("TypedConfirmation timed-delay gate", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const DEST = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3"; // last 4 = KTL3

  it("offers NO confirm button during the unlock delay, even with a correct match", () => {
    const onConfirm = vi.fn();
    render(
      <TypedConfirmation
        destination={DEST}
        delayMs={4000}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    // the countdown status is shown; the confirm button is not even rendered yet
    expect(screen.getByTestId("typed-confirmation-status")).toBeTruthy();
    expect(screen.queryByTestId("typed-confirmation-confirm")).toBeNull();

    // a correct last-4 does NOT bypass the delay
    fireEvent.change(screen.getByTestId("typed-confirmation-input"), { target: { value: "KTL3" } });
    act(() => {
      vi.advanceTimersByTime(3900); // still short of the 4s delay
    });
    expect(screen.queryByTestId("typed-confirmation-confirm")).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("enables confirm only AFTER the delay elapses and the last-4 match", () => {
    const onConfirm = vi.fn();
    render(
      <TypedConfirmation
        destination={DEST}
        delayMs={4000}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    fireEvent.change(screen.getByTestId("typed-confirmation-input"), { target: { value: "KTL3" } });
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    const btn = screen.getByTestId("typed-confirmation-confirm") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(onConfirm).toHaveBeenCalledWith("KTL3");
  });

  it("keeps confirm disabled after the delay when the last-4 do NOT match", () => {
    render(
      <TypedConfirmation
        destination={DEST}
        delayMs={4000}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    fireEvent.change(screen.getByTestId("typed-confirmation-input"), { target: { value: "WRON" } });
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    const btn = screen.getByTestId("typed-confirmation-confirm") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});
