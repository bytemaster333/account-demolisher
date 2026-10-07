// node-only body of the server start hook (src/instrumentation.ts). it lives in
// its own module because next compiles instrumentation.ts for the edge runtime
// too, where process.exit and node:net (via rate-limit.ts) are not available;
// importing it only under NEXT_RUNTIME === "nodejs" keeps it out of that build.

import { errorMessage } from "@/lib/errors";
import { assertTrustedProxyConfig } from "@/server/rate-limit";

// the app is only supported behind a reverse proxy, so a TRUSTED_PROXY_HOPS that
// can't identify clients stops the process here instead of failing every
// rate-limited request later
export function refuseUnsafeStartup(): void {
  try {
    assertTrustedProxyConfig();
  } catch (e) {
    // a throw from register() only makes `next start` log "Failed to prepare
    // server" and answer 500 to every request while it keeps listening, so exit
    console.error(`refusing to start: ${errorMessage(e)}`);
    process.exit(1);
  }
}
