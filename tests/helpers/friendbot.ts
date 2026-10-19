// funds a fresh testnet account through friendbot. the integration suite makes
// about a hundred of these calls against a shared public faucet that answers
// 5xx, 429 or hangs under load, so a single refusal must not fail an hour-long
// run: each attempt is time-boxed, a transient refusal is retried with backoff,
// and an account that exists after a lost response counts as funded.

import { TESTNET } from "../../src/lib/config/networks";
import { errorMessage } from "../../src/lib/errors";

const ATTEMPT_TIMEOUT_MS = 30_000;
const BACKOFF_MS = [2_000, 5_000, 10_000, 20_000, 30_000];

async function accountExists(publicKey: string): Promise<boolean> {
  const res = await fetch(`${TESTNET.horizon}/accounts/${encodeURIComponent(publicKey)}`, {
    signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
  });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`horizon answered ${res.status} for ${publicKey}`);
  return true;
}

export async function fundWithFriendbot(publicKey: string): Promise<void> {
  if (TESTNET.friendbot === null) throw new Error("testnet has no friendbot");
  const url = `${TESTNET.friendbot}?addr=${encodeURIComponent(publicKey)}`;
  const failures: string[] = [];
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    let failure: string;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS) });
      if (res.ok) return;
      const body = (await res.text().catch(() => "")).slice(0, 200);
      // a 4xx other than 429 is the request's own fault, not the faucet's load
      if (res.status < 500 && res.status !== 429) {
        if (await accountExists(publicKey)) return;
        throw new Error(`friendbot funding failed for ${publicKey}: HTTP ${res.status} ${body}`);
      }
      failure = `HTTP ${res.status}`;
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("friendbot funding failed")) throw e;
      failure = errorMessage(e);
    }
    failures.push(failure);
    // the funding may have landed even though the answer did not arrive
    if (await accountExists(publicKey).catch(() => false)) return;
    const wait = BACKOFF_MS[attempt];
    if (wait === undefined) break;
    await new Promise((r) => setTimeout(r, wait));
  }
  throw new Error(
    `friendbot funding failed for ${publicKey} after ${failures.length} attempts: ${failures.join("; ")}`,
  );
}
