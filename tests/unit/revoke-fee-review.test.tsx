// @vitest-environment happy-dom

import { act, cleanup, render, screen } from "@testing-library/react";
import {
  Account,
  Address,
  SorobanDataBuilder,
  rpc,
  xdr,
  type Operation,
  type Transaction,
} from "@stellar/stellar-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// the /allowances revoke controls on the real revoke path (build, auth guard,
// fee cap, sign, send). a pasted-secret connector signs without any prompt of
// its own, so the page itself must put the fee on screen before signTransaction
// runs. only the network edge (rpc server, ledger clock) is stood in for.

const TOKEN = "CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD";
const TOKEN_2 = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const TOKEN_HOSTILE = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
const USER = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
const SPENDER = "GAVH5ZWACAY2PHPUG4FL3LHHJIYIHOFPSIUGM2KHK25CJWXHAV6QKDMN";

const RESOURCE_FEE = 15_929n;
let accountSeq = "100";

function approveAuth(call: xdr.InvokeContractArgs): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(call),
      subInvocations: [],
    }),
  });
}

const server = {
  getLatestLedger: async () => ({ id: "x", sequence: 5000, protocolVersion: 23 }),
  getAccount: async () => new Account(USER, accountSeq),
  simulateTransaction: async (
    tx: Transaction,
  ): Promise<rpc.Api.SimulateTransactionSuccessResponse> => {
    const call = xdr.expectUnionVariant(
      (tx.operations[0] as Operation.InvokeHostFunction).func,
      "hostFunctionTypeInvokeContract",
    ).invokeContract;
    const token = Address.fromScAddress(call.contractAddress).toString();
    // a hostile token's own code asks for a resource fee no revoke needs
    const resourceFee = token === TOKEN_HOSTILE ? 4_000_000n : RESOURCE_FEE;
    const data = new SorobanDataBuilder()
      .setResourceFee(resourceFee)
      .setResources(200_000, 0, 0)
      .build();
    return {
      id: "1",
      latestLedger: 5000,
      events: [],
      _parsed: true,
      minResourceFee: resourceFee.toString(),
      transactionData: new SorobanDataBuilder(data),
      result: { auth: [approveAuth(call)], retval: xdr.ScVal.scvVoid() },
    };
  },
  // the tx lands at once: the account's sequence moves to it
  sendTransaction: async (tx: Transaction) => {
    accountSeq = tx.sequence;
    return { status: "PENDING", hash: Buffer.from(tx.hash()).toString("hex") };
  },
  pollTransaction: async () => ({ status: "SUCCESS", ledger: 5001 }),
};
vi.mock("@/lib/soroban/rpc-client", () => ({ getRpc: () => server }));
vi.mock("@/lib/stellar/ledger-clock", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stellar/ledger-clock")>()),
  fetchLedgerClock: async () => ({ sequence: 5000, closedAt: 1_700_000_000 }),
}));

import { BulkRevokeBar } from "@/components/allowance-viewer/BulkRevokeBar";
import { RevokeButton } from "@/components/allowance-viewer/RevokeButton";
import { TESTNET } from "@/lib/config/networks";
import type { AllowanceRecord } from "@/lib/soroban/allowances";
import type { Connector } from "@/lib/wallet/connector";

function record(contractId: string): AllowanceRecord {
  return {
    contractId,
    spender: SPENDER,
    amount: 1_000n,
    live_until_ledger: 10_000_000,
    lastSeenLedger: 1,
    expired: false,
    onChainAmount: 1_000n,
  };
}

function connector() {
  const signed: Transaction[] = [];
  const signTransaction = vi.fn(async (tx: Transaction) => {
    signed.push(tx);
    return { signedXdr: tx.toXDR(), signerPublicKey: USER };
  });
  const c = { getPublicKey: async () => USER, signTransaction } as unknown as Connector;
  return { ref: { current: c }, signed, signTransaction };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

beforeEach(() => {
  accountSeq = "100";
});
afterEach(cleanup);

describe("RevokeButton shows the fee before signing", () => {
  const rowId = `${TOKEN}-${SPENDER}`;

  function renderButton(ref: React.RefObject<Connector | null>) {
    render(
      <RevokeButton
        record={record(TOKEN)}
        userAddress={USER}
        network={TESTNET}
        connectorRef={ref}
      />,
    );
  }

  it("renders the fee and signs only after the user accepts it", async () => {
    const { ref, signed, signTransaction } = connector();
    renderButton(ref);
    await act(async () => {
      screen.getByTestId(`revoke-button-${rowId}`).click();
    });
    await settle();
    expect(screen.getByTestId(`revoke-fee-${rowId}`).textContent).toBe(
      "Network fee up to 0.0115929 XLM",
    );
    expect(signTransaction).not.toHaveBeenCalled();

    await act(async () => {
      screen.getByTestId(`revoke-sign-${rowId}`).click();
    });
    await settle();
    expect(signTransaction).toHaveBeenCalledTimes(1);
    expect(signed[0]!.fee).toBe("115929");
    expect(screen.getByTestId(`revoke-button-${rowId}`).textContent).toMatch(/Revoked/);
  });

  it("signs nothing when the user cancels at the fee", async () => {
    const { ref, signTransaction } = connector();
    renderButton(ref);
    await act(async () => {
      screen.getByTestId(`revoke-button-${rowId}`).click();
    });
    await settle();
    await act(async () => {
      screen.getByTestId(`revoke-cancel-${rowId}`).click();
    });
    await settle();
    expect(screen.queryByTestId(`revoke-fee-${rowId}`)).toBeNull();
    expect(screen.getByTestId(`revoke-button-${rowId}`).textContent).toBe("Revoke");
    expect(signTransaction).not.toHaveBeenCalled();
  });
});

describe("BulkRevokeBar shows the summed fee before signing", () => {
  it("renders the total fee, leaves out a revoke over the cap, and signs after the user accepts", async () => {
    const { ref, signed, signTransaction } = connector();
    render(
      <BulkRevokeBar
        records={[record(TOKEN), record(TOKEN_HOSTILE), record(TOKEN_2)]}
        userAddress={USER}
        network={TESTNET}
        connectorRef={ref}
        onComplete={() => {}}
      />,
    );
    await act(async () => {
      screen.getByTestId("bulk-revoke-all").click();
    });
    await settle();
    expect(screen.getByTestId("bulk-revoke-fee-total").textContent).toBe(
      "Network fees: up to 0.0231858 XLM in total.",
    );
    expect(screen.getByTestId("bulk-revoke-not-prepared").textContent).toMatch(
      /Refusing to sign: this step would cost 0\.41 XLM/,
    );
    expect(screen.getByTestId("bulk-revoke-confirm-go").textContent).toBe("Revoke 2");
    expect(signTransaction).not.toHaveBeenCalled();

    await act(async () => {
      screen.getByTestId("bulk-revoke-confirm-go").click();
    });
    await settle();
    expect(signTransaction).toHaveBeenCalledTimes(2);
    expect(signed.map((tx) => tx.sequence)).toEqual(["101", "102"]);
    expect(screen.getByTestId("bulk-revoke-done").textContent).toMatch(/Revoked 2 of 2/);
  });
});
