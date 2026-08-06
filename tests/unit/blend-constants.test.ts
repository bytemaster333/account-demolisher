import { describe, it, expect } from "vitest";

import {
  resolveBackstopId,
  BLEND_BACKSTOP_MAINNET_ID,
  BLEND_BACKSTOP_TESTNET_ID,
} from "@/lib/adapters/blend/constants";
import { isAllowedContract } from "@/lib/config/contracts";
import { MAINNET, TESTNET } from "@/lib/config/networks";
import type { NetworkConfig } from "@/lib/config/networks";

// resolveBackstopId used to return null on testnet, which made the whole backstop
// path (detection AND the queued withdrawal) dead on the very network this
// milestone targets. It must now resolve a real, allow-listed backstop id on
// both mainnet and testnet.
describe("resolveBackstopId", () => {
  it("resolves the mainnet v2 backstop id", () => {
    expect(resolveBackstopId(MAINNET)).toBe(BLEND_BACKSTOP_MAINNET_ID);
    expect(BLEND_BACKSTOP_MAINNET_ID).toMatch(/^C[A-Z2-7]{55}$/);
  });

  it("resolves the testnet v2 backstop id (previously null)", () => {
    expect(resolveBackstopId(TESTNET)).toBe(BLEND_BACKSTOP_TESTNET_ID);
    expect(BLEND_BACKSTOP_TESTNET_ID).toBe(
      "CBDVWXT433PRVTUNM56C3JREF3HIZHRBA64NB2C3B2UNCKIS65ZYCLZA",
    );
  });

  it("keeps the resolved backstop on the allow-list (the queue_withdrawal tx targets it)", () => {
    expect(isAllowedContract(BLEND_BACKSTOP_MAINNET_ID, MAINNET)).toBe(true);
    expect(isAllowedContract(BLEND_BACKSTOP_TESTNET_ID, TESTNET)).toBe(true);
  });

  it("returns null for a network with no snapshotted backstop (futurenet)", () => {
    expect(resolveBackstopId({ id: "futurenet" } as unknown as NetworkConfig)).toBeNull();
  });
});
