// @vitest-environment happy-dom

import { Keypair } from "@stellar/stellar-sdk";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SecretKeyFallback } from "@/components/wallet/SecretKeyFallback";
import { setActiveConnector } from "@/lib/wallet/active-connector";
import { useWalletStore } from "@/stores/wallet";

beforeEach(() => {
  useWalletStore.setState({ publicKey: null, connectorKind: null });
});

afterEach(() => {
  cleanup();
  setActiveConnector(null);
});

async function submit(value: string): Promise<void> {
  fireEvent.change(screen.getByTestId("secret-key-input"), { target: { value } });
  await act(async () => {
    fireEvent.click(screen.getByTestId("secret-key-submit"));
  });
}

describe("SecretKeyFallback", () => {
  it("accepts a valid seed pasted with surrounding spaces", async () => {
    const kp = Keypair.random();
    const onConnector = vi.fn();
    render(<SecretKeyFallback onConnector={onConnector} />);
    await submit(`  ${kp.secret()}\t `);
    expect(onConnector).toHaveBeenCalledTimes(1);
    expect(useWalletStore.getState().publicKey).toBe(kp.publicKey());
  });

  it("ties the error to the input", async () => {
    render(<SecretKeyFallback />);
    await submit("SNOTAKEY");
    const input = screen.getByTestId("secret-key-input");
    const error = screen.getByRole("alert");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")?.split(" ")).toContain(error.id);
  });

  it("does not announce the static warning as an alert", () => {
    render(<SecretKeyFallback />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Not recommended")).toBeTruthy();
  });

  it("asks password managers to skip the seed field", () => {
    render(<SecretKeyFallback />);
    const input = screen.getByTestId("secret-key-input");
    expect(input.getAttribute("type")).toBe("password");
    expect(input.getAttribute("autocomplete")).toBe("one-time-code");
    expect(input.getAttribute("data-1p-ignore")).not.toBeNull();
    expect(input.getAttribute("data-lpignore")).toBe("true");
    expect(input.getAttribute("data-bwignore")).not.toBeNull();
    expect(input.getAttribute("data-form-type")).toBe("other");
  });
});
