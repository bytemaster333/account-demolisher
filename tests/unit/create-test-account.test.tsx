// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// runDemoSetup funds through friendbot and submits testnet transactions; the
// fake lets each test decide whether it hangs, fails or finishes
const runDemoSetup = vi.fn();
vi.mock("@/lib/wallet/demo-account", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/wallet/demo-account")>();
  return { ...real, runDemoSetup: (...args: unknown[]) => runDemoSetup(...args) };
});

import { CreateTestAccountButton } from "@/components/wallet/CreateTestAccountButton";
import { resolveNetwork } from "@/lib/config/networks";

const network = resolveNetwork("testnet");

beforeEach(() => {
  runDemoSetup.mockReset();
});

afterEach(cleanup);

function renderButton(onActiveChange = vi.fn()) {
  render(
    <CreateTestAccountButton
      network={network}
      onConnector={() => {}}
      onActiveChange={onActiveChange}
    />,
  );
  return onActiveChange;
}

describe("CreateTestAccountButton way back", () => {
  it("returns to the connect options after a failed setup", async () => {
    runDemoSetup.mockRejectedValue(new Error("friendbot request timed out"));
    const onActiveChange = renderButton();
    await act(async () => {
      fireEvent.click(screen.getByTestId("create-test-account-button"));
    });
    expect(screen.getByText("Demo setup failed")).toBeTruthy();

    fireEvent.click(screen.getByTestId("create-test-account-back"));
    expect(onActiveChange).toHaveBeenLastCalledWith(false);
    expect(screen.getByTestId("create-test-account-button")).toBeTruthy();
  });

  it("can leave a setup that is still running, and ignores its late result", async () => {
    let finish!: (v: unknown) => void;
    runDemoSetup.mockReturnValue(new Promise((res) => (finish = res)));
    const onActiveChange = renderButton();
    await act(async () => {
      fireEvent.click(screen.getByTestId("create-test-account-button"));
    });
    expect(screen.getByText("Setting up your demo account")).toBeTruthy();

    fireEvent.click(screen.getByTestId("create-test-account-back"));
    expect(onActiveChange).toHaveBeenLastCalledWith(false);

    await act(async () => {
      finish({ publicKey: "GDEMO", connector: {}, explorerUrl: "https://example.test" });
      await Promise.resolve();
    });
    expect(screen.queryByText("Demo account ready")).toBeNull();
    expect(screen.getByTestId("create-test-account-button")).toBeTruthy();
  });
});
