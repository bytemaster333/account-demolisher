// discovery: the account audit plus the best-effort scans (allowances, defi
// positions, held tokens) the plan is generated from

import { fromPromise } from "xstate";

import type { NetworkConfig } from "@/lib/config/networks";
import { errorMessage } from "@/lib/errors";
import { auditAccount } from "@/lib/stellar/account-audit";
import { getRpc } from "@/lib/soroban/rpc-client";
import type { AccountAudit } from "@/lib/types/account";
import { EMPTY_POSITIONS, type ProtocolPositions } from "@/lib/adapters/positions/interface";
import { DirectContractProvider } from "@/lib/adapters/positions/direct";
import { blendRepayShortfallWarnings } from "@/lib/adapters/blend/repay-check";
import { manualCloseRequiredNotice } from "@/lib/safety/manual-close";
import {
  confirmAllowancesOnChain,
  DEFAULT_SCAN_WINDOW_LEDGERS,
  scanAllowances,
  withoutConfirmedZero,
  type AllowanceRecord,
} from "@/lib/soroban/allowances";
import { describeIncompleteScan } from "@/lib/soroban/event-scan";
import {
  discoverHeldTokens,
  heldTokenScanWarning,
  type HeldToken,
} from "@/lib/soroban/held-tokens";
import { ALL_PROTOCOLS, discoveryWarningFor } from "@/lib/orchestrator/warnings";

export interface DiscoverInput {
  readonly publicKey: string;
  readonly network: NetworkConfig;
  readonly positions?: ProtocolPositions;
  readonly allowances?: readonly AllowanceRecord[];
}

export interface DiscoverOutput {
  readonly audit: AccountAudit;
  readonly positions: ProtocolPositions;
  readonly allowances: readonly AllowanceRecord[];
  readonly heldTokens: readonly HeldToken[];
  readonly unreadableHeldTokens: readonly string[];
  readonly heldTokenScanFailed: boolean;
  // non-fatal discovery failures (allowance scan / position probe) surfaced so
  // the UI can warn that the plan may be incomplete instead of hiding them.
  readonly discoveryWarnings: readonly string[];
  readonly discoveryDiagnostics: readonly string[];
}

// per-discovery-step ceiling so a hanging rpc can't pin the ui on a spinner
export const DISCOVERY_TIMEOUT_MS = 30_000;

export function withTimeout<T>(label: string, p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export const discoverActor = fromPromise<DiscoverOutput, DiscoverInput>(async ({ input }) => {
  const discoveryWarnings: string[] = [];
  const discoveryDiagnostics: string[] = [];

  // the audit is required, so a timeout rejects the actor (machine -> failed with
  // a real error) instead of hanging the UI. it runs alongside the best-effort
  // scans below and is awaited on its own so its failure still rejects.
  const auditPromise = withTimeout(
    "auditAccount",
    auditAccount(input.publicKey, input.network),
    DISCOVERY_TIMEOUT_MS,
  );

  // allowances, defi positions and held tokens are independent scans run
  // concurrently; each turns its own failure into a warning

  // allowances: best-effort sep-41 enumeration, timeout-bounded because
  // rpc.getEvents pagination can stall on a flaky endpoint
  const allowancesPromise: Promise<{
    allowances: readonly AllowanceRecord[];
    warning?: string;
    detail?: string;
  }> =
    input.allowances && input.allowances.length > 0
      ? Promise.resolve({ allowances: input.allowances })
      : (async () => {
          try {
            const rpc = getRpc(input.network);
            const latest = await withTimeout(
              "getLatestLedger",
              rpc.getLatestLedger(),
              DISCOVERY_TIMEOUT_MS,
            );
            const scan = await withTimeout(
              "scanAllowances",
              scanAllowances(rpc, input.publicKey, latest.sequence, DEFAULT_SCAN_WINDOW_LEDGERS),
              DISCOVERY_TIMEOUT_MS,
            );
            // an allowance already spent through transfer_from (or revoked) reads
            // zero on chain and needs no revoke; a row whose read failed stays in
            let allowances: readonly AllowanceRecord[] = scan.records;
            let confirmDetail: string | undefined;
            try {
              const confirmed = await withTimeout(
                "confirmAllowancesOnChain",
                confirmAllowancesOnChain(
                  rpc,
                  input.publicKey,
                  scan.records,
                  input.network,
                  input.publicKey,
                ),
                DISCOVERY_TIMEOUT_MS,
              );
              allowances = withoutConfirmedZero(confirmed);
            } catch (e) {
              confirmDetail = `allowance confirm: ${errorMessage(e)}`;
            }
            // a partial scan keeps what it found and says how much it checked
            return {
              allowances,
              ...(scan.incomplete !== null
                ? {
                    warning: `${describeIncompleteScan(scan.incomplete, "token spending permissions")} An older permission may be missing from this plan; review them on the Allowances page before closing.`,
                    detail: `allowance scan: ${scan.incomplete.detail}${confirmDetail ? `; ${confirmDetail}` : ""}`,
                  }
                : confirmDetail !== undefined
                  ? { detail: confirmDetail }
                  : {}),
            };
          } catch (e) {
            return {
              allowances: [] as readonly AllowanceRecord[],
              warning:
                "We couldn't finish checking this account's token spending permissions, so any active ones might not show up in this plan. You can review them separately on the Allowances page before closing.",
              detail: `allowance scan: ${errorMessage(e)}`,
            };
          }
        })();

  // defi positions: direct-contract probing across blend/aquarius/soroswap.
  // a timeout keeps no partial result, so it is recorded as an unfinished
  // discovery in positions.errors, which the merge guard also refuses on
  const positionsPromise: Promise<{ positions: ProtocolPositions; detail?: string }> =
    input.positions && input.positions !== EMPTY_POSITIONS
      ? Promise.resolve({ positions: input.positions })
      : (async () => {
          try {
            const provider = new DirectContractProvider();
            const positions = await withTimeout(
              "getPositions",
              provider.getPositions(input.publicKey, input.network),
              DISCOVERY_TIMEOUT_MS,
            );
            return { positions };
          } catch (e) {
            return {
              positions: {
                ...EMPTY_POSITIONS,
                errors: [{ protocol: ALL_PROTOCOLS, message: errorMessage(e) }],
              },
              detail: `position discovery: ${errorMessage(e)}`,
            };
          }
        })();

  // standalone SEP-41 tokens held directly. no native "list my tokens" exists,
  // so this event-scans transfers crediting the account and probes balance().
  // the rpc's ~7-day retention means older receipts are missed, so a miss is a
  // soft warning, never treated as exhaustive.
  const heldPromise: Promise<{
    held: readonly HeldToken[];
    unreadable: readonly string[];
    failed: boolean;
    warning?: string;
    detail?: string;
  }> = (async () => {
    try {
      const rpc = getRpc(input.network);
      const latest = await withTimeout(
        "getLatestLedger",
        rpc.getLatestLedger(),
        DISCOVERY_TIMEOUT_MS,
      );
      const scan = await withTimeout(
        "discoverHeldTokens",
        discoverHeldTokens(rpc, input.publicKey, latest.sequence, input.network),
        DISCOVERY_TIMEOUT_MS,
      );
      return {
        held: scan.held,
        unreadable: scan.unreadable,
        failed: false,
        // a scan that covered only part of the window says so; what it found stays
        ...(scan.incomplete !== null
          ? {
              warning: heldTokenScanWarning(scan.incomplete),
              detail: `held-token scan: ${scan.incomplete.detail}`,
            }
          : {}),
      };
    } catch (e) {
      // an optional, opt-in scan with a manual-add fallback: a blip must not read
      // like imminent fund loss
      return {
        held: [] as readonly HeldToken[],
        unreadable: [] as readonly string[],
        failed: true,
        warning:
          "We couldn't finish the optional scan for standalone (custom SEP-41) tokens. This doesn't affect any balance you can already see. If you know you hold a custom token, you can add it by its contract address to include it in the close.",
        detail: `held-token scan: ${errorMessage(e)}`,
      };
    }
  })();

  const audit = await auditPromise;
  const [allowanceResult, positionResult, heldResult] = await Promise.all([
    allowancesPromise,
    positionsPromise,
    heldPromise,
  ]);
  const positions = positionResult.positions;

  // warnings in a stable order (scan warnings, per-protocol errors, blend repay
  // shortfall) so copy doesn't reshuffle between runs
  if (allowanceResult.warning) discoveryWarnings.push(allowanceResult.warning);
  if (heldResult.warning) discoveryWarnings.push(heldResult.warning);
  for (const r of [allowanceResult, positionResult, heldResult]) {
    if (r.detail) discoveryDiagnostics.push(r.detail);
  }
  for (const e of positions.errors) {
    discoveryWarnings.push(discoveryWarningFor(e));
    if (e.protocol !== ALL_PROTOCOLS) discoveryDiagnostics.push(`${e.protocol}: ${e.message}`);
  }

  // blend repay needs the borrowed token on hand (no auto-swap); a shortfall
  // would stop the close mid-way, so say it now
  discoveryWarnings.push(...blendRepayShortfallWarnings(audit, positions.blend, input.network));

  // held tokens from unrecognized contracts are the visible trace of a position
  // in an unsupported app we can't unwind; ask the user to close those first
  const manualClose = manualCloseRequiredNotice({
    heldTokenCount: heldResult.held.length,
    unreadableTokenCount: heldResult.unreadable.length,
  });
  if (manualClose) discoveryWarnings.push(manualClose);

  return {
    audit,
    positions,
    allowances: allowanceResult.allowances,
    heldTokens: heldResult.held,
    unreadableHeldTokens: heldResult.unreadable,
    heldTokenScanFailed: heldResult.failed,
    discoveryWarnings,
    discoveryDiagnostics,
  };
});
