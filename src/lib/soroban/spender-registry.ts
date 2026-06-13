// curated registry of well-known soroban spender contract ids, used to render

import { MAINNET_ALLOWLIST } from "@/lib/config/contracts";

export interface SpenderInfo {
  readonly name: string;
  readonly protocol: string;
}

// built once at module load from the project's allow-list to avoid drift
const REGISTRY: ReadonlyMap<string, SpenderInfo> = new Map(
  MAINNET_ALLOWLIST.map((c) => [c.id, { name: c.name, protocol: c.protocol }]),
);

// returns the registry entry or null if not curated
export function lookupSpender(contractId: string): SpenderInfo | null {
  return REGISTRY.get(contractId) ?? null;
}
