// @vitest-environment happy-dom

// the step that claims what an aquarius pool's reward gauges owe, as the Review
// shows it

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Asset, StrKey } from "@stellar/stellar-sdk";

import { PlanRow } from "@/app/demolish/_components/PlanRow";
import {
  groupPlanNodes,
  nodeExplainer,
  nodeLabel,
  nodePlainLabel,
  phaseForNode,
} from "@/app/demolish/_lib/plan-copy";
import { computeReviewMoney } from "@/app/demolish/_lib/review-money";
import { TESTNET } from "@/lib/config/networks";
import { topologicalOrder, type PlanNode } from "@/lib/plan/tree";

import { emptyPositions, makeAudit, makeTree } from "./demolish-fixtures";

afterEach(cleanup);

const XLM = Asset.native().contractId(TESTNET.passphrase);
const TOKEN = StrKey.encodeContract(Buffer.alloc(32, 71));
const POOL = StrKey.encodeContract(Buffer.alloc(32, 72));
const INDEX = "ab".repeat(32);

function gaugeTree() {
  return makeTree({
    positions: emptyPositions({
      aquarius: [{ poolIndex: INDEX, shareBalance: 3n, tokens: [XLM, TOKEN] }],
    }),
    opts: {
      network: TESTNET,
      aquariusGaugeRewards: [
        {
          poolAddress: POOL,
          tokens: [XLM, TOKEN],
          poolIndex: INDEX,
          rewards: [
            { token: XLM, amount: 1_126_439_834n },
            { token: TOKEN, amount: 40n },
          ],
          gaugeTokens: [XLM, TOKEN],
        },
      ],
    },
  });
}

function gaugeNode(): PlanNode {
  const node = [...gaugeTree().allNodes.values()].find(
    (n) => (n.kind as string) === "ClaimAquariusGaugeRewards",
  );
  if (node === undefined) throw new Error("no gauge claim planned");
  return node;
}

describe("the aquarius gauge reward claim on Review", () => {
  it("is labelled as a gauge reward claim and grouped with the reward claims", () => {
    const node = gaugeNode();
    expect(phaseForNode(node)).toBe("Claim rewards");
    expect(nodeLabel(node)).toBe("Claim Aquarius gauge rewards");
    expect(nodePlainLabel(node)).toBe("Collect Aquarius gauge rewards");
    expect(nodeExplainer(node, { deterministic: false })).toMatch(
      /reward gauges .* before your share of the pool is withdrawn/,
    );
  });

  it("says what each gauge owed when the plan was built", () => {
    const node = gaugeNode();
    expect(node.description).toBe(
      `Claim the Aquarius gauge rewards of pool ${POOL.slice(0, 6)}…${POOL.slice(-4)}: ` +
        `112.6439834 XLM and 40 base units of token ${TOKEN.slice(0, 6)}…${TOKEN.slice(-4)}`,
    );
    render(<PlanRow node={node} network={TESTNET} mode="plan" index={1} />);
    expect(screen.getByText("Collect Aquarius gauge rewards")).toBeTruthy();
    expect(screen.getByTitle(node.description)).toBeTruthy();
  });

  it("is listed ahead of the withdraw it runs before", () => {
    const ordered = topologicalOrder(gaugeTree());
    const phases = groupPlanNodes(ordered).map((g) => g.phase);
    expect(phases.indexOf("Claim rewards")).toBeLessThan(phases.indexOf("DeFi withdrawals"));
  });

  it("counts as DeFi proceeds the review does not add to the amount", () => {
    const money = computeReviewMoney({ audit: makeAudit(), ordered: [gaugeNode()] });
    expect(money.notCounted).toHaveLength(1);
    expect(money.notCounted[0]).toMatch(/^What 1 DeFi step /);
  });
});
