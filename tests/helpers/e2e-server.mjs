// the server playwright tests against: the production build of the app behind a
// minimal reverse proxy, the only setup the app supports (TRUSTED_PROXY_HOPS=1).
//
// like the caddy proxy compose ships, the proxy here overwrites any
// X-Forwarded-For the client sent with the connecting address, so the app sees
// exactly one trusted hop. the app listens on E2E_PORT + 1 on loopback; only the
// proxy is on E2E_PORT.
//
// a MEDIATOR_SECRET is generated for the run unless one is passed in. it is only
// the hmac master key of the exchange mediator and never holds funds, so a fresh
// random seed per run is all an exchange close on testnet needs.
//
// E2E_SKIP_BUILD=1 starts the existing .next build instead of building first.

import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";

import { Keypair } from "@stellar/stellar-sdk";

const port = Number.parseInt(process.env.E2E_PORT ?? "3250", 10);
if (!Number.isInteger(port) || port <= 0 || port >= 65535) {
  throw new Error(`E2E_PORT must be a port number below 65535, got "${process.env.E2E_PORT}"`);
}
const appPort = port + 1;

const appEnv = {
  ...process.env,
  NODE_ENV: "production",
  TRUSTED_PROXY_HOPS: "1",
  MEDIATOR_SECRET:
    process.env.MEDIATOR_SECRET && process.env.MEDIATOR_SECRET.length > 0
      ? process.env.MEDIATOR_SECRET
      : Keypair.random().secret(),
};

const children = new Set();

function run(command, args) {
  const child = spawn(command, args, { env: appEnv, stdio: "inherit" });
  children.add(child);
  child.on("exit", () => children.delete(child));
  return child;
}

function stopAll() {
  for (const child of children) child.kill("SIGTERM");
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopAll();
    process.exit(0);
  });
}

if (process.env.E2E_SKIP_BUILD !== "1") {
  const build = run("pnpm", ["exec", "next", "build"]);
  const code = await new Promise((resolve) => build.on("exit", resolve));
  if (code !== 0) throw new Error(`next build exited with ${code}`);
}

const app = run("pnpm", ["exec", "next", "start", "--port", String(appPort), "-H", "127.0.0.1"]);
app.on("exit", (code) => {
  // the proxy is useless without the app; end the run so playwright sees it
  console.error(`next start exited with ${code}`);
  stopAll();
  process.exit(code ?? 1);
});

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
]);

const proxy = createServer((req, res) => {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    headers[name] = value;
  }
  // whatever the client claimed is dropped, as caddy does
  headers["x-forwarded-for"] = req.socket.remoteAddress ?? "";
  headers["x-forwarded-host"] = req.headers.host ?? "";
  headers["x-forwarded-proto"] = "http";

  const upstream = httpRequest(
    { host: "127.0.0.1", port: appPort, method: req.method, path: req.url, headers },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstream.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end(`proxy: ${err.message}`);
  });
  req.pipe(upstream);
});

proxy.listen(port, "127.0.0.1", () => {
  console.log(`e2e proxy on http://127.0.0.1:${port} -> app on 127.0.0.1:${appPort}`);
});
