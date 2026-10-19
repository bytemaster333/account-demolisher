// the sep-41 share tokens of the pool positions discovery found. an aquarius or
// soroswap lp share is also a token the account holds, so the held-token scan
// lists it too; the plan already exits those positions, and listing their shares
// as unrecognized tokens would ask the user to close them by hand.

import type { rpc } from "@stellar/stellar-sdk";

import type { NetworkConfig } from "@/lib/config/networks";
import type { ProtocolPositions } from "@/lib/adapters/positions/interface";
import { getAquariusRouterId } from "@/lib/adapters/aquarius/client";
import { readShareIdFromRouter } from "@/lib/adapters/aquarius/pools";
import { getSoroswapFactoryId } from "@/lib/adapters/soroswap/discovery";
import { mapConcurrent } from "@/lib/soroban/concurrency";
import { address as scvAddress, fromScValAddress } from "@/lib/soroban/scval";
import { simulateRead } from "@/lib/soroban/simulate";

const READ_CONCURRENCY = 4;

// read from the router and the factory themselves, never from the token: a
// hostile token could claim to be any pool's share and drop out of the list.
// throws when a read fails, so the caller keeps every held token instead.
export async function positionShareTokens(
  server: rpc.Server,
  network: NetworkConfig,
  userAddress: string,
  positions: ProtocolPositions,
): Promise<Set<string>> {
  const reads: (() => Promise<string>)[] = [];
  if (positions.aquarius.length > 0) {
    const routerId = getAquariusRouterId(network);
    for (const p of positions.aquarius) {
      reads.push(() =>
        readShareIdFromRouter(server, network, routerId, p.tokens, p.poolIndex, userAddress),
      );
    }
  }
  if (positions.soroswap.length > 0) {
    const factoryId = getSoroswapFactoryId(network);
    for (const p of positions.soroswap) {
      reads.push(async () => {
        const { retval } = await simulateRead(
          server,
          factoryId,
          "get_pair",
          [scvAddress(p.pair.tokenA), scvAddress(p.pair.tokenB)],
          userAddress,
          network,
        );
        return fromScValAddress(retval);
      });
    }
  }
  const ids = await mapConcurrent(reads, READ_CONCURRENCY, (read) => read());
  return new Set(ids);
}
