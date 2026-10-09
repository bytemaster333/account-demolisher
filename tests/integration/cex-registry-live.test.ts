import { describe, expect, it } from "vitest";

import { MAINNET } from "@/lib/config/networks";
import { KNOWN_CEXES, REFUSED_DESTINATIONS } from "@/lib/safety/cex-registry";

// read-only check of the exchange registry against the stellar.expert directory
// and mainnet horizon. an entry the directory renamed or retagged, or a deposit
// account that went quiet, has to be verified again before the app keeps
// routing closes to it. it reads public services whose state has nothing to do
// with a given change, so it runs on a schedule (mainnet-timing.yml) and not in
// the blocking ci job. each test lists every stale or mismatched address at once.

const DIRECTORY = "https://api.stellar.expert/explorer/directory";
// an exchange deposit account in use is paid every few days; a month without
// any change means it may no longer be the address the exchange hands out
const MAX_DEPOSIT_IDLE_DAYS = 30;
const DAY_MS = 86_400_000;

interface DirectoryEntry {
  readonly address: string;
  readonly name: string;
  readonly domain?: string;
  readonly tags: readonly string[];
}

interface AccountState {
  readonly lastModifiedLedger: number;
  // null when that ledger is older than the history this horizon keeps
  readonly lastModifiedTime: string | null;
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${url} answered HTTP ${String(res.status)}`);
  return res.json();
}

async function directoryEntry(address: string): Promise<DirectoryEntry | null> {
  const body = (await getJson(`${DIRECTORY}/${address}`)) as DirectoryEntry | null;
  if (body === null) return null;
  if (body.address !== address || typeof body.name !== "string" || !Array.isArray(body.tags)) {
    throw new Error(`the directory answered an unreadable entry for ${address}`);
  }
  return body;
}

async function accountState(address: string): Promise<AccountState | null> {
  const body = (await getJson(`${MAINNET.horizon}/accounts/${address}`)) as {
    last_modified_ledger?: unknown;
    last_modified_time?: unknown;
  } | null;
  if (body === null) return null;
  if (typeof body.last_modified_ledger !== "number") {
    throw new Error(`horizon answered no last_modified_ledger for ${address}`);
  }
  const time = body.last_modified_time;
  if (time !== null && typeof time !== "string") {
    throw new Error(`horizon answered an unreadable last_modified_time for ${address}`);
  }
  return { lastModifiedLedger: body.last_modified_ledger, lastModifiedTime: time };
}

async function elderLedger(): Promise<number> {
  const root = (await getJson(MAINNET.horizon)) as { history_elder_ledger?: unknown } | null;
  if (typeof root?.history_elder_ledger !== "number") {
    throw new Error(`${MAINNET.horizon} answered no history_elder_ledger`);
  }
  return root.history_elder_ledger;
}

// "Crypto.com" in the registry is "CryptoCom" in the directory
function sameName(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/gu, "");
  return norm(a) === norm(b);
}

function directoryProblems(address: string, name: string, entry: DirectoryEntry | null): string[] {
  if (entry === null) return [`${address} (${name}): not in the stellar.expert directory`];
  if (!sameName(entry.name, name)) {
    return [`${address}: the directory names it "${entry.name}", the registry "${name}"`];
  }
  return [];
}

describe("integration: exchange registry against the live directory and mainnet", () => {
  it("lists every deposit address as an active exchange account with the memo rule it carries", async () => {
    const elder = await elderLedger();
    const now = Date.now();
    const problems: string[] = [];
    for (const cex of KNOWN_CEXES) {
      const entry = await directoryEntry(cex.address);
      problems.push(...directoryProblems(cex.address, cex.name, entry));
      if (entry !== null) {
        if (!entry.tags.includes("exchange")) {
          problems.push(`${cex.address} (${cex.name}): the directory no longer tags it exchange`);
        }
        const memoRequired = entry.tags.includes("memo-required");
        if (memoRequired !== cex.requiresMemo) {
          problems.push(
            `${cex.address} (${cex.name}): the directory says memo-required ${String(memoRequired)}, ` +
              `the registry requiresMemo ${String(cex.requiresMemo)}`,
          );
        }
      }

      const account = await accountState(cex.address);
      if (account === null) {
        problems.push(`${cex.address} (${cex.name}): the account does not exist on mainnet`);
        continue;
      }
      // an owner-approved dormant entry passes only while it is unchanged; once
      // it moves, the exception is out of date and the entry needs a new look
      if (cex.dormantSinceLedger !== undefined) {
        if (account.lastModifiedLedger !== cex.dormantSinceLedger) {
          problems.push(
            `${cex.address} (${cex.name}): recorded dormant since ledger ` +
              `${String(cex.dormantSinceLedger)}, but last changed at ledger ` +
              `${String(account.lastModifiedLedger)}; verify it again and update dormantSinceLedger`,
          );
        }
        continue;
      }
      if (account.lastModifiedTime === null) {
        if (account.lastModifiedLedger >= elder) {
          throw new Error(`horizon gave no time for ${cex.address}'s ledger inside its history`);
        }
        problems.push(
          `${cex.address} (${cex.name}): last changed at ledger ${String(account.lastModifiedLedger)}, ` +
            `before the history horizon keeps (from ledger ${String(elder)})`,
        );
        continue;
      }
      const idleDays = Math.floor((now - Date.parse(account.lastModifiedTime)) / DAY_MS);
      if (idleDays > MAX_DEPOSIT_IDLE_DAYS) {
        problems.push(
          `${cex.address} (${cex.name}): last changed ${account.lastModifiedTime}, ` +
            `${String(idleDays)} days ago (limit ${String(MAX_DEPOSIT_IDLE_DAYS)})`,
        );
      }
    }
    expect(problems).toEqual([]);
  });

  // a refused account is refused whether it is busy or not, so its activity is
  // not checked. what would make the entry wrong is the directory no longer
  // naming it the same exchange wallet, or tagging it memo-required, which
  // marks a deposit address
  it("lists every refused destination as the same non-deposit exchange account", async () => {
    const problems: string[] = [];
    for (const refused of REFUSED_DESTINATIONS) {
      const entry = await directoryEntry(refused.address);
      problems.push(...directoryProblems(refused.address, refused.name, entry));
      if (entry?.tags.includes("memo-required") === true) {
        problems.push(
          `${refused.address} (${refused.name}): the directory now tags it memo-required, ` +
            "so it may be a deposit address",
        );
      }
      if ((await accountState(refused.address)) === null) {
        problems.push(`${refused.address} (${refused.name}): the account no longer exists`);
      }
    }
    expect(problems).toEqual([]);
  });
});
