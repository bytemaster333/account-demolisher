import { Asset, Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { blndTokenForNetwork } from "@/lib/adapters/blend/constants";
import { MAINNET } from "@/lib/config/networks";
import { SOROBAN_INCLUSION_FEE } from "@/lib/soroban/simulate";
import { DEFAULT_TX_VALIDITY_SECONDS } from "@/lib/stellar/ledger-clock";
import { buildTrustlineTx } from "@/lib/stellar/trustline-tx";

import { horizonAccount } from "./blend-fixtures";

const BLND = blndTokenForNetwork(MAINNET);
// a fixed close time far from the test machine's clock: the bound must come
// from the ledger read, never from Date.now()
const LEDGER_CLOSE = 1_700_000_000;

describe("buildTrustlineTx", () => {
  const user = Keypair.random().publicKey();
  const account = () =>
    horizonAccount({ accountId: user, sequence: "4000", balances: [{ balance: "50.0000000" }] });

  it("opens one trustline to the asset it is given at the maximum limit", () => {
    const tx = buildTrustlineTx(
      MAINNET,
      account(),
      new Asset(BLND.code, BLND.issuer),
      LEDGER_CLOSE,
    );
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

  it("expires the signing window after the supplied ledger close time", () => {
    const tx = buildTrustlineTx(
      MAINNET,
      account(),
      new Asset(BLND.code, BLND.issuer),
      LEDGER_CLOSE,
    );
    expect(Number(tx.timeBounds?.minTime)).toBe(0);
    expect(Number(tx.timeBounds?.maxTime)).toBe(LEDGER_CLOSE + DEFAULT_TX_VALIDITY_SECONDS);
  });

  it("refuses to build without a usable ledger close time", () => {
    const asset = new Asset(BLND.code, BLND.issuer);
    for (const bad of [0, -1, Number.NaN, 1.5]) {
      expect(() => buildTrustlineTx(MAINNET, account(), asset, bad)).toThrow(/ledger close time/);
    }
  });

  it("uses the next sequence without advancing the caller's account", () => {
    const source = account();
    const asset = new Asset(BLND.code, BLND.issuer);
    expect(buildTrustlineTx(MAINNET, source, asset, LEDGER_CLOSE).sequence).toBe("4001");
    expect(buildTrustlineTx(MAINNET, source, asset, LEDGER_CLOSE).sequence).toBe("4001");
    expect(source.sequenceNumber()).toBe("4000");
  });
});
