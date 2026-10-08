import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

import { EMPTY_POSITIONS } from "@/lib/adapters/positions/interface";
import { mediatorLabel } from "@/lib/plan/classic-batcher";
import { generatePlan } from "@/lib/plan/generator";
import type { AccountAudit } from "@/lib/types/account";
import type { ClassicBatch } from "@/lib/types/plan";

import {
  applyRefreshedMediatorFlow,
  FINAL_CLASSIC_TX_NODE_ID,
  MEDIATOR_FORWARD_NODE_ID,
} from "@/lib/mediator/refresh";

function tree(nodes: Record<string, { metadata: Record<string, unknown> }>) {
  return { allNodes: new Map(Object.entries(nodes)) };
}

const FRESH = { mediatorPublicKey: "G_FRESH_MEDIATOR", flowToken: "nonce.exp.mac" };

describe("applyRefreshedMediatorFlow (SEC-01 execute-time re-mint)", () => {
  it("re-points BOTH mediator nodes at the fresh flow with the same key", () => {
    const t = tree({
      [FINAL_CLASSIC_TX_NODE_ID]: {
        metadata: { mediatorPublicKey: "G_OLD", destination: "G_DEST", useMediator: true },
      },
      [MEDIATOR_FORWARD_NODE_ID]: {
        metadata: {
          mediatorPublicKey: "G_OLD",
          flowToken: "old.token",
          ultimateDestination: "G_DEST",
        },
      },
    });

    expect(applyRefreshedMediatorFlow(t, FRESH)).toBe(true);

    const final = t.allNodes.get(FINAL_CLASSIC_TX_NODE_ID)!.metadata;
    const fwd = t.allNodes.get(MEDIATOR_FORWARD_NODE_ID)!.metadata;

    expect(final.mediatorPublicKey).toBe("G_FRESH_MEDIATOR");
    expect(fwd.mediatorPublicKey).toBe("G_FRESH_MEDIATOR");
    expect(fwd.flowToken).toBe("nonce.exp.mac");
    // the merge target and the forward source MUST remain the same account
    expect(final.mediatorPublicKey).toBe(fwd.mediatorPublicKey);
    // unrelated fields are preserved (the reviewed destination does not change)
    expect(final.destination).toBe("G_DEST");
    expect(final.useMediator).toBe(true);
    expect(fwd.ultimateDestination).toBe("G_DEST");
  });

  it("no-ops (returns false) for a direct close with no mediator-forward node", () => {
    const t = tree({
      [FINAL_CLASSIC_TX_NODE_ID]: { metadata: { destination: "G_DEST" } },
    });
    expect(applyRefreshedMediatorFlow(t, FRESH)).toBe(false);
    expect(t.allNodes.get(FINAL_CLASSIC_TX_NODE_ID)!.metadata.mediatorPublicKey).toBeUndefined();
  });

  it("updates the forward node even if the final node is missing", () => {
    const t = tree({
      [MEDIATOR_FORWARD_NODE_ID]: { metadata: { mediatorPublicKey: "G_OLD", flowToken: "old" } },
    });
    expect(applyRefreshedMediatorFlow(t, FRESH)).toBe(true);
    const fwd = t.allNodes.get(MEDIATOR_FORWARD_NODE_ID)!.metadata;
    expect(fwd.mediatorPublicKey).toBe("G_FRESH_MEDIATOR");
    expect(fwd.flowToken).toBe("nonce.exp.mac");
  });
});

describe("applyRefreshedMediatorFlow on a generated plan", () => {
  const account = Keypair.random().publicKey();
  const dest = Keypair.random().publicKey();
  const previewMediator = Keypair.random().publicKey();
  const freshMediator = Keypair.random().publicKey();
  const audit: AccountAudit = {
    accountId: account,
    sequence: "1",
    subentryCount: 0,
    thresholds: { low: 0, medium: 0, high: 0, masterWeight: 1 },
    flags: {
      authImmutable: false,
      authRequired: false,
      authRevocable: false,
      authClawbackEnabled: false,
    },
    balances: [],
    signers: [],
    offers: [],
    data: [],
    claimableBalances: [],
    poolShares: [],
    sponsorship: { numSponsoring: 0, numSponsored: 0, coverable: 0 },
    requiresMultisig: false,
    mergeability: { mergeable: true },
  };

  it("repoints the batches, their summaries and the node description at the new mediator", () => {
    const tree = generatePlan(audit, EMPTY_POSITIONS, [], dest, {
      useMediator: true,
      mediatorPublicKey: previewMediator,
      flowToken: "preview-token",
    });
    const final = tree.allNodes.get(FINAL_CLASSIC_TX_NODE_ID)!;
    expect(final.description).toContain(mediatorLabel(previewMediator));

    expect(
      applyRefreshedMediatorFlow(tree, { mediatorPublicKey: freshMediator, flowToken: "fresh" }),
    ).toBe(true);

    const md = final.metadata as { mediatorPublicKey: string; batches: readonly ClassicBatch[] };
    expect(md.mediatorPublicKey).toBe(freshMediator);
    const ops = md.batches.flatMap((b) => b.operations);
    const funding = ops.find((o) => o.kind === "create_account_mediator")!;
    const merge = ops.find((o) => o.kind === "account_merge")!;
    expect(funding.metadata.destination).toBe(freshMediator);
    expect(merge.metadata.destination).toBe(freshMediator);
    // the final destination the user reviewed is untouched
    expect(merge.metadata.ultimateDestination).toBe(dest);
    expect(md.batches.some((b) => b.mediator?.publicKey === freshMediator)).toBe(true);
    expect(md.batches.some((b) => b.mediator?.publicKey === previewMediator)).toBe(false);

    const text = [final.description, ...ops.map((o) => o.summary)].join("\n");
    expect(text).not.toContain(previewMediator.slice(0, 6));
    expect(text).toContain(mediatorLabel(freshMediator));
  });
});
