"use client";

// drop / paste UI for legacy multi-secret-key multisig. merges co-signer envelopes into the canonical xdr.

import { TransactionBuilder } from "@stellar/stellar-sdk";
import {
  useCallback,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type ReactElement,
} from "react";

import { mergeSignatures } from "@/lib/multisig/partial-xdr";
import { cn } from "@/lib/utils";

export interface PartialXdrImportProps {
  // canonical (originator-signed) envelope; the merge target
  readonly canonicalXdr: string;
  readonly networkPassphrase: string;
  // allowlist of signer public keys; mergeSignatures rejects anything not in this set
  readonly expectedSigners?: readonly string[];
  // called with the fully-merged base64 envelope after at least one successful merge
  readonly onMerged: (mergedXdr: string, addedSignaturesCount: number) => void;
  readonly className?: string;
}

interface MergeReport {
  readonly kind: "success" | "error";
  readonly message: string;
  readonly addedSignatures?: number;
}

export function PartialXdrImport(props: PartialXdrImportProps): ReactElement {
  const { canonicalXdr, networkPassphrase, expectedSigners, onMerged, className } = props;
  const [pasted, setPasted] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [report, setReport] = useState<MergeReport | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const performMerge = useCallback(
    (partials: readonly string[]) => {
      if (partials.length === 0) {
        setReport({ kind: "error", message: "Provide at least one partial XDR to merge." });
        return;
      }
      const trimmed = partials.map((s) => s.trim()).filter((s) => s.length > 0);
      if (trimmed.length === 0) {
        setReport({ kind: "error", message: "Provide at least one non-empty partial XDR." });
        return;
      }
      try {
        const merged = mergeSignatures(
          canonicalXdr,
          trimmed,
          networkPassphrase,
          expectedSigners && expectedSigners.length > 0 ? { expectedSigners } : {},
        );
        // mergeSignatures dedupes, so the merged-vs-canonical delta is net-new signatures
        const added = countSignatureDelta(canonicalXdr, merged, networkPassphrase);
        setReport({
          kind: "success",
          message: `Merged ${trimmed.length} partial envelope${trimmed.length === 1 ? "" : "s"}; added ${added} new signature${added === 1 ? "" : "s"}.`,
          addedSignatures: added,
        });
        onMerged(merged, added);
      } catch (err) {
        setReport({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [canonicalXdr, networkPassphrase, expectedSigners, onMerged],
  );

  const handlePasteSubmit = useCallback(() => {
    if (pasted.trim().length === 0) {
      setReport({ kind: "error", message: "Paste a base64 envelope first." });
      return;
    }
    // accept multiple newline-separated envelopes
    const partials = pasted
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    performMerge(partials);
  }, [pasted, performMerge]);

  const handleFiles = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;
      try {
        const contents = await Promise.all(
          Array.from(fileList).map((f) => f.text().then((t) => t.trim())),
        );
        performMerge(contents);
      } catch (err) {
        setReport({
          kind: "error",
          message: `Failed to read file(s): ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
    [performMerge],
  );

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragging(false);
      void handleFiles(e.dataTransfer?.files ?? null);
    },
    [handleFiles],
  );

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback(() => setIsDragging(false), []);

  const handleFileInputChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      void handleFiles(e.target.files);
      // reset so the same file can be re-selected
      e.target.value = "";
    },
    [handleFiles],
  );

  return (
    <section
      className={cn("rounded-lg border border-slate-300 bg-white p-4 text-slate-900", className)}
      data-testid="partial-xdr-import"
    >
      <header>
        <h2 className="text-sm font-semibold uppercase tracking-wide">Import partial XDR</h2>
        <p className="mt-1 text-xs text-slate-600">
          For legacy multisig workflows: drop or paste an envelope signed by another wallet to merge
          its signatures into the canonical transaction.
        </p>
      </header>

      <div
        className={cn(
          "mt-3 flex flex-col items-center justify-center rounded border-2 border-dashed p-6 text-center transition-colors",
          isDragging
            ? "border-indigo-500 bg-indigo-50 text-indigo-700"
            : "border-slate-300 bg-slate-50 text-slate-600",
        )}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        data-testid="partial-xdr-dropzone"
        aria-label="Drop signed XDR envelope files here"
      >
        <p className="text-sm">Drop signed envelope files here</p>
        <p className="mt-1 text-xs">or</p>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="mt-2 rounded border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
        >
          Choose file…
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".xdr,.txt,text/plain,application/octet-stream"
          onChange={handleFileInputChange}
          className="sr-only"
          data-testid="partial-xdr-file-input"
        />
      </div>

      <div className="mt-3">
        <label
          htmlFor="partial-xdr-paste"
          className="text-xs font-medium uppercase tracking-wide text-slate-700"
        >
          Or paste base64 XDR
        </label>
        <textarea
          id="partial-xdr-paste"
          className="mt-1 block w-full rounded border border-slate-300 px-2 py-2 font-mono text-xs"
          rows={4}
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          placeholder="AAAAAg... (one envelope per line)"
          data-testid="partial-xdr-paste-input"
        />
        <button
          type="button"
          onClick={handlePasteSubmit}
          className="mt-2 rounded bg-slate-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
          data-testid="partial-xdr-merge-button"
        >
          Merge pasted XDR
        </button>
      </div>

      {report ? (
        <p
          className={cn(
            "mt-3 rounded p-2 text-xs",
            report.kind === "success"
              ? "border border-emerald-300 bg-emerald-50 text-emerald-900"
              : "border border-red-300 bg-red-50 text-red-900",
          )}
          role={report.kind === "error" ? "alert" : "status"}
          data-testid="partial-xdr-report"
        >
          {report.message}
        </p>
      ) : null}
    </section>
  );
}

// count how many decorated signatures `merged` has beyond `original`
function countSignatureDelta(
  originalXdr: string,
  mergedXdr: string,
  networkPassphrase: string,
): number {
  try {
    const original = TransactionBuilder.fromXDR(originalXdr, networkPassphrase);
    const merged = TransactionBuilder.fromXDR(mergedXdr, networkPassphrase);
    const a = "signatures" in original ? original.signatures.length : 0;
    const b = "signatures" in merged ? merged.signatures.length : 0;
    return Math.max(0, b - a);
  } catch {
    return 0;
  }
}
