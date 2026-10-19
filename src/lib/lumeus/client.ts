// reads from lumeus, a hosted stellar history index run by a partner. the rpc's
// getEvents keeps about 7 days, so an approve, a token receipt or a pool deposit
// older than that is invisible to the event scans; lumeus indexes the whole
// history and answers the same questions in one or two requests.
//
// lumeus only adds candidates. every allowance, balance and pool it names is read
// again on chain before the plan uses it, and a row lumeus leaves out is still
// found by the rpc scan when it is recent. the browser calls lumeus directly with
// a publishable key (origin-locked, read-only, rate limited per ip), so the
// address being closed goes to lumeus the way it already goes to horizon and the
// rpc, and never to our server.

import { Contract, xdr, type rpc } from "@stellar/stellar-sdk";

import type { NetworkConfig } from "@/lib/config/networks";
import { getPublicEnv } from "@/lib/config/env";
import { errorMessage } from "@/lib/errors";
import { z } from "@/lib/zod";

import { LUMEUS_HOSTS } from "./hosts";

export interface LumeusConfig {
  readonly activity: string;
  readonly assets: string;
  readonly key: string;
}

// null when no publishable key is configured for the network: the scans then run
// on the rpc alone, as before
export function lumeusFor(network: NetworkConfig): LumeusConfig | null {
  const env = getPublicEnv();
  const key =
    network.id === "mainnet"
      ? env.NEXT_PUBLIC_LUMEUS_MAINNET_KEY
      : env.NEXT_PUBLIC_LUMEUS_TESTNET_KEY;
  if (key === undefined) return null;
  return { ...LUMEUS_HOSTS[network.id], key };
}

// events a partner index returned for one question, covering every ledger from
// the network's first through throughLedger
export interface PartnerEvents {
  readonly events: readonly rpc.Api.EventResponse[];
  readonly throughLedger: number;
}

export interface LumeusRequestOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxPages?: number;
}

// one page takes well under a second; a slow page is cut so the discovery
// timeout still has room for the on-chain reads
const REQUEST_TIMEOUT_MS = 8_000;
// 200 rows a page: 5,000 events for one question is far past any real account
const EVENT_PAGE_LIMIT = 200;
const MAX_EVENT_PAGES = 25;
const HOLDINGS_PAGE_LIMIT = 200;
const MAX_HOLDINGS_PAGES = 10;

export class LumeusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LumeusError";
  }
}

const readViewSchema = z.object({ snapshot_ledger: z.number().int().positive() });
const linksSchema = z.object({
  next: z.object({ href: z.string() }).optional(),
});

const contractEventSchema = z.object({
  kind: z.literal("contract_event"),
  type: z.string(),
  ledger: z.number().int().positive(),
  closed_at: z.string(),
  tx_hash: z.string(),
  tx_index: z.number().int(),
  operation_index: z.number().int().optional(),
  contract_address: z.string(),
  topics_xdr: z.array(z.string()),
  data_xdr: z.string(),
  rpc_event_id: z.string().min(1),
});

const eventPageSchema = z.object({
  read_view: readViewSchema,
  range_complete: z.boolean(),
  _links: linksSchema,
  _embedded: z.object({ records: z.array(contractEventSchema) }),
});

const holdingsPageSchema = z.object({
  read_view: z.object({ as_of_ledger: z.number().int().positive() }),
  _links: linksSchema,
  completeness: z.object({ unverified_contracts: z.array(z.string()).optional() }).optional(),
  _embedded: z.object({
    records: z.array(z.object({ kind: z.string(), contract_id: z.string().nullable() })),
  }),
});

async function getJson(
  base: string,
  pathAndQuery: string,
  key: string,
  opts: LumeusRequestOptions,
): Promise<unknown> {
  const url = new URL(pathAndQuery, base);
  // a next link is followed only on the host it came from, so the key never
  // reaches another origin
  if (url.origin !== new URL(base).origin) {
    throw new LumeusError(`partner index returned a link to another host (${url.origin})`);
  }
  const doFetch = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    throw new LumeusError(`partner index unreachable: ${errorMessage(e)}`);
  }
  if (!res.ok) {
    let reason = "";
    try {
      const body = (await res.json()) as { error?: unknown; request_id?: unknown };
      if (typeof body.error === "string") reason = `: ${body.error}`;
      if (typeof body.request_id === "string") reason += ` (request ${body.request_id})`;
    } catch {
      // a body that is not json leaves just the status
    }
    throw new LumeusError(`partner index answered HTTP ${res.status}${reason}`);
  }
  return res.json();
}

function toEventResponse(r: z.infer<typeof contractEventSchema>): rpc.Api.EventResponse {
  return {
    // the rpc's own event id, so a row both sources return is one row
    id: r.rpc_event_id,
    type: "contract",
    ledger: r.ledger,
    ledgerClosedAt: r.closed_at,
    transactionIndex: r.tx_index,
    // lumeus counts operations from 1, the rpc from 0
    operationIndex: (r.operation_index ?? 1) - 1,
    // lumeus indexes successful contract events only
    inSuccessfulContractCall: true,
    txHash: r.tx_hash,
    contractId: new Contract(r.contract_address),
    topic: r.topics_xdr.map((t) => xdr.ScVal.fromXDR(t, "base64")),
    value: xdr.ScVal.fromXDR(r.data_xdr, "base64"),
  };
}

export interface ContractEventQuery {
  // the event name, the first topic (approve, deposit, ...)
  readonly name: string;
  // only events whose topic at this index (1 to 3) is the address
  readonly position: 1 | 2 | 3;
  // only events this contract emitted
  readonly contract?: string;
}

// every contract event naming `address` at the given topic, over the whole
// history. throws unless the walk reached the end, so a partial answer is never
// taken for a complete one.
export async function lumeusContractEvents(
  cfg: LumeusConfig,
  address: string,
  query: ContractEventQuery,
  opts: LumeusRequestOptions = {},
): Promise<PartnerEvents> {
  const params = new URLSearchParams({
    name: query.name,
    position: String(query.position),
    limit: String(EVENT_PAGE_LIMIT),
    order: "asc",
  });
  if (query.contract !== undefined) params.set("contract", query.contract);
  let path = `/accounts/${encodeURIComponent(address)}/contract-events?${params.toString()}`;
  const events: rpc.Api.EventResponse[] = [];
  const maxPages = opts.maxPages ?? MAX_EVENT_PAGES;
  for (let page = 0; page < maxPages; page++) {
    const parsed = eventPageSchema.safeParse(await getJson(cfg.activity, path, cfg.key, opts));
    if (!parsed.success) {
      throw new LumeusError(`partner index returned an unexpected page: ${parsed.error.message}`);
    }
    for (const r of parsed.data._embedded.records) {
      try {
        events.push(toEventResponse(r));
      } catch (e) {
        throw new LumeusError(
          `partner index returned an event that does not decode (${r.rpc_event_id}): ${errorMessage(e)}`,
        );
      }
    }
    if (parsed.data.range_complete) {
      return { events, throughLedger: parsed.data.read_view.snapshot_ledger };
    }
    const next = parsed.data._links.next?.href;
    if (next === undefined) {
      throw new LumeusError("partner index page is not the last one but has no next link");
    }
    path = next;
  }
  throw new LumeusError(`partner index walk stopped at its ${maxPages}-page cap`);
}

export interface PartnerTokens {
  // contract tokens the address holds a balance of in contract storage
  readonly contractIds: readonly string[];
  readonly asOfLedger: number;
}

// the custom (contract storage) tokens `address` holds now, those lumeus could
// not verify included: they are candidates the caller reads on chain anyway
export async function lumeusContractTokens(
  cfg: LumeusConfig,
  address: string,
  opts: LumeusRequestOptions = {},
): Promise<PartnerTokens> {
  let path: string | undefined =
    `/accounts/${encodeURIComponent(address)}/holdings?kind=contract&include=unverified&limit=${HOLDINGS_PAGE_LIMIT}`;
  const ids = new Set<string>();
  let asOfLedger: number | null = null;
  const maxPages = opts.maxPages ?? MAX_HOLDINGS_PAGES;
  for (let page = 0; page < maxPages && path !== undefined; page++) {
    const parsed = holdingsPageSchema.safeParse(await getJson(cfg.assets, path, cfg.key, opts));
    if (!parsed.success) {
      throw new LumeusError(`partner index returned an unexpected page: ${parsed.error.message}`);
    }
    // later pages of one walk read the same state; the oldest is what it covers
    asOfLedger = Math.min(asOfLedger ?? Infinity, parsed.data.read_view.as_of_ledger);
    for (const r of parsed.data._embedded.records) {
      if (r.kind === "contract" && r.contract_id !== null) ids.add(r.contract_id);
    }
    for (const c of parsed.data.completeness?.unverified_contracts ?? []) ids.add(c);
    path = parsed.data._links.next?.href;
  }
  if (path !== undefined) {
    throw new LumeusError(`partner index holdings walk stopped at its ${maxPages}-page cap`);
  }
  if (asOfLedger === null) throw new LumeusError("partner index returned no holdings page");
  return { contractIds: [...ids], asOfLedger };
}

// the partner reads the scans take, or undefined when no key is configured for
// the network. each is a thunk, so the scan starts it alongside its own rpc reads

export function partnerApprovals(
  network: NetworkConfig,
  owner: string,
): (() => Promise<PartnerEvents>) | undefined {
  const cfg = lumeusFor(network);
  if (cfg === null) return undefined;
  // sep-41 approve(from, spender, ...): the owner is topic 1
  return () => lumeusContractEvents(cfg, owner, { name: "approve", position: 1 });
}

export function partnerHeldTokens(
  network: NetworkConfig,
  holder: string,
): (() => Promise<PartnerTokens>) | undefined {
  const cfg = lumeusFor(network);
  if (cfg === null) return undefined;
  return () => lumeusContractTokens(cfg, holder);
}

export function partnerRouterDeposits(
  network: NetworkConfig,
): ((routerId: string, user: string) => Promise<PartnerEvents>) | undefined {
  const cfg = lumeusFor(network);
  if (cfg === null) return undefined;
  // the aquarius router's deposit(tokens, user, ...): the user is topic 2
  return (routerId, user) =>
    lumeusContractEvents(cfg, user, { name: "deposit", position: 2, contract: routerId });
}
