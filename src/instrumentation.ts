// next calls register() once when a server instance starts, before it serves
// any request. the app is only supported behind a reverse proxy, so a
// TRUSTED_PROXY_HOPS that can't identify clients stops the process here instead
// of failing every rate-limited request later.

export async function register(): Promise<void> {
  // the edge runtime has no rate-limited routes and can't load node:net
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { assertTrustedProxyConfig } = await import("@/server/rate-limit");
  try {
    assertTrustedProxyConfig();
  } catch (e) {
    // a throw from register() only makes `next start` log "Failed to prepare
    // server" and answer 500 to every request while it keeps listening, so exit
    console.error(`refusing to start: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
