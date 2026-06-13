// aquarius pool discovery. two interchangeable providers: REST API and event-scan
import { type rpc, type xdr } from "@stellar/stellar-sdk";
import { getAllowlistForNetwork, type AllowedContract } from "@/lib/config/contracts";
import { MAINNET, type NetworkConfig } from "@/lib/config/networks";
import { balance as sep41Balance } from "@/lib/soroban/sep41";
import {
  fromScValAddress,
  fromScValSymbol,
  address as scvAddress,
  vec as scvVec,
} from "@/lib/soroban/scval";
import { simulateRead } from "@/lib/soroban/simulate";

// one pool the user holds shares in
export interface AquariusPool {
  readonly poolIndex: string;
  readonly poolType: string;
  readonly tokens: readonly string[];
  readonly shareBalance: bigint;
  // optional reward-availability hint for the claimWhen predicate
  readonly hasRewards?: boolean;
}

export interface AquariusPoolProvider {
  getUserPools(userPublicKey: string): Promise<AquariusPool[]>;
  getPoolShareBalance(
    poolIndex: string,
    tokens: readonly string[],
    userPublicKey: string,
  ): Promise<bigint>;
}

// resolve aquarius router id from the network's allow-list. defaults to mainnet
function getAquariusRouterIdFromAllowlist(network: NetworkConfig = MAINNET): string {
  const list = getAllowlistForNetwork(network);
  const entry: AllowedContract | undefined = list.find(
    (c) => c.protocol === "aquarius" && c.name === "AquariusAmmRouter",
  );
  if (entry === undefined) {
    throw new Error(
      `Aquarius router not found in ${network.id} allow-list — expected entry name 'AquariusAmmRouter'`,
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

// inverse of poolIndexHexToBytes. lowercase hex, no 0x prefix
export function poolIndexBytesToHex(bytes: Uint8Array): string {
  if (bytes.length !== 32) {
    throw new RangeError(
      `Aquarius pool_index must be 32 bytes (BytesN<32>); got length ${bytes.length}`,
    );
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// encode a hex pool_index as scvBytes
async function poolIndexToScVal(poolIndexHex: string): Promise<xdr.ScVal> {
  const { xdr } = await import("@stellar/stellar-sdk");
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
    [tokensToScVal(tokens), await poolIndexToScVal(poolIndex)],
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

// testnet base URL for completeness
export const AQUARIUS_API_TESTNET_BASE_URL = "https://amm-api-testnet.aqua.network/api/external/v1";

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

export interface AquariusAPIPoolProviderOptions {
  readonly server: rpc.Server;
  readonly network: NetworkConfig;
  // override for tests; trailing slash stripped
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

// REST-backed provider against aquarius's public API
export class AquariusAPIPoolProvider implements AquariusPoolProvider {
  private readonly server: rpc.Server;
  private readonly network: NetworkConfig;
  private readonly baseUrl: string;
  private readonly routerId: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AquariusAPIPoolProviderOptions) {
    this.server = opts.server;
    this.network = opts.network;
    this.baseUrl = (opts.baseUrl ?? AQUARIUS_API_MAINNET_BASE_URL).replace(/\/+$/, "");
    this.routerId = getAquariusRouterIdFromAllowlist(opts.network);
    const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    if (fetchImpl === undefined) {
      throw new Error("AquariusAPIPoolProvider: no fetch implementation available");
    }
    this.fetchImpl = fetchImpl;
  }

  async getUserPools(userPublicKey: string): Promise<AquariusPool[]> {
    const entries = await this.fetchUserPoolsAllPages(userPublicKey);
    // drop zero-balance pools — user no longer an LP there
    const pools: AquariusPool[] = [];
    for (const entry of entries) {
      const sharesRaw = await this.getPoolShareBalance(
        entry.index,
        entry.tokens_addresses,
        userPublicKey,
      );
      if (sharesRaw === 0n) continue;
      pools.push({
        poolIndex: entry.index,
        poolType: entry.pool_type,
        tokens: entry.tokens_addresses,
        shareBalance: sharesRaw,
      });
    }
    return pools;
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

  // walk the django REST paginated envelope. hard-cap at 100 pages
  private async fetchUserPoolsAllPages(userPublicKey: string): Promise<AquariusUserPoolApiEntry[]> {
    const MAX_PAGES = 100;
    const out: AquariusUserPoolApiEntry[] = [];
    let url: string | null = `${this.baseUrl}/pools/user/${encodeURIComponent(userPublicKey)}/`;

    for (let page = 0; page < MAX_PAGES; page++) {
      if (url === null) break;
      const resp: Response = await this.fetchImpl(url, {
        headers: { accept: "application/json" },
      });
      if (!resp.ok) {
        throw new Error(`Aquarius API: GET ${url} returned HTTP ${resp.status} ${resp.statusText}`);
      }
      const parsed: unknown = await resp.json();
      const body = assertUserPoolsApiResponse(parsed, url);
      out.push(...body.results);
      url = body.next;
    }
    return out;
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
  // soroban RPC retains ~7 days of events by default. defaults to 120_960 ledgers (~7 days at 5s)
  readonly lookbackLedgers?: number;
  readonly maxPages?: number;
}

const DEFAULT_EVENT_LOOKBACK_LEDGERS = 120_960;
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
    const startLedger = Math.max(1, latest.sequence - this.lookbackLedgers);

    // dedupe by tokens+poolAddress since the same pool appears in many events
    const observed = new Map<string, { tokens: string[]; poolAddress: string }>();

    let cursor: string | undefined;
    for (let page = 0; page < this.maxPages; page++) {
      const request: rpc.Api.GetEventsRequest =
        cursor === undefined
          ? {
              startLedger,
              filters: [
                {
                  type: "contract",
                  contractIds: [this.routerId],
                },
              ],
              limit: EVENT_PAGE_LIMIT,
            }
          : {
              cursor,
              filters: [
                {
                  type: "contract",
                  contractIds: [this.routerId],
                },
              ],
              limit: EVENT_PAGE_LIMIT,
            };

      const resp = await this.server.getEvents(request);
      if (resp.events.length === 0) break;

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

        const shareBalance = await this.getPoolShareBalance(poolIndex, value.tokens, userPublicKey);
        if (shareBalance === 0n) continue;
        const poolType = await this.readPoolType(value.tokens, poolIndex, userPublicKey);
        out.push({
          poolIndex,
          poolType,
          tokens: value.tokens,
          shareBalance,
        });
      } catch {
        continue;
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
      [tokensToScVal(tokens), await poolIndexToScVal(poolIndex)],
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

// decode router.get_pools return value
function decodeBytesN32AddressMap(v: xdr.ScVal): Map<string, string> {
  if (v.switch().name !== "scvMap") {
    throw new TypeError(`Expected scvMap for router.get_pools return; got ${v.switch().name}`);
  }
  const entries = v.map();
  if (entries === null) {
    throw new TypeError("router.get_pools return: scvMap had null entries");
  }
  const out = new Map<string, string>();
  for (const entry of entries) {
    const key = entry.key();
    const val = entry.val();
    if (key.switch().name !== "scvBytes") {
      throw new TypeError(`router.get_pools key: expected scvBytes, got ${key.switch().name}`);
    }
    const keyBytes = key.bytes();
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
    if (tokensScVal.switch().name !== "scvVec") return null;
    const vecVal = tokensScVal.vec();
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
  if (data.switch().name !== "scvVec") return null;
  const arr = data.vec();
  if (!arr || arr.length < 1) return null;
  let poolAddress: string;
  try {
    poolAddress = fromScValAddress(arr[0]!);
  } catch {
    return null;
  }

  return { poolAddress, tokens };
}

// internals re-export. not part of the public surface
export const __internals = {
  getAquariusRouterIdFromAllowlist,
  tokensToScVal,
  poolIndexToScVal,
  readShareIdFromRouter,
  tryDecodeDepositOrWithdrawEvent,
  assertUserPoolsApiResponse,
  decodeBytesN32AddressMap,
};
