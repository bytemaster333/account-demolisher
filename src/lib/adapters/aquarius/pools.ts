// aquarius pool discovery. two interchangeable providers: REST API and event-scan.
// both cover the router's standard (constant product / stable) pools only; a
// concentrated pool keeps tick-range positions in its own storage and is found by
// discoverConcentratedPositions in ./concentrated.
import { Address, xdr, type rpc } from "@stellar/stellar-sdk";
import { getAllowlistForNetwork, type AllowedContract } from "@/lib/config/contracts";
import { unsupportedNetwork, type NetworkConfig } from "@/lib/config/networks";
import { errorMessage } from "@/lib/errors";
import { balance as sep41Balance } from "@/lib/soroban/sep41";
import {
  fromScValAddress,
  fromScValSymbol,
  address as scvAddress,
  vec as scvVec,
} from "@/lib/soroban/scval";
import { simulateRead } from "@/lib/soroban/simulate";
import {
  EVENT_RETENTION_WINDOW_LEDGERS,
  MAX_RETENTION_RETRIES,
  RETENTION_RETRY_MARGIN_LEDGERS,
  parseRetentionFloor,
} from "@/lib/soroban/event-retention";
import { findConcentratedPool } from "@/lib/adapters/aquarius/concentrated-pools";

// one pool the user holds shares in
export interface AquariusPool {
  readonly poolIndex: string;
  // the pool contract; pool_index alone is not unique across token sets
  readonly poolAddress: string;
  readonly poolType: string;
  readonly tokens: readonly string[];
  readonly shareBalance: bigint;
}

export interface AquariusPoolProvider {
  getUserPools(userPublicKey: string): Promise<AquariusPool[]>;
  getPoolShareBalance(
    poolIndex: string,
    tokens: readonly string[],
    userPublicKey: string,
  ): Promise<bigint>;
}

// the router's pool_type answer and the REST pool_type for a concentrated pool
export const CONCENTRATED_POOL_TYPE = "concentrated";

// resolve aquarius router id from the network's allow-list
function getAquariusRouterIdFromAllowlist(network: NetworkConfig): string {
  const list = getAllowlistForNetwork(network);
  const entry: AllowedContract | undefined = list.find(
    (c) => c.protocol === "aquarius" && c.name === "AquariusAmmRouter",
  );
  if (entry === undefined) {
    throw new Error(
      `Aquarius router not found in ${network.id} allow-list: expected entry name 'AquariusAmmRouter'`,
    );
  }
  return entry.id;
}

// encode tokens: vec<address>
function tokensToScVal(tokens: readonly string[]): xdr.ScVal {
  return scvVec(tokens.map((t) => scvAddress(t)));
}

// decode a 64-char hex poolIndex to a 32-byte buffer
export function poolIndexHexToBytes(poolIndexHex: string): Uint8Array {
  const stripped = poolIndexHex.startsWith("0x") ? poolIndexHex.slice(2) : poolIndexHex;
  if (stripped.length !== 64) {
    throw new RangeError(
      `Aquarius pool_index must be 64 hex chars (BytesN<32>); got length ${stripped.length}`,
    );
  }
  if (!/^[0-9a-fA-F]+$/.test(stripped)) {
    throw new TypeError(
      `Aquarius pool_index must be hex-only; got "${poolIndexHex.slice(0, 16)}…"`,
    );
  }
  const bytes = new Uint8Array(stripped.length / 2);
  for (let i = 0; i < stripped.length; i += 2) {
    bytes[i / 2] = parseInt(stripped.slice(i, i + 2), 16);
  }
  return bytes;
}

function poolIndexToScVal(poolIndexHex: string): xdr.ScVal {
  return xdr.ScVal.scvBytes(Buffer.from(poolIndexHexToBytes(poolIndexHex)));
}

// router.share_id(tokens, pool_index) -> address. returns the SEP-41 share-token id
async function readShareIdFromRouter(
  server: rpc.Server,
  network: NetworkConfig,
  routerId: string,
  tokens: readonly string[],
  poolIndex: string,
  sourcePublicKey: string,
): Promise<string> {
  const { retval } = await simulateRead(
    server,
    routerId,
    "share_id",
    [tokensToScVal(tokens), poolIndexToScVal(poolIndex)],
    sourcePublicKey,
    network,
  );
  return fromScValAddress(retval);
}

// shared share-balance lookup: router.share_id -> sep41.balance
async function getPoolShareBalanceImpl(args: {
  server: rpc.Server;
  network: NetworkConfig;
  routerId: string;
  tokens: readonly string[];
  poolIndex: string;
  userPublicKey: string;
}): Promise<bigint> {
  const shareTokenId = await readShareIdFromRouter(
    args.server,
    args.network,
    args.routerId,
    args.tokens,
    args.poolIndex,
    args.userPublicKey,
  );
  return sep41Balance(
    args.server,
    shareTokenId,
    args.userPublicKey,
    args.userPublicKey,
    args.network,
  );
}

// mainnet aquarius backend base URL (verified_at 2026-05-15, source: docs.aqua.network)
export const AQUARIUS_API_MAINNET_BASE_URL = "https://amm-api.aqua.network/api/external/v1";

// testnet aquarius backend base URL
export const AQUARIUS_API_TESTNET_BASE_URL = "https://amm-api-testnet.aqua.network/api/external/v1";

// pick the aquarius REST backend for the given network. a network with no
// aquarius deployment gets an error, never another network's backend.
export function aquariusApiBaseUrlForNetwork(network: NetworkConfig): string {
  switch (network.id) {
    case "mainnet":
      return AQUARIUS_API_MAINNET_BASE_URL;
    case "testnet":
      return AQUARIUS_API_TESTNET_BASE_URL;
    default:
      return unsupportedNetwork(network.id);
  }
}

// a page that has not fully arrived after this long is abandoned: discovery and
// the merge-time reprobe must not hang on an upstream that accepts the connection
// and never finishes the body
export const AQUARIUS_API_TIMEOUT_MS = 15_000;

// one result entry from GET /pools/user/{key}/
interface AquariusUserPoolApiEntry {
  readonly index: string;
  readonly address: string;
  readonly tokens_addresses: readonly string[];
  readonly pool_type: string;
}

interface AquariusUserPoolApiResponse {
  readonly count: number;
  readonly next: string | null;
  readonly previous: string | null;
  readonly results: readonly AquariusUserPoolApiEntry[];
}

// what the REST source saw for one user: standard pools with a positive share
// balance, the concentrated pools it listed (handled by the on-chain
// concentrated discovery), and one message per entry that could not be resolved
export interface AquariusRestScan {
  readonly standard: readonly AquariusPool[];
  readonly concentratedAddresses: readonly string[];
  readonly errors: readonly string[];
}

export interface AquariusAPIPoolProviderOptions {
  readonly server: rpc.Server;
  readonly network: NetworkConfig;
  // override for tests; trailing slash stripped
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

// thrown by getUserPools when some listed entries could not be resolved. the
// message names each failed pool; partialPools holds the ones that did read, so
// a caller can still plan their exits while it records the failure
export class AquariusPartialPoolsError extends Error {
  readonly partialPools: readonly AquariusPool[];
  readonly failures: readonly string[];
  constructor(failures: readonly string[], partialPools: readonly AquariusPool[]) {
    super(`Aquarius API: ${failures.join("; ")}`);
    this.name = "AquariusPartialPoolsError";
    this.failures = failures;
    this.partialPools = partialPools;
  }
}

// REST-backed provider against aquarius's public API
export class AquariusAPIPoolProvider implements AquariusPoolProvider {
  private readonly server: rpc.Server;
  private readonly network: NetworkConfig;
  private readonly baseUrl: string;
  private readonly routerId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: AquariusAPIPoolProviderOptions) {
    this.server = opts.server;
    this.network = opts.network;
    this.baseUrl = (opts.baseUrl ?? aquariusApiBaseUrlForNetwork(opts.network)).replace(/\/+$/, "");
    this.routerId = getAquariusRouterIdFromAllowlist(opts.network);
    this.timeoutMs = opts.timeoutMs ?? AQUARIUS_API_TIMEOUT_MS;
    // the browser's fetch must be invoked with `this === window`; stored on the
    // instance and called as `this.fetchImpl(...)` it would otherwise throw
    // "Illegal invocation". bind the global default; a caller-supplied mock is
    // used as-is.
    const fetchImpl = opts.fetchImpl ?? globalThis.fetch?.bind(globalThis);
    if (fetchImpl === undefined) {
      throw new Error("AquariusAPIPoolProvider: no fetch implementation available");
    }
    this.fetchImpl = fetchImpl;
  }

  // standard pools only. throws AquariusPartialPoolsError when any listed entry
  // could not be resolved (a failed share read is not "no shares") or when the
  // API lists a concentrated pool that is not pinned, so the caller records a
  // discovery error and still gets the pools that did read.
  async getUserPools(userPublicKey: string): Promise<AquariusPool[]> {
    const scan = await this.scanUserPools(userPublicKey);
    if (scan.errors.length > 0) {
      throw new AquariusPartialPoolsError(scan.errors, scan.standard);
    }
    return [...scan.standard];
  }

  // reads every entry the API lists, keeping going past a failed entry so one bad
  // pool does not hide the others
  async scanUserPools(userPublicKey: string): Promise<AquariusRestScan> {
    const entries = await this.fetchUserPoolsAllPages(userPublicKey);
    const standard: AquariusPool[] = [];
    const concentratedAddresses: string[] = [];
    const errors: string[] = [];
    for (const entry of entries) {
      if (entry.pool_type === CONCENTRATED_POOL_TYPE) {
        concentratedAddresses.push(entry.address);
        if (findConcentratedPool(entry.address, this.network) === undefined) {
          errors.push(
            `concentrated pool ${entry.address} is not on the pinned ${this.network.id} list; ` +
              `its position cannot be exited in-app`,
          );
        }
        continue;
      }
      try {
        const sharesRaw = await this.getPoolShareBalance(
          entry.index,
          entry.tokens_addresses,
          userPublicKey,
        );
        // zero balance: the user is no longer an LP there
        if (sharesRaw === 0n) continue;
        standard.push({
          poolIndex: entry.index,
          poolAddress: entry.address,
          poolType: entry.pool_type,
          tokens: entry.tokens_addresses,
          shareBalance: sharesRaw,
        });
      } catch (e) {
        errors.push(`could not read shares in pool ${entry.address} (${errorMessage(e)})`);
      }
    }
    return { standard, concentratedAddresses, errors };
  }

  async getPoolShareBalance(
    poolIndex: string,
    tokens: readonly string[],
    userPublicKey: string,
  ): Promise<bigint> {
    return getPoolShareBalanceImpl({
      server: this.server,
      network: this.network,
      routerId: this.routerId,
      tokens,
      poolIndex,
      userPublicKey,
    });
  }

  // walk the django REST paginated envelope. a listing longer than MAX_PAGES is
  // reported as an error rather than returned as if complete
  private async fetchUserPoolsAllPages(userPublicKey: string): Promise<AquariusUserPoolApiEntry[]> {
    const MAX_PAGES = 100;
    const out: AquariusUserPoolApiEntry[] = [];
    let url: string | null = `${this.baseUrl}/pools/user/${encodeURIComponent(userPublicKey)}/`;

    for (let page = 0; page < MAX_PAGES; page++) {
      if (url === null) return out;
      const parsed = await this.fetchJson(url);
      const body = assertUserPoolsApiResponse(parsed, url);
      out.push(...body.results);
      url = body.next;
    }
    if (url !== null) {
      throw new Error(
        `Aquarius API: user pool listing exceeds ${MAX_PAGES} pages; refusing a partial list`,
      );
    }
    return out;
  }

  // one GET with a hard deadline on headers and body together. the race is kept
  // even though the signal is passed, so a fetch implementation that ignores the
  // signal still cannot hold discovery open
  private async fetchJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`Aquarius API: GET ${url} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([
        (async () => {
          const resp: Response = await this.fetchImpl(url, {
            headers: { accept: "application/json" },
            signal: controller.signal,
          });
          if (!resp.ok) {
            throw new Error(
              `Aquarius API: GET ${url} returned HTTP ${resp.status} ${resp.statusText}`,
            );
          }
          return (await resp.json()) as unknown;
        })(),
        deadline,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

// strict shape guard for the user-pools response
function assertUserPoolsApiResponse(parsed: unknown, url: string): AquariusUserPoolApiResponse {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Aquarius API: unexpected response shape (not an object) for ${url}`);
  }
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.count !== "number" ||
    (obj.next !== null && typeof obj.next !== "string") ||
    (obj.previous !== null && typeof obj.previous !== "string") ||
    !Array.isArray(obj.results)
  ) {
    throw new Error(
      `Aquarius API: unexpected response shape (missing/typo'd envelope fields) for ${url}`,
    );
  }
  const results: AquariusUserPoolApiEntry[] = [];
  for (const r of obj.results) {
    if (typeof r !== "object" || r === null) {
      throw new Error(`Aquarius API: unexpected response shape (non-object result) for ${url}`);
    }
    const entry = r as Record<string, unknown>;
    if (
      typeof entry.index !== "string" ||
      typeof entry.address !== "string" ||
      typeof entry.pool_type !== "string" ||
      !Array.isArray(entry.tokens_addresses) ||
      !entry.tokens_addresses.every((t) => typeof t === "string")
    ) {
      throw new Error(`Aquarius API: unexpected response shape (per-result fields) for ${url}`);
    }
    results.push({
      index: entry.index,
      address: entry.address,
      pool_type: entry.pool_type,
      tokens_addresses: entry.tokens_addresses as string[],
    });
  }
  return {
    count: obj.count,
    next: obj.next as string | null,
    previous: obj.previous as string | null,
    results,
  };
}

export interface AquariusEventScanPoolProviderOptions {
  readonly server: rpc.Server;
  readonly network: NetworkConfig;
  // defaults to the rpc's stock retention window (EVENT_RETENTION_WINDOW_LEDGERS)
  readonly lookbackLedgers?: number;
  readonly maxPages?: number;
}

const DEFAULT_EVENT_LOOKBACK_LEDGERS = EVENT_RETENTION_WINDOW_LEDGERS;
const EVENT_PAGE_LIMIT = 10_000;
const DEFAULT_EVENT_MAX_PAGES = 100;

// discovers pools by scanning router deposit/withdraw events. no third-party API
export class AquariusEventScanPoolProvider implements AquariusPoolProvider {
  private readonly server: rpc.Server;
  private readonly network: NetworkConfig;
  private readonly routerId: string;
  private readonly lookbackLedgers: number;
  private readonly maxPages: number;

  constructor(opts: AquariusEventScanPoolProviderOptions) {
    this.server = opts.server;
    this.network = opts.network;
    this.routerId = getAquariusRouterIdFromAllowlist(opts.network);
    this.lookbackLedgers = opts.lookbackLedgers ?? DEFAULT_EVENT_LOOKBACK_LEDGERS;
    this.maxPages = opts.maxPages ?? DEFAULT_EVENT_MAX_PAGES;
    if (this.lookbackLedgers < 1) {
      throw new RangeError(
        `AquariusEventScanPoolProvider: lookbackLedgers must be >= 1; got ${this.lookbackLedgers}`,
      );
    }
  }

  async getUserPools(userPublicKey: string): Promise<AquariusPool[]> {
    const latest = await this.server.getLatestLedger();
    let startLedger = Math.max(1, latest.sequence - this.lookbackLedgers);

    // the router emits deposit/withdraw with topics [symbol, Vec<Address> tokens,
    // Address user] (observed on mainnet). filtering on the user server-side
    // keeps the scan to this account's own events instead of downloading every
    // router swap (about 97k a week on mainnet).
    const userXdr = new Address(userPublicKey).toScVal().toXdr("base64");
    const filter: rpc.Api.EventFilter = {
      type: "contract",
      contractIds: [this.routerId],
      topics: [
        [xdr.ScVal.scvSymbol("deposit").toXdr("base64"), "*", userXdr],
        [xdr.ScVal.scvSymbol("withdraw").toXdr("base64"), "*", userXdr],
      ],
    };

    // dedupe by tokens+poolAddress since the same pool appears in many events
    const observed = new Map<string, { tokens: string[]; poolAddress: string }>();

    let cursor: string | undefined;
    let retentionRetries = 0;
    let exhausted = false;
    for (let page = 0; ; page++) {
      if (page >= this.maxPages) {
        exhausted = true;
        break;
      }
      const request: rpc.Api.GetEventsRequest =
        cursor === undefined
          ? { startLedger, filters: [filter], limit: EVENT_PAGE_LIMIT }
          : { cursor, filters: [filter], limit: EVENT_PAGE_LIMIT };

      let resp: rpc.Api.GetEventsResponse;
      try {
        resp = await this.server.getEvents(request);
      } catch (err) {
        // on the first page, a startLedger below the RPC retention floor throws a
        // "ledger range" error. re-clamp to the reported floor (plus a margin) and
        // redo this page instead of aborting the whole (fallback) scan.
        const floor = cursor === undefined ? parseRetentionFloor(err) : null;
        if (floor === null || retentionRetries >= MAX_RETENTION_RETRIES) throw err;
        retentionRetries += 1;
        startLedger = Math.min(latest.sequence, floor + RETENTION_RETRY_MARGIN_LEDGERS);
        page -= 1; // the for-loop's page++ then redoes this page with the clamp
        continue;
      }
      // NB: do NOT break on an empty page. getEvents can return an empty page with
      // a still-advancing cursor; the cursor-stall check below is the real end
      // condition, and maxPages bounds the loop.

      for (const ev of resp.events) {
        const decoded = tryDecodeDepositOrWithdrawEvent(ev, userPublicKey, this.routerId);
        if (decoded === null) continue;
        const key = `${decoded.tokens.join(",")}|${decoded.poolAddress}`;
        if (!observed.has(key)) {
          observed.set(key, { tokens: decoded.tokens, poolAddress: decoded.poolAddress });
        }
      }

      if (!resp.cursor || resp.cursor === cursor) break;
      cursor = resp.cursor;
    }
    if (exhausted) {
      throw new Error(
        `Aquarius event scan stopped at its ${this.maxPages}-page cap with more events pending; ` +
          `the scan is incomplete`,
      );
    }

    const out: AquariusPool[] = [];
    // cache get_pools(tokens) per tokens tuple
    const poolsByTokens = new Map<string, Map<string, string>>();
    for (const [, value] of observed) {
      try {
        const tokensKey = value.tokens.join(",");
        let map = poolsByTokens.get(tokensKey);
        if (map === undefined) {
          map = await this.readGetPools(value.tokens, userPublicKey);
          poolsByTokens.set(tokensKey, map);
        }
        // map: map<poolIndexHex, poolAddress>. reverse-lookup by address
        let poolIndex: string | undefined;
        for (const [idxHex, addr] of map) {
          if (addr === value.poolAddress) {
            poolIndex = idxHex;
            break;
          }
        }
        if (poolIndex === undefined) continue;

        const poolType = await this.readPoolType(value.tokens, poolIndex, userPublicKey);
        // the router does not route deposit_position, but a concentrated pool can
        // still emit router-level events; its position is read by the dedicated
        // concentrated discovery, not as router shares
        if (poolType === CONCENTRATED_POOL_TYPE) continue;
        const shareBalance = await this.getPoolShareBalance(poolIndex, value.tokens, userPublicKey);
        if (shareBalance === 0n) continue;
        out.push({
          poolIndex,
          poolAddress: value.poolAddress,
          poolType,
          tokens: value.tokens,
          shareBalance,
        });
      } catch (e) {
        // an RPC/decode failure while probing a pool the user has interacted with
        // is NOT "no position": swallowing it could strand a live LP balance and
        // let the merge proceed. surface it so discovery reports an incomplete
        // scan (a whole-scan throw becomes a user-facing discoveryWarning).
        throw new Error(
          `Aquarius: failed to probe pool ${value.poolAddress}; discovery may be incomplete ` +
            `(${errorMessage(e)})`,
        );
      }
    }
    return out;
  }

  async getPoolShareBalance(
    poolIndex: string,
    tokens: readonly string[],
    userPublicKey: string,
  ): Promise<bigint> {
    return getPoolShareBalanceImpl({
      server: this.server,
      network: this.network,
      routerId: this.routerId,
      tokens,
      poolIndex,
      userPublicKey,
    });
  }

  // router.pool_type(tokens, pool_index) -> symbol
  private async readPoolType(
    tokens: readonly string[],
    poolIndex: string,
    sourcePublicKey: string,
  ): Promise<string> {
    const { retval } = await simulateRead(
      this.server,
      this.routerId,
      "pool_type",
      [tokensToScVal(tokens), poolIndexToScVal(poolIndex)],
      sourcePublicKey,
      this.network,
    );
    return fromScValSymbol(retval);
  }

  // router.get_pools(tokens) -> map<BytesN<32>, address>
  private async readGetPools(
    tokens: readonly string[],
    sourcePublicKey: string,
  ): Promise<Map<string, string>> {
    const { retval } = await simulateRead(
      this.server,
      this.routerId,
      "get_pools",
      [tokensToScVal(tokens)],
      sourcePublicKey,
      this.network,
    );
    return decodeBytesN32AddressMap(retval);
  }
}

// the pool contract the router keeps under (tokens, pool_index). a position
// summary carries only the index, and the router is the one source that can't
// be pointed at some other contract.
export async function readAquariusPoolAddress(
  server: rpc.Server,
  network: NetworkConfig,
  tokens: readonly string[],
  poolIndex: string,
  sourcePublicKey: string,
): Promise<string> {
  const { retval } = await simulateRead(
    server,
    getAquariusRouterIdFromAllowlist(network),
    "get_pools",
    [tokensToScVal(tokens)],
    sourcePublicKey,
    network,
  );
  const wanted = Array.from(poolIndexHexToBytes(poolIndex), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  const address = decodeBytesN32AddressMap(retval).get(wanted);
  if (address === undefined) {
    throw new Error(
      `the Aquarius router lists no pool with index ${wanted} for tokens ${tokens.join(", ")}`,
    );
  }
  return address;
}

// decode router.get_pools return value
function decodeBytesN32AddressMap(v: xdr.ScVal): Map<string, string> {
  if (v.type !== "scvMap") {
    throw new TypeError(`Expected scvMap for router.get_pools return; got ${v.type}`);
  }
  const entries = v.map;
  if (entries === null) {
    throw new TypeError("router.get_pools return: scvMap had null entries");
  }
  const out = new Map<string, string>();
  for (const entry of entries) {
    const key = entry.key;
    const val = entry.val;
    if (key.type !== "scvBytes") {
      throw new TypeError(`router.get_pools key: expected scvBytes, got ${key.type}`);
    }
    const keyBytes = key.bytes.toBytes();
    if (keyBytes.length !== 32) {
      throw new RangeError(
        `router.get_pools key: expected 32 bytes (BytesN<32>), got ${keyBytes.length}`,
      );
    }
    const idxHex = Array.from(keyBytes, (b: number) => b.toString(16).padStart(2, "0")).join("");
    const addr = fromScValAddress(val);
    out.set(idxHex, addr);
  }
  return out;
}

// decode a getEvents item into a (tokens, poolAddress) pair for matching deposit/withdraw events
function tryDecodeDepositOrWithdrawEvent(
  ev: rpc.Api.EventResponse,
  userAddress: string,
  expectedRouterId: string,
): { poolAddress: string; tokens: string[] } | null {
  if (ev.contractId === undefined) return null;
  const contractId = ev.contractId.contractId();
  if (contractId !== expectedRouterId) return null;

  const topics = ev.topic;
  if (topics.length !== 3) return null;

  let topicName: string;
  try {
    topicName = fromScValSymbol(topics[0]!);
  } catch {
    return null;
  }
  if (topicName !== "deposit" && topicName !== "withdraw") return null;

  let tokens: string[];
  try {
    const tokensScVal = topics[1]!;
    if (tokensScVal.type !== "scvVec") return null;
    const vecVal = tokensScVal.vec;
    if (!vecVal) return null;
    tokens = vecVal.map((t) => fromScValAddress(t));
  } catch {
    return null;
  }

  let userTopic: string;
  try {
    userTopic = fromScValAddress(topics[2]!);
  } catch {
    return null;
  }
  if (userTopic !== userAddress) return null;

  const data = ev.value;
  if (data.type !== "scvVec") return null;
  const arr = data.vec;
  if (!arr || arr.length < 1) return null;
  let poolAddress: string;
  try {
    poolAddress = fromScValAddress(arr[0]!);
  } catch {
    return null;
  }

  return { poolAddress, tokens };
}
