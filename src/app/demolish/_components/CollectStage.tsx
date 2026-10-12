"use client";

import { CollectSignatures } from "@/components/multisig/CollectSignatures";
import type { NetworkConfig } from "@/lib/config/networks";
import type { SignerSnapshot } from "@/lib/multisig/bundle-freshness";
import type { AccountAudit } from "@/lib/types/account";

import type { PublishedRequest } from "../_hooks/use-signing-request";

// the Signatures step: the reviewed close was published; collect the other
// signatures live here, then the initiator closes. /sign is the page the other
// signers open.
export function CollectStage({
  request,
  notStored,
  audit,
  network,
  destination,
  connectedKey,
  onClose,
  onRebuildRequest,
}: {
  readonly request: PublishedRequest;
  // this browser couldn't store the request
  readonly notStored: boolean;
  readonly audit: AccountAudit;
  // the network the run is on
  readonly network: NetworkConfig;
  readonly destination: string;
  readonly connectedKey: string | null;
  readonly onClose: (signedXdr: string, typed: string, snapshot: SignerSnapshot) => void;
  readonly onRebuildRequest: () => void;
}): React.JSX.Element {
  return (
    <>
      {notStored ? (
        <p role="status" style={{ margin: "0 0 12px", fontSize: 12.5, color: "var(--warning)" }}>
          This browser can&apos;t store the request, so keep this tab open until it closes.
        </p>
      ) : null}
      <CollectSignatures
        planId={request.planId}
        audit={audit}
        network={network}
        initialXdr={request.xdr}
        destination={destination}
        connectedKey={connectedKey}
        onClose={onClose}
        onRebuildRequest={onRebuildRequest}
      />
    </>
  );
}
