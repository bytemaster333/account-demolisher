/**
 * selectProvider — picks the first available position provider from a priority-ordered list.
 * canonical order is orion → octopos → direct, but providers come in positionally so tests can rearrange.
 * throws NoProviderAvailable when the chain is exhausted; the error message lists every attempt.
 */

import type { IDeFiPositionProvider, DeFiPositionProviderName } from "./interface";

export class NoProviderAvailable extends Error {
  // each entry records one probe attempt
  readonly attempts: ReadonlyArray<{ provider: DeFiPositionProviderName; reason: string }>;
  constructor(attempts: ReadonlyArray<{ provider: DeFiPositionProviderName; reason: string }>) {
    const chain =
      attempts.length === 0
        ? "<no providers given>"
        : attempts.map((a) => `${a.provider}: ${a.reason}`).join("; ");
    super(`No DeFi position provider is available (tried: ${chain}).`);
    this.name = "NoProviderAvailable";
    this.attempts = attempts;
  }
}

// try each provider's isAvailable in order; return the first that resolves true
export async function selectProvider(
  providers: readonly IDeFiPositionProvider[],
): Promise<IDeFiPositionProvider> {
  if (providers.length === 0) {
    throw new NoProviderAvailable([]);
  }

  const attempts: Array<{ provider: DeFiPositionProviderName; reason: string }> = [];
  for (const provider of providers) {
    let available: boolean;
    try {
      available = await provider.isAvailable();
    } catch (err) {
      attempts.push({
        provider: provider.name,
        reason: `isAvailable() threw: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    if (available) {
      return provider;
    }
    attempts.push({ provider: provider.name, reason: "not available" });
  }
  throw new NoProviderAvailable(attempts);
}
