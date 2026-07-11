import { Account, Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import { describe, it, expect } from "vitest";

import { TESTNET } from "@/lib/config/networks";
import { RefractorClient } from "@/lib/multisig/refractor";
import {
  assessBundleability,
  buildClosurePlanTransaction,
  planSignerSet,
  refractorNetworkToken,
  PLAN_SIGNING_WINDOW_SECONDS,
} from "@/lib/multisig/closure-plan";
import type { AccountAudit } from "@/lib/types/account";

const MASTER = Keypair.random().publicKey();
const COSIGNER = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();

// a bare 2-of-2 account: native balance only, one co-signer, high thresholds.
// batchClassicDemolition only reads the fields set below; the rest aren't
// consulted, so a cast keeps the fixture small.
function bareMultisigAudit(): AccountAudit {
  return {
    accountId: MASTER,
    sequence: "100",
    subentryCount: 1,
    thresholds: { low: 2, medium: 2, high: 2, masterWeight: 1 },
    balances: [],
    signers: [
      { key: MASTER, type: "ed25519_public_key", weight: 1 },
      { key: COSIGNER, type: "ed25519_public_key", weight: 1 },
    ],
    offers: [],
    data: [],
    claimableBalances: [],
    poolShares: [],
  } as unknown as AccountAudit;
}

function sourceAccount() {
  // TransactionBuilder accepts any Account-shaped object for sequence tracking
  return new Account(MASTER, "100") as unknown as Parameters<
    typeof buildClosurePlanTransaction
  >[0]["sourceAccount"];
}

describe("buildClosurePlanTransaction (bare 2-of-2)", () => {
  it("bundles remove-signer + threshold-reset + merge into ONE transaction", () => {
    const tx = buildClosurePlanTransaction({
      audit: bareMultisigAudit(),
      destination: DEST,
      network: TESTNET,
      sourceAccount: sourceAccount(),
    });

    const kinds = tx.operations.map((op) => op.type);
    // exactly one merge, and it's last
    expect(kinds.filter((k) => k === "accountMerge")).toHaveLength(1);
    expect(kinds[kinds.length - 1]).toBe("accountMerge");
    // the co-signer is removed via setOptions
    expect(kinds).toContain("setOptions");
    // the merge targets the chosen destination
    const merge = tx.operations.find((op) => op.type === "accountMerge") as {
      destination: string;
    };
    expect(merge.destination).toBe(DEST);
  });

  it("uses a long (multisig) signing window, not the short live-execute default", () => {
    const tx = buildClosurePlanTransaction({
      audit: bareMultisigAudit(),
      destination: DEST,
      network: TESTNET,
      sourceAccount: sourceAccount(),
    });
    const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
    const now = Math.floor(Date.now() / 1000);
    // ~72h out (well beyond the 5-minute live default), allow a minute of drift
    expect(maxTime - now).toBeGreaterThan(PLAN_SIGNING_WINDOW_SECONDS - 60);
    expect(maxTime - now).toBeLessThanOrEqual(PLAN_SIGNING_WINDOW_SECONDS + 60);
  });

  it("re-parses (round-trips) as a valid classic transaction", () => {
    const tx = buildClosurePlanTransaction({
      audit: bareMultisigAudit(),
      destination: DEST,
      network: TESTNET,
      sourceAccount: sourceAccount(),
    });
    const reparsed = TransactionBuilder.fromXDR(tx.toXDR(), Networks.TESTNET);
    expect(reparsed.hash().toString("hex")).toBe(tx.hash().toString("hex"));
  });

  it("rejects a self-merge (destination == account)", () => {
    expect(() =>
      buildClosurePlanTransaction({
        audit: bareMultisigAudit(),
        destination: MASTER,
        network: TESTNET,
        sourceAccount: sourceAccount(),
      }),
    ).toThrow(/self-merge|must differ/);
  });
});

describe("planSignerSet / refractorNetworkToken", () => {
  it("returns every signer with positive weight", () => {
    expect(planSignerSet(bareMultisigAudit())).toEqual([MASTER, COSIGNER]);
  });
  it("maps mainnet -> public, others verbatim", () => {
    expect(refractorNetworkToken(TESTNET)).toBe("testnet");
  });
});

describe("assessBundleability", () => {
  it("allows a plain classic close", () => {
    expect(
      assessBundleability({
        hasSorobanPositions: false,
        hasSelectedAllowances: false,
        useMediator: false,
      }).ok,
    ).toBe(true);
  });
  it("blocks Soroban positions, allowances, and the mediator flow", () => {
    expect(
      assessBundleability({
        hasSorobanPositions: true,
        hasSelectedAllowances: false,
        useMediator: false,
      }).ok,
    ).toBe(false);
    expect(
      assessBundleability({
        hasSorobanPositions: false,
        hasSelectedAllowances: true,
        useMediator: false,
      }).ok,
    ).toBe(false);
    expect(
      assessBundleability({
        hasSorobanPositions: false,
        hasSelectedAllowances: false,
        useMediator: true,
      }).ok,
    ).toBe(false);
  });
});

// build a RefractorClient whose fetch records the request and returns `body`
function clientCapturing(body: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { client: new RefractorClient({ fetchImpl }), calls };
}

describe("RefractorClient.createPlan", () => {
  it("POSTs the envelope + desiredSigners and returns the plan hash", async () => {
    const { client, calls } = clientCapturing({ hash: "abc123", network: "testnet" });
    const res = await client.createPlan({
      xdr: "AAAAxdr",
      network: "testnet",
      desiredSigners: [MASTER, COSIGNER],
    });

    expect(res.hash).toBe("abc123");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/\/tx$/);
    expect(calls[0]!.init.method).toBe("POST");
    const sent = JSON.parse(String(calls[0]!.init.body));
    expect(sent).toMatchObject({
      network: "testnet",
      xdr: "AAAAxdr",
      submit: true,
      desiredSigners: [MASTER, COSIGNER],
    });
  });

  it("throws with the server detail on a non-2xx", async () => {
    const { client } = clientCapturing({ error: "bad envelope" }, 400);
    await expect(client.createPlan({ xdr: "AAAAxdr", network: "testnet" })).rejects.toThrow(
      /createPlan failed.*bad envelope/,
    );
  });

  it("rejects an empty xdr before calling the network", async () => {
    const { client, calls } = clientCapturing({ hash: "x" });
    await expect(client.createPlan({ xdr: "", network: "testnet" })).rejects.toThrow(/xdr/);
    expect(calls).toHaveLength(0);
  });
});
