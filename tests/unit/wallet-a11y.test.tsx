// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/soroban/rpc-client", () => ({ getRpc: () => ({}) }));
vi.mock("@/lib/soroban/sep41", () => ({ balance: async () => 0n }));

import { DemoStepList, type DemoStepRow } from "@/components/wallet/DemoStepList";
import { StandaloneTokensCard } from "@/components/wallet/StandaloneTokensCard";
import { TESTNET } from "@/lib/config/networks";

afterEach(cleanup);

const rows: DemoStepRow[] = [
  { id: "keypair", label: "Generate fresh keypair", description: "", status: "done" },
  { id: "friendbot", label: "Fund with friendbot", description: "", status: "active" },
  { id: "trustlines", label: "Add trustlines", description: "", status: "pending" },
];

describe("DemoStepList", () => {
  it("exposes each step status as an image with a name", () => {
    render(<DemoStepList rows={rows} />);
    expect(screen.getByRole("img", { name: "Done" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "In progress" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Pending" })).toBeTruthy();
  });

  it("announces the current step through a polite live region", () => {
    const { rerender } = render(<DemoStepList rows={rows} />);
    const live = screen.getByTestId("demo-step-live");
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.textContent).toMatch(/Fund with friendbot: in progress/);
    rerender(
      <DemoStepList
        rows={[rows[0]!, { ...rows[1]!, status: "failed", error: "timed out" }, rows[2]!]}
      />,
    );
    expect(screen.getByTestId("demo-step-live").textContent).toMatch(/Fund with friendbot: failed/);
  });
});

describe("StandaloneTokensCard manual add", () => {
  function renderCard() {
    render(
      <StandaloneTokensCard
        discovered={[
          { contractId: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC", balance: 12n },
        ]}
        unreadable={[]}
        selected={[]}
        onChange={() => {}}
        network={TESTNET}
        userPublicKey="GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3"
        isCex={false}
        onRebuild={() => {}}
      />,
    );
  }

  it("gives the contract input an accessible name", () => {
    renderCard();
    expect(screen.getByLabelText("Add a token by contract address")).toBe(
      screen.getByTestId("held-token-manual-input"),
    );
  });

  it("announces a manual add error", async () => {
    renderCard();
    fireEvent.change(screen.getByTestId("held-token-manual-input"), {
      target: { value: "not-a-contract" },
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Check & add"));
    });
    expect(screen.getByRole("alert").textContent).toMatch(/valid contract address/);
  });

  it("labels the balance as a snapshot from the scan", () => {
    renderCard();
    expect(screen.getByText(/12 raw/).textContent).toMatch(/at scan time/);
  });
});
