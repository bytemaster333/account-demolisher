// Server-Sent Events stream for a signing request. The initiator's page opens
// this and receives the full envelope the instant any signature is accepted, so
// progress updates live with no polling. Emits public data only (the envelope).

import { createLimiter, getRemoteIp } from "@/server/rate-limit";
import { getPlan, subscribe, subscriberStatus, type PlanPublic } from "@/server/signing-relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 25_000;
const limiter = createLimiter(20, 60_000);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!limiter.take(getRemoteIp(request))) {
    return new Response("too many requests", { status: 429 });
  }

  const { id } = await params;
  const status = subscriberStatus(id);
  if (status === "not-found") {
    return new Response("signing request not found", { status: 404 });
  }
  if (status === "at-cap") {
    // don't silently close: tell the client it's a transient capacity limit so it
    // can back off and retry (and fall back to fetch-polling meanwhile)
    return new Response("too many live listeners; retry shortly", {
      status: 503,
      headers: { "retry-after": "5" },
    });
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let torn = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (plan: PlanPublic): void => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(plan)}\n\n`));
        } catch {
          // stream already closed
        }
      };

      // idempotent teardown: clears the heartbeat, drops the subscriber, and
      // closes the stream exactly once, whichever lifecycle event fires first.
      const cleanup = (): void => {
        if (torn) return;
        torn = true;
        if (heartbeat !== null) clearInterval(heartbeat);
        unsubscribe?.();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      // subscribe before snapshotting so no accepted signature is missed; each
      // event is a full envelope, so out-of-order delivery still converges. The
      // relay calls `cleanup` if the plan is swept while this stream is open.
      unsubscribe = subscribe(id, send, cleanup);
      if (unsubscribe === null) {
        // plan vanished or subscriber cap reached between the check and here
        try {
          controller.close();
        } catch {
          // ignore
        }
        return;
      }

      // if the client already disconnected, the abort event has fired and a new
      // listener would never run: tear down immediately instead of leaking.
      if (request.signal.aborted) {
        cleanup();
        return;
      }
      request.signal.addEventListener("abort", cleanup, { once: true });

      const current = getPlan(id);
      if (current !== null) send(current);

      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          // closed
        }
      }, HEARTBEAT_MS);
    },
    cancel() {
      torn = true;
      if (heartbeat !== null) clearInterval(heartbeat);
      unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
