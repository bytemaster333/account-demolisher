import { createHash } from "node:crypto";

import { describe, it, expect } from "vitest";

import {
  BLEND_BACKSTOP_MAINNET_ID,
  BLEND_BACKSTOP_TESTNET_ID,
} from "@/lib/adapters/blend/constants";
import { MAINNET, TESTNET } from "@/lib/config/networks";
import { getRpc } from "@/lib/soroban/rpc-client";

// blend-testnet-backstop-queue-date.test.ts reads queue unlock dates on the
// testnet backstop, because mainnet rarely holds a locked queue to read. that
// only says something about mainnet while both backstops run the same wasm.

describe("integration: the testnet and mainnet blend backstops run the same wasm", () => {
  it("runs on the same backstop wasm as mainnet, so the date reading carries over", async () => {
    const sha = (wasm: Uint8Array): string => createHash("sha256").update(wasm).digest("hex");
    const [testnetWasm, mainnetWasm] = await Promise.all([
      getRpc(TESTNET).getContractWasmByContractId(BLEND_BACKSTOP_TESTNET_ID),
      getRpc(MAINNET).getContractWasmByContractId(BLEND_BACKSTOP_MAINNET_ID),
    ]);
    expect(sha(testnetWasm)).toBe(sha(mainnetWasm));
  });
});
