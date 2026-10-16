// an in-memory stand-in for stellar-rpc's getHealth/getEvents that applies the
// request the way the rpc does: startLedger inclusive, endLedger exclusive, topic
// filters matched segment by segment with exact topic counts, "*" for one segment.
// behaviours a real host shows under load are switchable per test.

import { Address, Contract, xdr, type rpc } from "@stellar/stellar-sdk";

export interface FakeEvent {
  readonly ledger: number;
  // position within the ledger, for ordering
  readonly index: number;
  readonly contractId: string;
  readonly topic: readonly xdr.ScVal[];
  readonly value?: xdr.ScVal;
}

export interface FakeEventsRpcOptions {
  readonly oldestLedger: number;
  readonly latestLedger: number;
  readonly events: readonly FakeEvent[];
  // windows wider than this answer the rpc's -32001 processing-limit error
  readonly maxCheapWindow?: number;
  // a request that would match more than this returns a full page of `limit`
  readonly honorLimit?: boolean;
  // windows starting at or below this ledger never answer
  readonly hangAtOrBelow?: number;
  // ms each request takes (real timers, or advanced fake ones)
  readonly latencyMs?: number;
  // the window the host is configured to keep; defaults to what it holds. set it
  // larger to model a host that restarted and holds less than its window
  readonly ledgerRetentionWindow?: number;
  // the first `requests` getEvents calls answer as if the host's history began
  // at `floor`: a load balancer routing them to a host that restarted
  readonly shortHostFirst?: { readonly floor: number; readonly requests: number };
}

export function eventId(ledger: number, index: number): string {
  return `${String(ledger).padStart(19, "0")}-${String(index).padStart(10, "0")}`;
}

export const sym = (s: string): xdr.ScVal => xdr.ScVal.scvSymbol(s);
export const addr = (s: string): xdr.ScVal => new Address(s).toScVal();

function matches(topic: readonly xdr.ScVal[], filters: rpc.Api.EventFilter[]): boolean {
  const encoded = topic.map((t) => t.toXdr("base64"));
  return filters.some((f) =>
    (f.topics ?? []).some(
      (pattern) =>
        pattern.length === encoded.length &&
        pattern.every((seg, i) => seg === "*" || seg === encoded[i]),
    ),
  );
}

export function fakeEventsRpc(opts: FakeEventsRpcOptions) {
  const requests: rpc.Api.GetEventsRequest[] = [];
  const getEvents = async (req: rpc.Api.GetEventsRequest): Promise<rpc.Api.GetEventsResponse> => {
    requests.push(req);
    if (opts.latencyMs !== undefined) await new Promise((r) => setTimeout(r, opts.latencyMs));
    if (req.startLedger === undefined) throw new Error("fake rpc: cursor paging is not modelled");
    const start = req.startLedger;
    const short = opts.shortHostFirst;
    const oldest =
      short !== undefined && requests.length <= short.requests ? short.floor : opts.oldestLedger;
    if (start < oldest || start > opts.latestLedger) {
      throw {
        code: -32600,
        message: `startLedger must be within the ledger range: ${oldest} - ${opts.latestLedger}`,
      };
    }
    const end = Math.min(req.endLedger ?? start + 10_000, opts.latestLedger + 1);
    if (opts.hangAtOrBelow !== undefined && start <= opts.hangAtOrBelow) {
      return new Promise(() => {});
    }
    if (opts.maxCheapWindow !== undefined && end - start > opts.maxCheapWindow) {
      throw { code: -32001, message: "request exceeded processing limit threshold" };
    }
    const limit = req.limit ?? 100;
    const hits = opts.events
      .filter((e) => e.ledger >= start && e.ledger < end && matches(e.topic, req.filters))
      .sort((a, b) => a.ledger - b.ledger || a.index - b.index)
      .slice(0, opts.honorLimit === false ? undefined : limit);
    return {
      latestLedger: opts.latestLedger,
      oldestLedger: opts.oldestLedger,
      latestLedgerCloseTime: 0,
      oldestLedgerCloseTime: 0,
      cursor: eventId(end - 1, 4_294_967_295),
      events: hits.map(
        (e) =>
          ({
            id: eventId(e.ledger, e.index),
            type: "contract",
            ledger: e.ledger,
            ledgerClosedAt: "",
            transactionIndex: 0,
            operationIndex: 0,
            inSuccessfulContractCall: true,
            txHash: "",
            contractId: new Contract(e.contractId),
            topic: [...e.topic],
            value: e.value ?? xdr.ScVal.scvVoid(),
          }) as unknown as rpc.Api.EventResponse,
      ),
    } as unknown as rpc.Api.GetEventsResponse;
  };
  const server = {
    getHealth: async () => ({
      status: "healthy",
      latestLedger: opts.latestLedger,
      oldestLedger: opts.oldestLedger,
      ledgerRetentionWindow:
        opts.ledgerRetentionWindow ?? opts.latestLedger - opts.oldestLedger + 1,
    }),
    getEvents,
  } as unknown as rpc.Server;
  return { server, requests };
}
