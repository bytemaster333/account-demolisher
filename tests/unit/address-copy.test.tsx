// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AddressActions, CopyableAddress } from "@/components/ui/Address";

const KEY = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");

function setClipboard(value: unknown): void {
  Object.defineProperty(navigator, "clipboard", { value, configurable: true });
}

afterEach(() => {
  cleanup();
  if (original) Object.defineProperty(navigator, "clipboard", original);
  else Reflect.deleteProperty(navigator, "clipboard");
});

describe("address copy buttons", () => {
  it("say so when the browser refuses the copy", async () => {
    setClipboard({ writeText: () => Promise.reject(new Error("denied")) });
    render(<AddressActions value={KEY} label="destination" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy destination" }));
    });
    expect(screen.getByRole("button").getAttribute("aria-label")).toBe(
      "Couldn't copy the destination: denied.",
    );
  });

  it("keep the chip's buttons visible after a failed copy", async () => {
    setClipboard(undefined);
    const { container } = render(<CopyableAddress value={KEY} label="account" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy account" }));
    });
    const actions = container.querySelector("button")!.parentElement!;
    expect(actions.style.opacity).toBe("1");
  });

  it("confirm a copy that went through", async () => {
    setClipboard({ writeText: () => Promise.resolve() });
    render(<AddressActions value={KEY} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy address" }));
    });
    expect(screen.getByRole("button", { name: "Copied to clipboard" })).toBeTruthy();
  });
});
