// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// the balance probe is a soroban simulation, so it is faked at the rpc boundary
const probe = { balance: vi.fn() };
vi.mock("@/lib/soroban/sep41", () => ({
  balance: (...args: unknown[]) => probe.balance(...args),
}));
vi.mock("@/lib/soroban/rpc-client", () => ({ getRpc: () => ({}) }));

import { StandaloneTokensCard } from "@/components/wallet/StandaloneTokensCard";
import { NETWORKS } from "@/lib/config/networks";
import type { HeldToken } from "@/lib/soroban/held-tokens";

const USER = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
const MANUAL = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

function Harness({ discovered = [] }: { readonly discovered?: readonly HeldToken[] }) {
  const [selected, setSelected] = useState<readonly HeldToken[]>([]);
  return (
    <StandaloneTokensCard
      discovered={discovered}
      unreadable={[]}
      selected={selected}
      onChange={setSelected}
      network={NETWORKS.testnet}
      userPublicKey={USER}
      isCex={false}
      onRebuild={vi.fn()}
      convertToXLM={false}
      onConvertToXLMChange={vi.fn()}
    />
  );
}

async function addManual(id: string): Promise<void> {
  fireEvent.change(screen.getByTestId("held-token-manual-input"), { target: { value: id } });
  await act(async () => {
    fireEvent.click(screen.getByText("Check & add"));
  });
}

beforeEach(() => {
  probe.balance.mockReset();
  probe.balance.mockResolvedValue(50n);
});

afterEach(cleanup);

describe("StandaloneTokensCard manually added tokens", () => {
  it("keeps an unticked manual token's row and the rebuild button", async () => {
    render(<Harness />);
    await addManual(MANUAL);
    const box = screen.getByTestId(`held-token-${MANUAL}`);
    expect(screen.getByTestId("held-token-rebuild")).toBeTruthy();

    fireEvent.click(box);

    expect(screen.getByTestId(`held-token-${MANUAL}`)).toBeTruthy();
    expect(screen.getByTestId("held-token-rebuild").textContent).toMatch(/sweep none/);
  });

  it("can tick an unticked manual token again", async () => {
    render(<Harness />);
    await addManual(MANUAL);
    const input = (): HTMLInputElement =>
      screen.getByTestId(`held-token-${MANUAL}`) as HTMLInputElement;
    fireEvent.click(input());
    expect(input().checked).toBe(false);
    fireEvent.click(input());
    expect(input().checked).toBe(true);
    expect(screen.getByTestId("held-token-rebuild").textContent).toMatch(/sweep 1 token/);
  });
});

describe("StandaloneTokensCard convert toggle", () => {
  it("says what happens to a token that can't be converted", () => {
    const token: HeldToken = { contractId: MANUAL, balance: 5n };
    function Selected() {
      const [selected, setSelected] = useState<readonly HeldToken[]>([token]);
      return (
        <StandaloneTokensCard
          discovered={[token]}
          unreadable={[]}
          selected={selected}
          onChange={setSelected}
          network={NETWORKS.testnet}
          userPublicKey={USER}
          isCex={false}
          onRebuild={vi.fn()}
          convertToXLM={false}
          onConvertToXLMChange={vi.fn()}
        />
      );
    }
    render(<Selected />);
    const copy =
      screen.getByTestId("held-token-convert-toggle").closest("label")?.textContent ?? "";
    expect(copy).not.toMatch(/left as-is/);
    expect(copy).toMatch(/sent to your destination as-is/);
    expect(copy).toMatch(/stops before the merge/);
  });
});
