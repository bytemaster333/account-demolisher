"use client";

// multisig coordination via Refractor.space. uploads the envelope, shows a shareable URL, polls status.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import { RefractorClient, type RefractorTxStatus } from "@/lib/multisig/refractor";
import { cn } from "@/lib/utils";
import type { RequiredSigners } from "@/lib/multisig/inspector";

export interface RefractorPanelProps {
  // base64 envelope to coordinate. uploaded on first render when no hash exists.
  readonly xdr: string;
  readonly networkPassphrase: string;
  // pre-existing refractor hash; supply when restoring a session so we skip the upload
  readonly initialHash?: string;
  // signers + threshold we're collecting against
  readonly required: RequiredSigners;
  // fired once refractor reports threshold met and a fully-signed envelope is ready
  readonly onComplete: (status: RefractorTxStatus) => void;
  readonly onCancel?: () => void;
  // test seam: inject a RefractorClient with a deterministic fetch
  readonly client?: RefractorClient;
  // poll interval override (default 2s)
  readonly pollIntervalMs?: number;
  readonly className?: string;
}

type Phase =
  | { kind: "uploading" }
  | { kind: "polling"; hash: string; url: string }
  | { kind: "complete"; hash: string; url: string; status: RefractorTxStatus }
  | { kind: "error"; message: string };

export function RefractorPanel(props: RefractorPanelProps): ReactElement {
  const {
    xdr,
    networkPassphrase,
    initialHash,
    required,
    onComplete,
    onCancel,
    client,
    pollIntervalMs,
    className,
  } = props;

  const refractorClient = useMemo(() => client ?? new RefractorClient(), [client]);
  const [phase, setPhase] = useState<Phase>(
    initialHash !== undefined
      ? { kind: "polling", hash: initialHash, url: deriveShareUrl(refractorClient, initialHash) }
      : { kind: "uploading" },
  );
  const [latest, setLatest] = useState<RefractorTxStatus | null>(null);
  const [copied, setCopied] = useState(false);

  // guards async setStates from firing post-unmount
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  // upload when no initialHash was provided
  useEffect(() => {
    if (phase.kind !== "uploading") return;
    let cancelled = false;
    void (async () => {
      try {
        const { hash, url } = await refractorClient.upload(xdr, networkPassphrase);
        if (cancelled || !mountedRef.current) return;
        setPhase({ kind: "polling", hash, url });
      } catch (err) {
        if (cancelled || !mountedRef.current) return;
        setPhase({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [phase.kind, xdr, networkPassphrase, refractorClient]);

  // real subscribeToCompletion against the live client
  useEffect(() => {
    if (phase.kind !== "polling") return;
    const controller = new AbortController();
    void (async () => {
      try {
        await refractorClient.subscribeToCompletion(
          phase.hash,
          (status) => {
            if (!mountedRef.current) return;
            setLatest(status);
            if (status.signaturesNeeded <= 0 || status.submitted === true) {
              setPhase({ kind: "complete", hash: phase.hash, url: phase.url, status });
              onComplete(status);
            }
          },
          {
            signal: controller.signal,
            ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
          },
        );
      } catch (err) {
        if (!mountedRef.current || controller.signal.aborted) return;
        setPhase({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => controller.abort();
  }, [phase, refractorClient, onComplete, pollIntervalMs]);

  // copy-to-clipboard with a transient "Copied!" affordance
  const handleCopy = useCallback(async () => {
    if (phase.kind !== "polling" && phase.kind !== "complete") return;
    try {
      await navigator.clipboard.writeText(phase.url);
      setCopied(true);
      setTimeout(() => {
        if (mountedRef.current) setCopied(false);
      }, 1500);
    } catch {
      // no clipboard permission — fall back silently (url is shown)
    }
  }, [phase]);

  return (
    <section
      className={cn(
        "rounded-lg border border-indigo-300 bg-indigo-50 p-4 text-indigo-950",
        className,
      )}
      data-testid="refractor-panel"
      data-phase={phase.kind}
      aria-live="polite"
    >
      <header className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide">
            Multisig coordination · Refractor
          </h2>
          <p className="mt-1 text-xs text-indigo-800">
            Share the link below with your co-signers. Refractor will submit the transaction
            automatically once the signature threshold is met.
          </p>
        </div>
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-indigo-400 px-2 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-100"
          >
            Cancel
          </button>
        ) : null}
      </header>

      {phase.kind === "polling" || phase.kind === "complete" ? (
        <div className="mt-4 rounded border border-indigo-200 bg-white p-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-mono uppercase tracking-wide text-indigo-700">
              Shareable URL
            </span>
            <button
              type="button"
              onClick={handleCopy}
              className="rounded bg-indigo-600 px-2 py-1 text-xs font-medium text-white hover:bg-indigo-700"
              data-testid="refractor-copy-button"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
          <code
            className="mt-2 block break-all rounded bg-slate-50 p-2 font-mono text-xs text-slate-800"
            data-testid="refractor-url"
          >
            {phase.url}
          </code>
        </div>
      ) : null}

      {phase.kind === "uploading" ? (
        <p className="mt-4 text-sm" data-testid="refractor-uploading">
          Uploading transaction to Refractor…
        </p>
      ) : null}

      {phase.kind === "error" ? (
        <p className="mt-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900">
          Refractor coordination failed: {phase.message}
        </p>
      ) : null}

      {phase.kind === "polling" || phase.kind === "complete" ? (
        <RefractorProgress
          required={required}
          status={phase.kind === "complete" ? phase.status : latest}
        />
      ) : null}

      {phase.kind === "complete" ? (
        <p
          className="mt-4 rounded border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900"
          data-testid="refractor-complete"
        >
          Threshold met — proceeding with submission
          {phase.status.submitResult?.hash
            ? ` (Stellar tx ${phase.status.submitResult.hash.slice(0, 12)}…).`
            : "."}
        </p>
      ) : null}
    </section>
  );
}

interface RefractorProgressProps {
  readonly required: RequiredSigners;
  readonly status: RefractorTxStatus | null;
}

function RefractorProgress({ required, status }: RefractorProgressProps): ReactElement {
  const remaining = status?.signaturesNeeded ?? required.threshold;
  const collected = Math.max(0, required.threshold - remaining);
  const pct = required.threshold > 0 ? Math.min(100, (collected / required.threshold) * 100) : 0;

  // status.signers carries still-required keys; everything else has signed
  const stillRequired = new Set(status?.signers ?? required.signers.map((s) => s.key));

  return (
    <div className="mt-4 space-y-3">
      <div>
        <div className="flex items-center justify-between text-xs font-medium text-indigo-900">
          <span>Signatures collected</span>
          <span data-testid="refractor-counts">
            {collected} / {required.threshold}
          </span>
        </div>
        <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-indigo-100">
          <div
            className="h-full rounded-full bg-indigo-600 transition-all"
            style={{ width: `${pct}%` }}
            data-testid="refractor-progress-bar"
            aria-valuenow={collected}
            aria-valuemin={0}
            aria-valuemax={required.threshold}
            role="progressbar"
          />
        </div>
      </div>

      <ul className="space-y-1 text-xs">
        {required.signers.map((signer) => {
          const signed = !stillRequired.has(signer.key);
          return (
            <li
              key={signer.key}
              className={cn(
                "flex items-center justify-between rounded border px-2 py-1.5",
                signed
                  ? "border-emerald-300 bg-emerald-50 text-emerald-900"
                  : "border-slate-200 bg-white text-slate-700",
              )}
              data-testid={`refractor-signer-${signer.key}`}
              data-signed={signed}
            >
              <span className="font-mono">
                {signer.key.slice(0, 6)}…{signer.key.slice(-6)}
              </span>
              <span className="flex items-center gap-2">
                <span className="font-mono text-[10px] text-slate-500">w={signer.weight}</span>
                <span className="font-mono">{signed ? "✓ signed" : "▸ pending"}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// derive the shareable URL when we only have an initialHash (no upload response)
function deriveShareUrl(client: RefractorClient, hash: string): string {
  // self-hosted deployments overriding frontendUrl should rely on the upload roundtrip url instead
  return `https://refractor.space/tx/${hash}`;
}
