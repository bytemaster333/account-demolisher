// Shared metric event contract, used by BOTH the browser beacon and the server
// route so the payload shape and validation live in exactly one place.
//
// Three event kinds, all AGGREGATE and free of personal data:
//   visit  — a page was loaded (optional network; no cookie, no IP stored)
//   funnel — a usage milestone was reached (wallet connected, discovery done, …)
//   close  — a successful account close, identified ONLY by its public on-chain
//            transaction hash. The server independently verifies that hash against
//            Horizon before counting it, so the close ledger is auditable and
//            cannot be inflated with fabricated hashes.
//
// No addresses, wallet identifiers, or amounts are ever sent from the client —
// a close carries just its tx hash, and every derived detail (reclaimed XLM, op
// breakdown, ledger) is read back from the public ledger server-side.

import { z } from "zod";

export const METRIC_NETWORKS = ["mainnet", "testnet", "futurenet"] as const;
export type MetricNetwork = (typeof METRIC_NETWORKS)[number];

export const METRIC_PAGES = ["landing", "demolish", "allowances", "sign"] as const;
export type MetricPage = (typeof METRIC_PAGES)[number];

// usage milestones, in flow order. close completion is NOT here — it is the
// verifiable `close` event, counted only after on-chain verification.
export const FUNNEL_STEPS = [
  "wallet_connected",
  "discovery_completed",
  "plan_built",
  "close_started",
] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];

// Stellar transaction hashes are 32 bytes, rendered as 64 lowercase hex chars.
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
