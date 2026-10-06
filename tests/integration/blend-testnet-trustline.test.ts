import { describe, it, expect } from "vitest";
import { Horizon, Keypair } from "@stellar/stellar-sdk";

import { blndTokenForNetwork } from "@/lib/adapters/blend/constants";
import { buildBlndTrustlineTx } from "@/lib/adapters/blend/emissions-check";
import { TESTNET } from "@/lib/config/networks";

// live testnet check that the change_trust a close adds before a blend
// emissions claim lands, and leaves a line the BLND SAC can pay into
const horizon = new Horizon.Server(TESTNET.horizon);

describe("integration: BLND trustline for emissions claims on testnet", () => {
  it("opens an authorized trustline to the pinned BLND asset", async () => {
    const kp = Keypair.random();
    const res = await fetch(`${TESTNET.friendbot}?addr=${encodeURIComponent(kp.publicKey())}`);
    if (!res.ok) throw new Error(`friendbot funding failed: ${res.status}`);

    const tx = buildBlndTrustlineTx(TESTNET, await horizon.loadAccount(kp.publicKey()));
    tx.sign(kp);
    await horizon.submitTransaction(tx);

    const blnd = blndTokenForNetwork(TESTNET);
    const account = await horizon.loadAccount(kp.publicKey());
    const line = account.balances.find(
      (b) =>
        b.asset_type === "credit_alphanum4" &&
        b.asset_code === "BLND" &&
        b.asset_issuer === blnd.issuer,
    );
    expect(line).toBeDefined();
    expect(line && "is_authorized" in line ? line.is_authorized : false).toBe(true);
  });
});
