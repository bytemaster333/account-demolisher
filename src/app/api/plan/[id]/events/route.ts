// Server-Sent Events stream for a signing request. the initiator's page opens
// this and receives the full envelope the instant any signature is accepted, so
// progress updates live with no polling. emits public data only (the envelope).

import { createLimiter, getRemoteIp, rateLimitByIp } from "@/server/rate-limit";
import { getPlan, subscribe, subscriberStatus, type PlanPublic } from "@/server/signing-relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 25_000;
const limiter = createLimiter(20, 60_000);

function notFound(): Response {
  return new Response("signing request not found", { status: 404 });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const limited = rateLimitByIp(limiter, request);
  if (limited !== null) return limited;
  // resolves the same way rateLimitByIp just did, so it can't throw here
  const clientKey = getRemoteIp(request);

  const { id } = await params;
  const status = subscriberStatus(id, clientKey);
  if (status === "not-found") return notFound();
  if (status !== "ok") {
    // EventSource treats any non-200 as fatal, so the browser client switches to
    // polling GET /api/plan/[id] and retries the stream later (plan-client.ts)
    return new Response("too many live listeners for this signing request", {
      status: 503,
      headers: { "retry-after": "30" },
    });
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let torn = false;
  let opened = false;
  // set once the abort listener is attached; every teardown path removes it so
  // a finished stream leaves nothing on the request's signal
  let detachAbort: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (plan: PlanPublic): void => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(plan)}\n\n`));
        } catch {
          // the stream closed between the check and the write; cleanup follows
        }
      };

      // idempotent teardown: clears the heartbeat, drops the subscriber, and
      // closes the stream exactly once, whichever lifecycle event fires first.
      const cleanup = (): void => {
        if (torn) return;
        torn = true;
        if (heartbeat !== null) clearInterval(heartbeat);
        heartbeat = null;
        detachAbort?.();
        unsubscribe?.();
        try {
          controller.close();
        } catch {
          // already closed by the client
        }
      };

      // subscribe before snapshotting so no accepted signature is missed; each
      // event is a full envelope, so out-of-order delivery still converges. the
      // relay calls `cleanup` if the plan is swept while this stream is open.
      unsubscribe = subscribe(id, send, cleanup, clientKey);
      if (unsubscribe === null) {
        cleanup();
        return;
      }

      // if the client already disconnected, the abort event has fired and a new
      // listener would never run: tear down immediately instead of leaking.
      if (request.signal.aborted) {
        cleanup();
        return;
      }
      request.signal.addEventListener("abort", cleanup, { once: true });
      detachAbort = () => request.signal.removeEventListener("abort", cleanup);

      const current = getPlan(id);
      if (torn || current === null) {
        cleanup();
        return;
      }
      opened = true;
      send(current);

      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          cleanup();
        }
      }, HEARTBEAT_MS);
    },
    cancel() {
      torn = true;
      if (heartbeat !== null) clearInterval(heartbeat);
      heartbeat = null;
      detachAbort?.();
      unsubscribe?.();
    },
  });

  // the plan vanished between the status check and the subscription
  if (!opened) return notFound();

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
