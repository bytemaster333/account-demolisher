// shared metric event contract, used by both the browser beacon and the server
// route so the payload shape and validation live in one place.
//
// three event kinds, all aggregate and free of personal data:
//   visit:  a page was loaded (optional network; no cookie, no IP stored)
//   funnel: a usage milestone was reached (wallet connected, discovery done, ...)
//   close:  a successful account close, identified only by its public on-chain
//           transaction hash. the server checks that hash against Horizon and
//           counts it only when it is a successful merge carrying the on-chain
//           close marker (close-marker.ts), so made-up hashes and unrelated
//           merges are refused. the marker is public, so copies of it can be
//           counted too, within per-network daily caps.
//
// no addresses, wallet identifiers or amounts are sent from the client; a close
// carries just its tx hash, and every derived detail (reclaimed XLM, op
// breakdown, ledger) is read back from the public ledger server-side.

import { z } from "zod";

import { NETWORKS, type StellarNetwork } from "@/lib/config/networks";

// the networks the app is built for. derived from NETWORKS so a network dropped
// from the config can no longer be reported (resolveNetwork would otherwise map
// an unknown id to testnet and verify the close there)
export const METRIC_NETWORKS = Object.keys(NETWORKS) as [StellarNetwork, ...StellarNetwork[]];
export type MetricNetwork = StellarNetwork;

export const METRIC_PAGES = ["landing", "demolish", "allowances", "sign"] as const;
export type MetricPage = (typeof METRIC_PAGES)[number];

// usage milestones, in flow order. close completion is NOT here: it is the
// verifiable `close` event, counted only after on-chain verification.
export const FUNNEL_STEPS = [
  "wallet_connected",
  "discovery_completed",
  "plan_built",
  "close_started",
] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];

// stellar transaction hashes are 32 bytes, rendered as 64 lowercase hex chars.
export const TX_HASH_RE = /^[0-9a-f]{64}$/;

const networkSchema = z.enum(METRIC_NETWORKS);

export const visitEventSchema = z.object({
  type: z.literal("visit"),
  page: z.enum(METRIC_PAGES),
  // visits are network-agnostic (the landing page has no chain context); optional.
  network: networkSchema.optional(),
});

export const funnelEventSchema = z.object({
  type: z.literal("funnel"),
  step: z.enum(FUNNEL_STEPS),
  network: networkSchema,
});

export const closeEventSchema = z.object({
  type: z.literal("close"),
  network: networkSchema,
  txHash: z.string().regex(TX_HASH_RE, "txHash must be 64 lowercase hex chars"),
});

export const metricEventSchema = z.discriminatedUnion("type", [
  visitEventSchema,
  funnelEventSchema,
  closeEventSchema,
]);

export type VisitEvent = z.infer<typeof visitEventSchema>;
export type FunnelEvent = z.infer<typeof funnelEventSchema>;
export type CloseEvent = z.infer<typeof closeEventSchema>;
export type MetricEvent = z.infer<typeof metricEventSchema>;
