import { NextResponse, type NextRequest } from "next/server";

import { buildContentSecurityPolicy } from "@/lib/config/csp";

// sets the Content-Security-Policy on each document response. scripts use
// 'unsafe-inline' rather than a per-request nonce: Next's inline hydration
// scripts are not nonce-stamped in this deployment, so a nonce-only script-src
// blocks hydration entirely. the policy is otherwise static.
//
// this is the Next 16 `proxy` file convention (the renamed `middleware`).
export function proxy(_request: NextRequest): NextResponse {
  const isDev = process.env.NODE_ENV !== "production";
  const csp = buildContentSecurityPolicy({ isDev });
  const response = NextResponse.next();
  response.headers.set("content-security-policy", csp);
  return response;
}

export const config = {
  // documents only. /api is skipped because a request that passes through the
  // node proxy has its whole body buffered by Next before the route runs, which
  // would defeat the routes' streaming body caps (read-body.ts); JSON responses
  // need no CSP, and the static headers in next.config.ts still apply to them.
  // static assets, the image endpoint, the icons and prefetches are skipped too.
  matcher: [
    {
      source: "/((?!api/|_next/static|_next/image|icon.svg|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
