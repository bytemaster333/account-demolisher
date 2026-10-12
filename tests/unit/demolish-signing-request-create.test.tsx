// @vitest-environment happy-dom

// creating a shared-account signing request: the relay's answer is checked
// against the transaction the initiator signed before anything is shown or
// stored (UIDM-08, NPF-28). the relay, the chain reads and the wallet are
// stubbed at their network edges; the hook, the bundle builder and the store
// run for real.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { Account, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";

import { TESTNET } from "@/lib/config/networks";
import type { PageFlowRunInput } from "@/lib/orchestrator/page-flow-machine";
import type { Connector } from "@/lib/wallet/connector";

import { ACC, DEST, emptyPositions, makeAudit, makeTree } from "./demolish-fixtures";

const LEDGER_TIME = 2_000_000_000;

vi.mock("@/lib/adapters/positions/direct", () => ({
  DirectContractProvider: class {
    getPositions = async () => emptyPositions();
  },
}));
vi.mock("@/lib/stellar/ledger-clock", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stellar/ledger-clock")>()),
  fetchLedgerClock: async () => ({ sequence: 5000, closedAt: LEDGER_TIME }),
}));
vi.mock("@/lib/stellar/horizon-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stellar/horizon-client")>()),
  getHorizon: () => ({ loadAccount: async () => new Account(ACC, "4100") }),
}));

import { useSigningRequest } from "@/app/demolish/_hooks/use-signing-request";
import { loadSigningRequest } from "@/app/demolish/_lib/signing-request-store";

// the hex hash of every transaction the wallet was asked to sign
const signedHashes: string[] = [];
const connector = {
  kind: "secret",
  signTransaction: async (tx: Transaction) => {
    signedHashes.push(Buffer.from(tx.hash()).toString("hex"));
    return { signedXdr: tx.toXDR(), signerAddress: ACC };
  },
} as unknown as Connector;

// what the relay answers to the publish, given the envelope it was sent
let relayId: (xdr: string) => string;

beforeEach(() => {
  signedHashes.length = 0;
  window.localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url !== "/api/plan" || init?.method !== "POST") {
        throw new Error(`unexpected request ${url}`);
      }
      const { xdr } = JSON.parse(String(init.body)) as { xdr: string };
      return new Response(JSON.stringify({ id: relayId(xdr) }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderCreate() {
  const runInput = {
    publicKey: ACC,
    network: TESTNET,
    destination: DEST,
    useMediator: false,
    deterministicDisposal: true,
    signerKind: "secret",
  } as PageFlowRunInput;
  return renderHook(() =>
    useSigningRequest({
      runInput,
      connector,
      audit: makeAudit(),
      tree: makeTree(),
      network: TESTNET,
      gate: { ok: true },
      runMismatched: false,
      isAwaitingConfirmation: true,
      publicKey: ACC,
      storeNetworkId: TESTNET.id,
      nowMs: LEDGER_TIME * 1000,
    }),
  );
}

function hashOfXdr(xdr: string): string {
  const tx = TransactionBuilder.fromXdr(xdr, TESTNET.passphrase) as Transaction;
  return Buffer.from(tx.hash()).toString("hex");
}

describe("creating a signing request checks the relay's id (UIDM-08)", () => {
  it("refuses an id that is not the signed transaction's hash, and stores nothing", async () => {
    relayId = () => "ff".repeat(32);
    const { result } = renderCreate();
    await act(async () => {
      await result.current.create();
    });
    expect(signedHashes).toHaveLength(1);
    expect(result.current.error).toBe(
      "The relay returned an id that doesn't match the signed transaction.",
    );
    expect(result.current.active).toBeNull();
    expect(loadSigningRequest(ACC, TESTNET.id, LEDGER_TIME * 1000)).toBeNull();
  });

  it("accepts the signed transaction's hash in any letter case and stores the request", async () => {
    relayId = (xdr) => hashOfXdr(xdr).toUpperCase();
    const { result } = renderCreate();
    await act(async () => {
      await result.current.create();
    });
    expect(result.current.error).toBeNull();
    expect(result.current.active?.planId).toBe(signedHashes[0]!.toUpperCase());
    expect(loadSigningRequest(ACC, TESTNET.id, LEDGER_TIME * 1000)?.planId).toBe(
      signedHashes[0]!.toUpperCase(),
    );
  });
});
