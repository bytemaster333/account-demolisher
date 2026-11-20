// the testnet blend pool is shared, and its xlm reserve can sit above the pool's
// own utilization cap (95%), so any new xlm borrow there answers
// Error(Contract, #1207) InvalidUtilRate whatever this code does. a borrow test
// checks first and skips with the measured numbers instead of failing on a pool
// state no test can change.

import { PoolV2 } from "@blend-capital/blend-sdk";
import { Asset } from "@stellar/stellar-sdk";

import { TESTNET } from "../../src/lib/config/networks";

// null when the pool can take `borrow` more xlm after `supply` more is added,
// else why it cannot. amounts in stroops.
export async function xlmBorrowBlocked(
  poolId: string,
  supply: bigint,
  borrow: bigint,
): Promise<string | null> {
  const pool = await PoolV2.load({ rpc: TESTNET.rpc, passphrase: TESTNET.passphrase }, poolId);
  const xlm = Asset.native().contractId(TESTNET.passphrase);
  const reserve = pool.reserves.get(xlm);
  if (reserve === undefined) return `pool ${poolId} has no xlm reserve`;
  const supplied = reserve.totalSupplyFloat() + Number(supply) / 1e7;
  const borrowed = reserve.totalLiabilitiesFloat() + Number(borrow) / 1e7;
  const max = reserve.config.max_util / 1e7;
  const util = borrowed / supplied;
  if (util < max) return null;
  return (
    `testnet blend pool ${poolId} xlm reserve would be at ${(util * 100).toFixed(2)}% ` +
    `utilization after this test's own deposit and borrow, over its ${(max * 100).toFixed(0)}% cap, ` +
    `so the borrow is refused (InvalidUtilRate)`
  );
}
