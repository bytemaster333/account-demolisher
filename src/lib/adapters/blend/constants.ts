// blend constants pinned outside the SDK
import { Asset, Networks } from "@stellar/stellar-sdk";

import type { NetworkConfig } from "@/lib/config/networks";
import {
  BLEND_MAINNET_INFRASTRUCTURE,
  BLEND_TESTNET_INFRASTRUCTURE,
  type BlendInfrastructureEntry,
} from "./pools";

// Q4W_LOCK_TIME in each backstop's constants.rs: 17 days in blend-contracts-v2,
// 21 days in blend-contracts (v1)
export const BACKSTOP_QUEUE_DURATION_SECONDS: number = 17 * 24 * 60 * 60;
export const BACKSTOP_V1_QUEUE_DURATION_SECONDS: number = 21 * 24 * 60 * 60;

function infraId(
  infra: readonly BlendInfrastructureEntry[],
  name: string,
  networkLabel: string,
): string {
  const entry = infra.find((e) => e.name === name);
  if (!entry) {
    throw new Error(
      `blend/constants: BLEND_${networkLabel}_INFRASTRUCTURE missing '${name}' entry. ` +
        `Re-snapshot upstream ${networkLabel.toLowerCase()}.contracts.json before proceeding.`,
    );
  }
  return entry.id;
}

export const BLEND_BACKSTOP_MAINNET_ID: string = infraId(
  BLEND_MAINNET_INFRASTRUCTURE,
  "backstopV2",
  "MAINNET",
);
export const BLEND_BACKSTOP_V1_MAINNET_ID: string = infraId(
  BLEND_MAINNET_INFRASTRUCTURE,
  "backstop",
  "MAINNET",
);
export const BLEND_BACKSTOP_TESTNET_ID: string = infraId(
  BLEND_TESTNET_INFRASTRUCTURE,
  "backstopV2",
  "TESTNET",
);

// a backstop contract a pool can point at. each pool names its own backstop in
// its metadata (v1 pools use the v1 backstop), so this is resolved per pool,
// never as one id per network.
export interface BlendBackstopRef {
  readonly id: string;
  readonly version: "V1" | "V2";
  readonly queueDurationSeconds: number;
}

const MAINNET_BACKSTOPS: readonly BlendBackstopRef[] = Object.freeze([
  Object.freeze({
    id: BLEND_BACKSTOP_V1_MAINNET_ID,
    version: "V1" as const,
    queueDurationSeconds: BACKSTOP_V1_QUEUE_DURATION_SECONDS,
  }),
  Object.freeze({
    id: BLEND_BACKSTOP_MAINNET_ID,
    version: "V2" as const,
    queueDurationSeconds: BACKSTOP_QUEUE_DURATION_SECONDS,
  }),
]);

const TESTNET_BACKSTOPS: readonly BlendBackstopRef[] = Object.freeze([
  Object.freeze({
    id: BLEND_BACKSTOP_TESTNET_ID,
    version: "V2" as const,
    queueDurationSeconds: BACKSTOP_QUEUE_DURATION_SECONDS,
  }),
]);

export function blendBackstopsForNetwork(network: NetworkConfig): readonly BlendBackstopRef[] {
  switch (network.id) {
    case "mainnet":
      return MAINNET_BACKSTOPS;
    case "testnet":
      return TESTNET_BACKSTOPS;
    default:
      throw new Error(`Blend has no supported deployment on network "${network.id}"`);
  }
}

// a pool's metadata decides which backstop holds its deposits; only a pinned,
// allow-listed backstop is ever read from or called
export function resolveKnownBackstop(network: NetworkConfig, backstopId: string): BlendBackstopRef {
  const ref = blendBackstopsForNetwork(network).find((b) => b.id === backstopId);
  if (!ref) {
    throw new Error(
      `${backstopId} is not a known Blend backstop on ${network.id}; refusing to treat its ` +
        `deposits as checked`,
    );
  }
  return ref;
}

// BLND is a stellar asset contract over a classic asset, so paying it to a G
// account needs a trustline. issuers read from each SAC's name() on 2026-10-02
// and checked below against the pinned contract ids.
export interface BlndToken {
  readonly contractId: string;
  readonly code: "BLND";
  readonly issuer: string;
}

function blndToken(
  infra: readonly BlendInfrastructureEntry[],
  issuer: string,
  passphrase: string,
  networkLabel: string,
): BlndToken {
  const contractId = infraId(infra, "BLND", networkLabel);
  const derived = new Asset("BLND", issuer).contractId(passphrase);
  if (derived !== contractId) {
    throw new Error(
      `blend/constants: BLND:${issuer} derives to ${derived}, not the pinned ${contractId}`,
    );
  }
  return Object.freeze({ contractId, code: "BLND", issuer });
}

const BLND_MAINNET: BlndToken = blndToken(
  BLEND_MAINNET_INFRASTRUCTURE,
  "GDJEHTBE6ZHUXSWFI642DCGLUOECLHPF3KSXHPXTSTJ7E3JF6MQ5EZYY",
  Networks.PUBLIC,
  "MAINNET",
);
const BLND_TESTNET: BlndToken = blndToken(
  BLEND_TESTNET_INFRASTRUCTURE,
  "GATALTGTWIOT6BUDBCZM3Q4OQ4BO2COLOAZ7IYSKPLC2PMSOPPGF5V56",
  Networks.TESTNET,
  "TESTNET",
);

export function blndTokenForNetwork(network: NetworkConfig): BlndToken {
  switch (network.id) {
    case "mainnet":
      return BLND_MAINNET;
    case "testnet":
      return BLND_TESTNET;
    default:
      throw new Error(`Blend has no supported deployment on network "${network.id}"`);
  }
}

// i128 max. the v2 pool caps a withdraw at the position, so it drains it
// exactly; never sent to a v1 pool (its fixed-point math overflows and traps) or
// as a repay (the pool transfers the full request amount first)
export const I128_MAX: bigint = (1n << 127n) - 1n;

// five-minute soroban tx timeout
export const MAX_TIMEOUT_SECONDS: number = 300;
