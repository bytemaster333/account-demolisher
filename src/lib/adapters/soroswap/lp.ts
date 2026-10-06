// soroswap LP exit: direct remove_liquidity invocation against the network's SoroswapRouter
import {
  Contract,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
  type Transaction,
  type TransactionSource,
} from "@stellar/stellar-sdk";
import { isAllowedRootTarget } from "@/lib/config/contracts";
import {
  getSoroswapRouterId,
  validateDeadline,
  validateIntegerAmount,
} from "@/lib/adapters/soroswap/router";
import { assertTransactionAllowed } from "@/lib/stellar/allowlist";
import type { NetworkConfig } from "@/lib/config/networks";
import { address as scvAddress, i128 as scvI128 } from "@/lib/soroban/scval";
import { assembleSubmittable, SOROBAN_INCLUSION_FEE } from "@/lib/soroban/simulate";

const FIVE_MINUTES_SECONDS = 300;
const CALLER = "removeLiquidity";

// inject point for tests; defaults to the memoized RPC + assembleSubmittable
export interface RemoveLiquidityDeps {
  readonly server: rpc.Server;
  readonly sourceAccount: TransactionSource;
  readonly assemble?: typeof assembleSubmittable;
}

// both pair tokens as soroban contract ids, as discovery reads them from the pair
export interface RemoveLiquidityByContractIdsArgs {
  readonly tokenAAddress: string;
  readonly tokenBAddress: string;
  // LP-share balance to burn, in smallest units
  readonly liquidity: string;
  readonly amountAMin: string;
  readonly amountBMin: string;
  readonly userAddress: string;
  // unix seconds. soroswap compares against env.ledger().timestamp()
  readonly deadline: number;
  readonly network: NetworkConfig;
}

export async function removeLiquidityByContractIds(
  args: RemoveLiquidityByContractIdsArgs,
  deps: RemoveLiquidityDeps,
): Promise<Transaction> {
  const routerId = getSoroswapRouterId(args.network);
  // defensive re-check; pinned ID is in the allow-list by construction
  if (!isAllowedRootTarget(routerId, args.network)) {
    throw new Error(
      `SoroswapRouter ${routerId} is not on the ${args.network.id} allow-list, refusing to build remove_liquidity`,
    );
  }

  validateIntegerAmount(CALLER, "liquidity", args.liquidity);
  validateIntegerAmount(CALLER, "amountAMin", args.amountAMin);
  validateIntegerAmount(CALLER, "amountBMin", args.amountBMin);
  validateDeadline(CALLER, args.deadline);

  const callArgs: xdr.ScVal[] = [
    scvAddress(args.tokenAAddress),
    scvAddress(args.tokenBAddress),
    scvI128(BigInt(args.liquidity)),
    scvI128(BigInt(args.amountAMin)),
    scvI128(BigInt(args.amountBMin)),
    scvAddress(args.userAddress),
    nativeToScVal(BigInt(args.deadline), { type: "u64" }),
  ];

  const contract = new Contract(routerId);
  const tx = new TransactionBuilder(deps.sourceAccount, {
    fee: SOROBAN_INCLUSION_FEE,
    networkPassphrase: args.network.passphrase,
  })
    .addOperation(contract.call("remove_liquidity", ...callArgs))
    .setTimeout(FIVE_MINUTES_SECONDS)
    .build();

  const assemble = deps.assemble ?? assembleSubmittable;
  const prepared = await assemble(deps.server, tx);
  if ("innerTransaction" in prepared) {
    throw new Error(`${CALLER}: prepareTransaction returned a FeeBumpTransaction unexpectedly`);
  }
  // parity with the other adapters: verify the assembled tx only invokes
  // allow-listed contracts before it can ever be signed.
  assertTransactionAllowed(prepared, args.network);
  return prepared;
}
