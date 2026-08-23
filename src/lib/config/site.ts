// canonical public origin, used for SEO metadata, the sitemap, and robots.txt.
// defaults to the reference deployment; a self-hoster sets NEXT_PUBLIC_SITE_URL
// to their own origin. trailing slash trimmed so `${SITE_URL}/path` is clean.
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://demolisher.app").replace(
  /\/+$/,
  "",
);

// the user-facing routes worth listing in the sitemap (the API routes and the
// per-flow /sign?id= link are intentionally excluded)
export const PUBLIC_ROUTES = ["/", "/demolish", "/allowances"] as const;
