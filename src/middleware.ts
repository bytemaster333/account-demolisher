import { NextResponse, type NextRequest } from "next/server";

import { buildContentSecurityPolicy } from "@/lib/config/csp";

// Applies the Content-Security-Policy to each document response. Scripts use
// 'unsafe-inline' rather than a per-request nonce: Next.js's inline hydration
// scripts are not nonce-stamped in this deployment, so a nonce-only script-src
// blocks hydration entirely. The policy is otherwise static.
export function middleware(_request: NextRequest): NextResponse {
  const isDev = process.env.NODE_ENV !== "production";
  const csp = buildContentSecurityPolicy({ isDev });
  const response = NextResponse.next();
  response.headers.set("content-security-policy", csp);
  return response;
}

export const config = {
  // documents only — skip static assets, images, and the favicon (no document
  // context, no nonce needed), and skip prefetch requests
  matcher: [
    {
      source: "/((?!_next/static|_next/image|icon.svg|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
