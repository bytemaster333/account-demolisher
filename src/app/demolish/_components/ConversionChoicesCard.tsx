"use client";

import { Notice } from "@/components/ui";
import type { RoutableCredit } from "@/lib/plan/classic-batcher";

import { ChoiceButton } from "./ResolvePanel";

// what happens to a credit balance the close can sell for XLM within the price
// cap: sold (the default), sent unchanged to the destination, or paid back to
// its issuer
export type ConversionChoice = "sell" | "destination" | "issuer";

export interface ConversionChoices {
  readonly credits: readonly RoutableCredit[];
  readonly choiceFor: (key: string) => ConversionChoice;
  readonly onChoose: (key: string, choice: ConversionChoice) => void;
}

// every conversion the close plans, with the other ways to dispose of the
// balance. A change applies when the plan is rebuilt.
export function ConversionChoicesCard({
  choices,
}: {
  readonly choices: ConversionChoices;
}): React.JSX.Element {
  return (
    <Notice
      tone="neutral"
      title="Balances this close sells for XLM"
      data-testid="conversion-choices"
    >
      Each of these is sold for XLM at the market price, within the 2% the close allows. You can
      send one to your destination as it is, where the destination can take it, or return it to its
      issuer instead. A change applies when you rebuild the plan.
      <ul style={{ listStyle: "none", margin: "10px 0 0", padding: 0 }}>
        {choices.credits.map((c) => {
          const choice = choices.choiceFor(c.key);
          return (
            <li
              key={c.key}
              data-testid={`conversion-choice-${c.key}`}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 7,
                padding: "8px 0",
                borderTop: "1px solid var(--border)",
              }}
            >
              <span style={{ font: "600 12.5px/1.4 'Geist Mono', monospace" }}>
                {c.amount} {c.code}
              </span>
              <div
                role="group"
                aria-label={`What to do with ${c.amount} ${c.code}`}
                style={{ display: "flex", gap: 7, flexWrap: "wrap" }}
              >
                <ChoiceButton
                  selected={choice === "sell"}
                  onClick={() => choices.onChoose(c.key, "sell")}
                  testId={`conversion-sell-${c.key}`}
                  label="Sell for XLM"
                />
                {c.destinationTrusts === true ? (
                  <ChoiceButton
                    selected={choice === "destination"}
                    onClick={() => choices.onChoose(c.key, "destination")}
                    testId={`conversion-send-${c.key}`}
                    label="Send it as-is to your destination"
                  />
                ) : null}
                <ChoiceButton
                  selected={choice === "issuer"}
                  onClick={() => choices.onChoose(c.key, "issuer")}
                  testId={`conversion-issuer-${c.key}`}
                  label="Return to issuer (keep nothing)"
                />
              </div>
            </li>
          );
        })}
      </ul>
    </Notice>
  );
}
