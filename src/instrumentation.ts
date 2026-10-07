// next calls register() once when a server instance starts, before it serves
// any request, and compiles this file for both runtimes. the startup checks use
// node-only apis, so they are imported under the nodejs branch, the pattern
// next documents for runtime-specific instrumentation.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { refuseUnsafeStartup } = await import("@/server/startup-check");
    refuseUnsafeStartup();
  }
}
