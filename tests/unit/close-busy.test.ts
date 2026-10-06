import { beforeEach, describe, expect, it } from "vitest";

import { useCloseBusy } from "@/stores/close-busy";
import { useNetworkStore } from "@/stores/network";

// the flags the demolish page raises while a close runs or signatures are being
// collected, and that the app shell reads to hold navigation, the network switch
// and wallet disconnect (M-10, M-35)

describe("close busy flag (M-10)", () => {
  beforeEach(() => useCloseBusy.getState().setBusy(false));

  it("starts idle", () => {
    expect(useCloseBusy.getState().busy).toBe(false);
  });

  it("is raised and cleared by setBusy", () => {
    useCloseBusy.getState().setBusy(true);
    expect(useCloseBusy.getState().busy).toBe(true);
    useCloseBusy.getState().setBusy(false);
    expect(useCloseBusy.getState().busy).toBe(false);
  });
});

describe("network lock (M-35)", () => {
  beforeEach(() => useNetworkStore.getState().setLockReason(null));

  it("is unlocked by default", () => {
    expect(useNetworkStore.getState().lockReason).toBeNull();
  });

  it("holds the reason the switch is locked, and clears it", () => {
    const reason = "A close is running on this network.";
    useNetworkStore.getState().setLockReason(reason);
    expect(useNetworkStore.getState().lockReason).toBe(reason);
    useNetworkStore.getState().setLockReason(null);
    expect(useNetworkStore.getState().lockReason).toBeNull();
  });

  it("does not change the selected network", () => {
    const before = useNetworkStore.getState().networkId;
    useNetworkStore.getState().setLockReason("busy");
    expect(useNetworkStore.getState().networkId).toBe(before);
  });
});
