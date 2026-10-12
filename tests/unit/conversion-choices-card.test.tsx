// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ConversionChoicesCard } from "@/app/demolish/_components/ConversionChoicesCard";
import type { RoutableCredit } from "@/lib/plan/classic-batcher";

afterEach(cleanup);

const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

function credit(destinationTrusts: boolean | undefined): RoutableCredit {
  return {
    key: `USDC:${ISSUER}`,
    code: "USDC",
    issuer: ISSUER,
    amount: "3.1635420",
    ...(destinationTrusts === undefined ? {} : { destinationTrusts }),
  };
}

function renderCard(c: RoutableCredit, viaExchange = false) {
  render(
    <ConversionChoicesCard
      choices={{ credits: [c], viaExchange, choiceFor: () => "sell", onChoose: () => {} }}
    />,
  );
  return screen.getByTestId("conversion-choices").textContent ?? "";
}

describe("ConversionChoicesCard only promises the choices it shows", () => {
  it("says why sending as-is is missing when the destination can't take the token", () => {
    renderCard(credit(false));
    expect(screen.queryByTestId(`conversion-send-USDC:${ISSUER}`)).toBeNull();
    expect(screen.getByTestId(`conversion-send-unavailable-USDC:${ISSUER}`).textContent).toMatch(
      /no authorized USDC trustline with room for this amount/,
    );
  });

  it("offers sending as-is without the note when the destination can take it", () => {
    renderCard(credit(true));
    expect(screen.getByTestId(`conversion-send-USDC:${ISSUER}`)).toBeTruthy();
    expect(screen.queryByTestId(`conversion-send-unavailable-USDC:${ISSUER}`)).toBeNull();
  });

  it("never mentions sending as-is on an exchange close", () => {
    const text = renderCard(credit(false), true);
    expect(text).not.toMatch(/as it is|as-is/);
    expect(text).toMatch(/return one to its issuer instead\. A change applies/);
  });
});
