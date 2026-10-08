import { describe, it, expect } from "vitest";
import { Horizon, NotFoundError, scValToNative, xdr, type Transaction } from "@stellar/stellar-sdk";

import { loadPoolAndUser } from "@/lib/adapters/blend/client";
import { buildBlendWithdrawTx } from "@/lib/adapters/blend/exit";
import { BLEND_MAINNET_POOLS } from "@/lib/adapters/blend/pools";
import { MAINNET } from "@/lib/config/networks";
import { assertSorobanFeeWithinCap } from "@/lib/soroban/fee-cap";

// read-only: a YieldBloxV2 collateral withdraw for a user whose Positions entry
// is archived, built by the app's own builder and simulated against mainnet.
// nothing is signed or submitted.
//
// the wave 2 fee sweep saw every such withdraw trap with Error(WasmVm,
// InvalidAction). the builder then sent i128::MAX, which overflows the bToken
// conversion in reserves whose b_rate is below 1e12 (0.98 and 0.48 on
// 2026-10-07). sized from b_rate, the same withdraws simulate at about
// 1,060,000 stroops, 1,232 to 1,336 write bytes, 5 read-write entries and 2
// archived entries restored, well inside the defi-exit class.
//
// the users are picked at run time: a pinned user can restore the entry or
// withdraw, and the test would then fail on someone else's state. the rpc cannot
// list a contract's storage, so candidates come from stellar.expert's
// contract-data index (archived Positions entries with collateral and no debt;
// 278 of them on 2026-10-08). whether an entry is still archived and the
// collateral still there is read from the chain itself, by the pool load and
// the simulated build.
const EXPERT = "https://api.stellar.expert";
const WANTED = 2;
const MAX_CANDIDATES = 12;

interface ContractDataPage {
  readonly _links: { readonly next?: { readonly href: string } };
  readonly _embedded: {
    readonly records: readonly {
      readonly key: string;
      readonly value: string;
      readonly expired?: boolean;
    }[];
  };
}

async function archivedCandidates(poolId: string): Promise<string[]> {
  const found: string[] = [];
  let next: string | undefined = `/explorer/public/contract-data/${poolId}?limit=200`;
  while (next !== undefined && found.length < MAX_CANDIDATES) {
    const res = await fetch(`${EXPERT}${next}`);
    if (!res.ok) throw new Error(`stellar.expert contract-data listing failed: ${res.status}`);
    const page = (await res.json()) as ContractDataPage;
    const records = page._embedded.records;
    for (const rec of records) {
      if (rec.expired !== true) continue;
      const key = scValToNative(xdr.ScVal.fromXdr(rec.key, "base64")) as unknown;
      if (!Array.isArray(key) || key[0] !== "Positions" || typeof key[1] !== "string") continue;
      // a contract holder has no classic account to source the transaction from
      if (!key[1].startsWith("G")) continue;
      const positions = scValToNative(xdr.ScVal.fromXdr(rec.value, "base64")) as {
        collateral?: Record<string, bigint>;
        liabilities?: Record<string, bigint>;
      };
      const held = Object.values(positions.collateral ?? {}).some((v) => v > 0n);
      const owes = Object.values(positions.liabilities ?? {}).some((v) => v > 0n);
      if (held && !owes) found.push(key[1]);
      if (found.length >= MAX_CANDIDATES) break;
    }
    // the next link carries the default page size, not the one asked for
    next =
      records.length < 200 ? undefined : page._links.next?.href.replace(/limit=\d+/, "limit=200");
  }
  return found;
}

function archivedEntries(tx: Transaction): number {
  const env = tx.toEnvelope();
  if (env.type !== "envelopeTypeTx" || env.v1.tx.ext.type !== "sorobanData") return -1;
  const ext = env.v1.tx.ext.sorobanData.ext;
  return ext.type === "resourceExt" ? ext.resourceExt.archivedSorobanEntries.length : 0;
}

describe("integration: YieldBloxV2 archived withdraw (mainnet, read-only)", () => {
  it("builds, restores and fits the defi-exit fee class for archived holders", async () => {
    const entry = BLEND_MAINNET_POOLS.find((p) => p.name === "YieldBloxV2");
    if (entry === undefined) throw new Error("YieldBloxV2 is not in the mainnet registry");
    const horizon = new Horizon.Server(MAINNET.horizon);
    const candidates = await archivedCandidates(entry.pool_id);
    const checked: string[] = [];
    const passedOver: string[] = [];

    for (const user of candidates) {
      if (checked.length >= WANTED) break;
      const { pool, user: poolUser } = await loadPoolAndUser(MAINNET, entry.pool_id, user);
      const held = [...poolUser.positions.collateral.entries()].find(([, v]) => v > 0n);
      const owes = [...poolUser.positions.liabilities.values()].some((v) => v > 0n);
      if (held === undefined || owes) {
        passedOver.push(`${user}: positions changed since the index read them`);
        continue;
      }
      const reserve = [...pool.reserves.values()].find((r) => r.config.index === held[0]);
      if (reserve === undefined) throw new Error(`no reserve at index ${held[0]}`);

      let account: Horizon.AccountResponse;
      try {
        account = await horizon.loadAccount(user);
      } catch (err) {
        if (!(err instanceof NotFoundError)) throw err;
        passedOver.push(`${user}: the account no longer exists`);
        continue;
      }
      // a build failure fails the test; only a changed precondition moves on
      const built = await buildBlendWithdrawTx(
        MAINNET,
        { poolId: entry.pool_id, asset: reserve.assetId, bucket: "collateral" },
        user,
        account,
      );
      const tx = built.transaction as Transaction;
      if (archivedEntries(tx) === 0) {
        passedOver.push(`${user}: the Positions entry is live again`);
        continue;
      }
      expect(archivedEntries(tx)).toBeGreaterThan(0);
      // throws SorobanFeeCapError if the exit would not be signable
      const fee = assertSorobanFeeWithinCap(tx, "defi-exit");
      expect(fee.resourceFee).toBeGreaterThan(0n);
      checked.push(user);
    }

    if (checked.length < WANTED) {
      throw new Error(
        `precondition: ${checked.length} of ${candidates.length} indexed candidates still hold ` +
          `archived YieldBloxV2 collateral, ${WANTED} needed (${passedOver.join("; ")})`,
      );
    }
  });
});
