// @vitest-environment happy-dom

import { describe, it, expect, vi, afterEach } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

import type { PageFlowEvent } from "@/lib/orchestrator/page-flow-machine";
import type { Connector } from "@/lib/wallet/connector";

import { useCloseChoices } from "@/app/demolish/_hooks/use-close-choices";
import type { FlowConnector } from "@/app/demolish/_hooks/use-flow-connector";
import { useRunControls } from "@/app/demolish/_hooks/use-run-controls";
import type { SigningRequest } from "@/app/demolish/_hooks/use-signing-request";

afterEach(cleanup);

const TOKEN = { contractId: `C${"A".repeat(55)}`, balance: 1_000_000n };

function useControls(
  over: {
    send?: (event: PageFlowEvent) => void;
    getMachineState?: () => unknown;
    setFormError?: (error: string | null) => void;
  } = {},
) {
  const choices = useCloseChoices([]);
  const connector: FlowConnector = {
    connectorRef: { current: null as Connector | null },
    hasConnector: false,
    setConnector: () => undefined,
  };
  const controls = useRunControls({
    send: over.send ?? vi.fn(),
    getMachineState: over.getMachineState ?? (() => "idle"),
    runInput: null,
    publicKey: "GACCOUNT",
    networkId: "testnet",
    runMismatched: false,
    blockers: [],
    connector,
    choices,
    signing: { reset: vi.fn(), active: null } as unknown as SigningRequest,
    setFormError: over.setFormError ?? (() => undefined),
    setShowConfirmDialog: () => undefined,
    disconnectWallet: () => undefined,
    onTeardownError: () => undefined,
    clearTeardownError: () => undefined,
  });
  return { choices, controls };
}

describe("start over after the run guard cancelled a run", () => {
  it("drops the standalone-token picks and the convert toggle of the old account", () => {
    const { result } = renderHook(() => useControls());
    act(() => {
      result.current.choices.setSelectedHeldTokens([TOKEN]);
      result.current.choices.setConvertHeldTokensToXLM(true);
    });
    expect(result.current.choices.selectedHeldTokens).toEqual([TOKEN]);

    act(() => result.current.controls.onStartOverAfterCancel());

    expect(result.current.choices.selectedHeldTokens).toEqual([]);
    expect(result.current.choices.convertHeldTokensToXLM).toBe(false);
  });
});

describe("retry", () => {
  it("names the account and network on screen, so the machine can refuse another run", () => {
    const send = vi.fn();
    const { result } = renderHook(() => useControls({ send, getMachineState: () => "executing" }));
    act(() => result.current.controls.onRetry());
    expect(send).toHaveBeenCalledWith({
      type: "RETRY",
      connector: null,
      expected: { publicKey: "GACCOUNT", networkId: "testnet" },
    });
  });

  it("says so when the machine refused the retry", () => {
    const setFormError = vi.fn();
    const { result } = renderHook(() =>
      useControls({ getMachineState: () => "failed", setFormError }),
    );
    act(() => result.current.controls.onRetry());
    expect(setFormError).toHaveBeenLastCalledWith(
      "The retry didn't start: the connected account or network doesn't match this close.",
    );
  });
});
