// thin wrapper around @stellar-expert/tx-signers-inspector that returns a
// narrow view of the required signer set for the orchestrator.
//
// the demolisher's terminal tx is an accountMerge (high threshold), so the
// effective threshold typically equals the account's high_threshold.

import { inspectTransactionSigners } from "@stellar-expert/tx-signers-inspector";
import type {
  AccountSignatureRequirements,
  SignatureRequirements,
} from "@stellar-expert/tx-signers-inspector";
import type { FeeBumpTransaction, Horizon, Transaction } from "@stellar/stellar-sdk";

// stellar G-address (or pre-auth-tx / hash-x key) + weight.
export interface SignerSummary {
  readonly key: string;
  readonly weight: number;
}

// threshold is the minimum cumulative weight for this tx (not the account's
// high_threshold value alone).
export interface RequiredSigners {
  readonly signers: readonly SignerSummary[];
  readonly threshold: number;
}

// throws when no per-account requirements match accountId (almost always a
// caller bug — the tx has no op sourced from accountId).
export async function getRequiredSigners(
  server: Horizon.Server,
  accountId: string,
  tx: Transaction | FeeBumpTransaction,
): Promise<RequiredSigners> {
  // inspector accepts a horizon url, not a Horizon.Server instance.
  const horizonUrl = readServerUrl(server);
  const schema = await inspectTransactionSigners(tx, { horizon: horizonUrl });

  const requirements = schema.requirements.find(
    (req): req is AccountSignatureRequirements => isAccountRequirement(req) && req.id === accountId,
  );

  if (!requirements) {
    throw new Error(
      `getRequiredSigners: no signature requirements found for account ${accountId}. ` +
        `The transaction may not be sourced from (or affect) that account.`,
    );
  }

  // copy to plain immutable shape; inspector pre-filters weight-0 and sorts.
  const signers: readonly SignerSummary[] = requirements.signers.map(({ key, weight }) => ({
    key,
    weight,
  }));

  return {
    signers,
    threshold: requirements.minThreshold,
  };
}

function isAccountRequirement(req: SignatureRequirements): req is AccountSignatureRequirements {
  return req.type === "account_signature";
}

// pull the horizon base URL off Horizon.Server. defensive — degrades with a
// clear error if the SDK changes shape upstream.
function readServerUrl(server: Horizon.Server): string {
  const candidate: unknown = (server as unknown as { serverURL?: { toString?: () => string } })
    .serverURL;
  if (candidate && typeof (candidate as { toString?: unknown }).toString === "function") {
    const url = (candidate as { toString: () => string }).toString();
    if (typeof url === "string" && url.length > 0) return url;
  }
  throw new Error(
    "getRequiredSigners: unable to read Horizon URL from the supplied server. " +
      "The stellar-sdk's `Horizon.Server` no longer exposes `serverURL`; " +
      "update this adapter to match the new shape.",
  );
}
