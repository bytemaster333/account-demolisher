// @vitest-environment happy-dom

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";
import { useState } from "react";

import { MAINNET, TESTNET } from "@/lib/config/networks";

// the wallet pickers pull in the wallets kit, which doesn't load in this test
// environment; IdleConnect only needs something it can show or hide
vi.mock("@/components/wallet/ConnectButton", () => ({
  ConnectButton: () => <button type="button">connect-wallet</button>,
}));
vi.mock("@/components/wallet/SecretKeyFallback", () => ({
  SecretKeyFallback: () => null,
}));
vi.mock("@/components/wallet/CreateTestAccountButton", () => ({
  CreateTestAccountButton: ({
    onActiveChange,
  }: {
    readonly onActiveChange?: (active: boolean) => void;
  }) => (
    <button type="button" data-testid="start-demo" onClick={() => onActiveChange?.(true)}>
      start demo
    </button>
  ),
}));

import { CancelledPanel } from "@/app/demolish/_components/CancelledPanel";
import { ConfigurePanel } from "@/app/demolish/_components/ConfigurePanel";
import { IdleConnect } from "@/app/demolish/_components/IdleConnect";
import { MultisigContextBar } from "@/app/demolish/_components/MultisigContextBar";
import { INITIAL_FORM, type FormState } from "@/app/demolish/_lib/form";

afterEach(cleanup);

type ConfigureProps = Parameters<typeof ConfigurePanel>[0];

function ConfigureHarness(over: Partial<ConfigureProps>) {
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  return (
    <>
      <ConfigurePanel
        form={form}
        setForm={setForm}
        cex={null}
        hasMemo={false}
        formError={null}
        canStart={false}
        startHint={null}
        onGeneratePlan={() => {}}
        isDemo={false}
        deterministic={false}
        preflight={{ status: "ready" }}
        {...over}
      />
      <output data-testid="form-destination">{form.destination}</output>
    </>
  );
}

describe("ConfigurePanel", () => {
  it("has no backup address field (M-08)", () => {
    render(<ConfigureHarness />);
    expect(screen.queryByTestId("fallback-input")).toBeNull();
    expect(document.body.textContent ?? "").not.toMatch(/Backup address/i);
  });

  it("trims a pasted destination as it is typed (L-53)", () => {
    render(<ConfigureHarness />);
    const key = Keypair.random().publicKey();
    fireEvent.change(screen.getByTestId("destination-input"), { target: { value: ` ${key}  ` } });
    expect(screen.getByTestId("form-destination").textContent).toBe(key);
  });

  it("links the destination input to the hint and error and marks it invalid (L-64)", () => {
    render(
      <ConfigureHarness startHint="That isn't a valid Stellar G… address." formError="Nope" />,
    );
    const input = screen.getByTestId("destination-input");
    const described = (input.getAttribute("aria-describedby") ?? "").split(" ");
    expect(described).toContain("demolish-start-hint");
    expect(described).toContain("demolish-form-error");
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  it("names the memo input with a plain label (L-64)", () => {
    render(<ConfigureHarness />);
    const memo = screen.getByTestId("memo-value-input");
    const labelId = memo.getAttribute("aria-labelledby")!;
    const label = document.getElementById(labelId)!;
    expect(label.textContent?.trim()).toBe("Memo value");
    expect(label.querySelector("button")).toBeNull();
  });

  it("does not say every asset is swapped to XLM (L-59)", () => {
    render(<ConfigureHarness />);
    expect(document.body.textContent ?? "").not.toMatch(
      /Every other asset in this account is swapped/,
    );
  });

  it("explains the helper account hop without claiming a merge can't carry a memo (L-59)", () => {
    render(
      <ConfigureHarness
        hasMemo
        cex={{ name: "Ex", requiresMemo: true, memoType: "text" } as ConfigureProps["cex"]}
      />,
    );
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/can't carry a memo/);
    expect(text).toMatch(/Exchanges don't credit an account merge/);
  });

  it("shows a failed account check with a retry and keeps Continue off (M-32)", () => {
    const retry = vi.fn();
    render(
      <ConfigureHarness
        canStart
        preflight={{ status: "error", message: "Horizon is down", retry }}
      />,
    );
    expect((screen.getByTestId("demolish-start") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("preflight-check-retry"));
    expect(retry).toHaveBeenCalled();
  });

  it("keeps Continue off while the account check is still running (M-32)", () => {
    render(<ConfigureHarness canStart preflight={{ status: "loading" }} />);
    expect((screen.getByTestId("demolish-start") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("CancelledPanel (L-52, L-62)", () => {
  it("says the wallet changed when the cancel was automatic, with its own test id", () => {
    render(
      <CancelledPanel reason="wallet-changed" publishedRequest={null} onStartOver={() => {}} />,
    );
    expect(document.body.textContent ?? "").toMatch(/wallet or network changed/i);
    expect(document.body.textContent ?? "").not.toMatch(/You cancelled/);
    expect(screen.getByTestId("demolish-cancelled-reset")).toBeTruthy();
    expect(screen.queryByTestId("demolish-reset")).toBeNull();
  });

  it("warns that a published signing request stays valid until it expires", () => {
    const validUntil = new Date("2026-10-05T10:00:00Z");
    render(
      <CancelledPanel
        reason="user"
        publishedRequest={{ planId: "f".repeat(64), validUntil }}
        onStartOver={() => {}}
      />,
    );
    const note = screen.getByTestId("cancelled-request-note").textContent ?? "";
    expect(note).toMatch(/stays valid until/i);
    expect(note).toMatch(/bump sequence/i);
  });
});

describe("MultisigContextBar (L-63)", () => {
  it("labels weights as weights and shows how many signers that takes", () => {
    const signers = [5, 5, 5].map((weight) => ({
      key: Keypair.random().publicKey(),
      type: "ed25519_public_key" as const,
      weight,
    }));
    render(<MultisigContextBar threshold={10} have={5} signers={signers} />);
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/Signatures needed/);
    expect(text).toMatch(/Signing weight needed: 10/);
    expect(text).toMatch(/your key's weight: 5/);
    expect(text).toMatch(/at least 2 signers/);
  });
});

describe("IdleConnect after a network switch (L-55)", () => {
  it("shows the connect options on a network without the demo", () => {
    const props = {
      advancedOpen: false,
      onToggleAdvanced: () => {},
      onKitConnector: () => {},
      onSecretConnector: () => {},
    };
    const { rerender } = render(<IdleConnect {...props} network={TESTNET} />);
    fireEvent.click(screen.getByTestId("start-demo"));
    expect(screen.queryByText("connect-wallet")).toBeNull();
    rerender(<IdleConnect {...props} network={MAINNET} />);
    expect(screen.getByText("connect-wallet")).toBeTruthy();
  });
});
