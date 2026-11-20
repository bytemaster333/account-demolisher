// UsageMap web analytics (https://usagemap.dev): privacy-first, cookie-free page-view
// counting for Stellar ecosystem projects, so usage can be shown to SCF reviewers.
//
// off unless NEXT_PUBLIC_USAGEMAP_SITE is set at build time (an unset docker build
// arg arrives as ""), so a self-hosted deployment sends nothing anywhere. the value is
// the public site key from app.usagemap.dev (Project → Websites), not a secret.
//
// the tracker is a pinned, immutable file with an SRI hash: a changed byte refuses
// to load, and nothing updates remotely. it stores no cookies, IP addresses, wallet
// addresses or query strings. upgrading means changing TRACKER_VERSION and its hash
// together, from https://e1.usagemap.dev/lib/manifest.json.

const configuredSite = process.env.NEXT_PUBLIC_USAGEMAP_SITE?.trim() ?? "";

/** the public site key, or null when analytics is off */
export const USAGEMAP_SITE: string | null = configuredSite === "" ? null : configuredSite;

export const USAGEMAP_TRACKER_VERSION = "1.2.0";

/** where the tracker loads from and the ingest hosts it sends to (failover pair) */
export const USAGEMAP_HOSTS = ["https://e1.usagemap.dev", "https://e2.usagemap.dev"] as const;

export const USAGEMAP_TRACKER_SRC = `${USAGEMAP_HOSTS[0]}/lib/${USAGEMAP_TRACKER_VERSION}/standard.js`;

/** sha384 of USAGEMAP_TRACKER_SRC as published in the UsageMap release manifest */
export const USAGEMAP_TRACKER_INTEGRITY =
  "sha384-LQ6Yh0GTmU5/SqFMPOIB8GnEv0brlfwn9tNxj8RHKmJtQLsApBuHoZnJ2M+/CyId";
