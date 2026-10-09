"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import { walletTeardownNotice } from "@/components/wallet/teardown-message";
import type { NetworkConfig } from "@/lib/config/networks";
import { disconnectSession, getActiveConnector } from "@/lib/wallet/active-connector";
import { WalletKitConnector, type Connector, type ConnectorKind } from "@/lib/wallet/connector";

export interface FlowConnector {
  // the connector a new run signs with; a ref so ConnectButton's re-notify on
  // every render never creates new state
  readonly connectorRef: RefObject<Connector | null>;
  // a live connector that can actually sign here
  readonly hasConnector: boolean;
  readonly setConnector: (c: Connector | null) => void;
}

// the wallet connection the page signs with
export function useFlowConnector(
  publicKey: string | null,
  connectorKind: ConnectorKind | null,
  network: NetworkConfig,
): FlowConnector {
  const connectorRef = useRef<Connector | null>(null);

  // do we have a live connector that can actually SIGN here? Derived (not stored)
  // so it stays in sync with the app-wide wallet session across client-side
  // navigation: a kit connection can always be reconstructed, and any live
  // connector shared via setActiveConnector (e.g. from /allowances) counts. A
  // pasted-seed session whose connector didn't survive to this page stays
  // unsignable, which correctly gates the CTA. Mirrors the allowances page.
  const hasConnector =
    publicKey !== null && (getActiveConnector() !== null || connectorKind === "kit");

  // populate connectorRef when arriving already-connected (e.g. connected on
  // /allowances, then navigated here client-side). connectorRef starts empty on
  // each mount, but the wallet session is shared, so recover the live connector
  // for signing. Sets a ref only (no state) so the derived hasConnector above is
  // the single source of truth for the gate.
  useEffect(() => {
    if (publicKey === null) {
      connectorRef.current = null;
      return;
    }
    if (connectorRef.current !== null) return; // connected on this page already
    const active = getActiveConnector();
    if (active !== null) {
      connectorRef.current = active;
    } else if (connectorKind === "kit") {
      // the kit reads its own persisted wallet selection, so a fresh instance can
      // sign even after the live object was lost
      connectorRef.current = new WalletKitConnector(network);
    }
  }, [publicKey, connectorKind, network]);

  const setConnector = useCallback((c: Connector | null) => {
    connectorRef.current = c;
    // ConnectButton re-notifies every render, so nothing here may create a new
    // state value on each call (it would spin an infinite render loop). The
    // preflight is keyed to the account and the signing request to the run, so
    // neither needs an explicit reset here.
  }, []);

  useEffect(() => {
    return () => {
      connectorRef.current = null;
    };
  }, []);

  return { connectorRef, hasConnector, setConnector };
}

// a wallet session that didn't close cleanly (a WalletConnect pairing can stay
// live on the phone); said on the page, not only in the console
export function useTeardownNotice(): {
  readonly teardownError: string | null;
  readonly onTeardownError: (err: unknown) => void;
  readonly clearTeardownError: () => void;
} {
  const [teardownError, setTeardownError] = useState<string | null>(null);
  const onTeardownError = useCallback((err: unknown) => {
    setTeardownError(walletTeardownNotice(err));
  }, []);
  const clearTeardownError = useCallback(() => setTeardownError(null), []);
  return { teardownError, onTeardownError, clearTeardownError };
}

// once the account is closed it no longer exists, drop the connection so a
// later navigation back to /demolish starts at Connect, not Configure with a
// dead account. A shared close also ends in the machine "succeeded" state (the
// collected bundle is submitted via SUBMIT_BUNDLE), so this one guard covers
// both flows. A run that only prepared the close ends in "prepared" instead
// and leaves the account open, so the wallet stays connected for the run that
// finishes it. Cleared directly (not via setConnector) so the success view
// stays visible. Fires once.
export function useDisconnectWhenClosed(args: {
  readonly isSucceeded: boolean;
  readonly connectorRef: RefObject<Connector | null>;
  // whether the close was a collected bundle, whose signing request is then done
  readonly bundleSubmitted: boolean;
  readonly finishSigning: () => void;
  readonly disconnectWallet: () => void;
  readonly onTeardownError: (err: unknown) => void;
}): void {
  const { isSucceeded, connectorRef, bundleSubmitted, finishSigning } = args;
  const { disconnectWallet, onTeardownError } = args;
  const closedRef = useRef(false);
  useEffect(() => {
    if (isSucceeded && !closedRef.current) {
      closedRef.current = true;
      connectorRef.current = null;
      // a submitted signing request has nothing left to resume
      if (bundleSubmitted) finishSigning();
      // full teardown (connector + kit + store): the account was merged and no
      // longer exists, so leave nothing authorized to it at the wallet level
      void disconnectSession(disconnectWallet, onTeardownError);
    } else if (!isSucceeded && closedRef.current) {
      closedRef.current = false;
    }
  }, [
    isSucceeded,
    connectorRef,
    disconnectWallet,
    bundleSubmitted,
    finishSigning,
    onTeardownError,
  ]);
}
