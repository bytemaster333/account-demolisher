import type { MetadataRoute } from "next";

import { SITE_URL } from "@/lib/config/site";

// allow indexing of the public pages; the per-flow /sign link and API routes carry
// no useful index value, so keep crawlers off them.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/api/", "/sign"] },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
