// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ResidueConsent, type ResidueConsentCredit } from "@/components/warnings/ResidueConsent";
import { NETWORKS } from "@/lib/config/networks";

afterEach(cleanup);

const ISSUER = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";

function renderConsent(credit: Partial<ResidueConsentCredit> = {}) {
  render(
    <ResidueConsent
      credits={[{ key: `FOO:${ISSUER}`, code: "FOO", issuer: ISSUER, amount: "12.5", ...credit }]}
      network={NETWORKS.testnet}
      returnToIssuer={[]}
      sendToDestination={[]}
      onSetDisposal={vi.fn()}
      onRebuild={vi.fn()}
    />,
  );
}

describe("ResidueConsent send-to-destination copy", () => {
  it("says the token goes to the destination and is re-checked, without promising it can't fail", () => {
    renderConsent({ destinationTrusts: true });
    const option = screen.getByTestId(`residue-send-dest-FOO:${ISSUER}`);
    const text = option.textContent ?? "";
    expect(text).toContain("The token goes to your destination address.");
    expect(text).toMatch(/checked again right before the close/);
    expect(text).not.toMatch(/already accepts/);
    expect(text).not.toMatch(/You keep it/);
  });

  it("offers no send-to-destination option when the destination can't take the balance", () => {
    renderConsent({ destinationTrusts: false });
    expect(screen.queryByTestId(`residue-send-dest-FOO:${ISSUER}`)).toBeNull();
    expect(screen.getByTestId(`residue-issuer-FOO:${ISSUER}`)).toBeTruthy();
  });
});
