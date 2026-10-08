import { Asset, Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { blndTokenForNetwork } from "@/lib/adapters/blend/constants";
import { MAINNET } from "@/lib/config/networks";
import { SOROBAN_INCLUSION_FEE } from "@/lib/soroban/simulate";
import { DEFAULT_TX_VALIDITY_SECONDS } from "@/lib/stellar/ledger-clock";
import { buildTrustlineTx } from "@/lib/stellar/trustline-tx";

import { horizonAccount } from "./blend-fixtures";

const BLND = blndTokenForNetwork(MAINNET);

describe("buildTrustlineTx", () => {
  const user = Keypair.random().publicKey();
  const account = () =>
    horizonAccount({ accountId: user, sequence: "4000", balances: [{ balance: "50.0000000" }] });

  it("opens one trustline to the asset it is given at the maximum limit", () => {
    const tx = buildTrustlineTx(MAINNET, account(), new Asset(BLND.code, BLND.issuer));
    expect(tx.operations).toHaveLength(1);
    const op = tx.operations[0]!;
    if (op.type !== "changeTrust") throw new Error(`expected changeTrust, got ${op.type}`);
    const line = op.line as Asset;
    expect(line.getCode()).toBe("BLND");
    expect(line.getIssuer()).toBe(BLND.issuer);
    expect(op.limit).toBe("922337203685.4775807");
    expect(tx.source).toBe(user);
    expect(tx.networkPassphrase).toBe(MAINNET.passphrase);
    expect(tx.fee).toBe(SOROBAN_INCLUSION_FEE);
  });

  it("expires inside the classic batches' signing window", () => {
    const before = Math.floor(Date.now() / 1000);
    const tx = buildTrustlineTx(MAINNET, account(), new Asset(BLND.code, BLND.issuer));
    const maxTime = Number(tx.timeBounds?.maxTime);
    expect(maxTime).toBeGreaterThanOrEqual(before + DEFAULT_TX_VALIDITY_SECONDS);
    expect(maxTime).toBeLessThanOrEqual(
      Math.floor(Date.now() / 1000) + DEFAULT_TX_VALIDITY_SECONDS,
    );
  });

  it("uses the next sequence without advancing the caller's account", () => {
    const source = account();
    const asset = new Asset(BLND.code, BLND.issuer);
    expect(buildTrustlineTx(MAINNET, source, asset).sequence).toBe("4001");
    expect(buildTrustlineTx(MAINNET, source, asset).sequence).toBe("4001");
    expect(source.sequenceNumber()).toBe("4000");
  });
});
