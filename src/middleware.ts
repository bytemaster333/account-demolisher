import { NextResponse, type NextRequest } from "next/server";

import { buildContentSecurityPolicy } from "@/lib/config/csp";

// Per-request nonce CSP (SEC-18). A fresh nonce is minted per request and placed
// in the CSP; Next reads it from the request's Content-Security-Policy header and
// stamps its own framework/inline scripts with the same nonce, so script-src can
// drop 'unsafe-inline'. This forces dynamic rendering for matched routes (the
// nonce can't be static), an accepted trade-off for a destructive tool.
export function middleware(request: NextRequest): NextResponse {
  const isDev = process.env.NODE_ENV !== "production";
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const csp = buildContentSecurityPolicy({ nonce, isDev });

  // Next reads the nonce from the CSP on the REQUEST headers to nonce its scripts.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
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
