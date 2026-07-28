import { describe, it, expect } from "vitest";

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
