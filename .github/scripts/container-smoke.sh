#!/usr/bin/env bash
# smoke test for the production image: it must start as its non-root user with
# no network at all (no package manager download at start), serve the app, carry
# the build-time site url, and read and write the metrics store.
#
# usage: container-smoke.sh <image> <expected NEXT_PUBLIC_SITE_URL>
set -euo pipefail

image="$1"
site_url="$2"
name="ad-smoke-$$"
token="smoke-metrics-token-0123456789abcdef"

cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run -d --name "$name" --network none -e METRICS_ADMIN_TOKEN="$token" "$image" >/dev/null

# requests run inside the container: with --network none there is no published port
in_container() {
  docker exec -e TOKEN="$token" "$name" node -e "$1"
}

status=""
for _ in $(seq 1 60); do
  status="$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$name")"
  case "$status" in
    "running healthy") break ;;
    exited*)
      docker logs "$name"
      echo "container exited during start" >&2
      exit 1
      ;;
  esac
  sleep 2
done
if [ "$status" != "running healthy" ]; then
  docker logs "$name"
  echo "container never became healthy (last: $status)" >&2
  exit 1
fi

user="$(docker exec "$name" id -un)"
[ "$user" = "appuser" ] || { echo "runs as $user, expected appuser" >&2; exit 1; }

in_container "
const base = 'http://127.0.0.1:3000';
const fail = (m) => { console.error(m); process.exit(1); };
(async () => {
  const home = await fetch(base + '/');
  if (home.status !== 200) fail('GET / returned ' + home.status);

  const sitemap = await (await fetch(base + '/sitemap.xml')).text();
  if (!sitemap.includes('<loc>${site_url}/demolish</loc>')) fail('sitemap does not carry ${site_url}');

  // the app only runs behind a proxy and rate-limits by the address it appends
  // to x-forwarded-for. the container is reached directly here, so the request
  // carries that header itself, as caddy would.
  const visit = await fetch(base + '/api/metrics', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: base,
      'x-forwarded-for': '203.0.113.7',
    },
    body: JSON.stringify({ type: 'visit', page: 'landing', network: 'testnet' }),
  });
  if (visit.status !== 204) fail('POST /api/metrics returned ' + visit.status);

  const read = await fetch(base + '/api/metrics', {
    headers: { authorization: 'Bearer ' + process.env.TOKEN },
  });
  if (read.status !== 200) fail('GET /api/metrics returned ' + read.status);
  const snapshot = await read.json();
  if (snapshot.visits.total !== 1) fail('metrics store did not record the visit');
  console.log('smoke ok');
})().catch((e) => fail(String(e)));
"
