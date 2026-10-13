#!/usr/bin/env bash
# deploy a signed release to a host that runs the docker compose stack.
#
#   scripts/deploy-release.sh v1.0.0 azureuser@52.249.220.55 [ssh options...]
#
# 1. downloads the release artifact from github,
# 2. verifies its slsa provenance: built by .github/workflows/release.yml in this
#    repository, from the commit the tag points to,
# 3. copies the deployment files at that commit and the artifact to the host,
# 4. rebuilds the app image from the artifact (release/Dockerfile checks its
#    sha256) and restarts the stack.
#
# needs gh (any logged-in account can verify a public repository's
# attestations), git with the tag fetched, ssh and tar. the host keeps its own
# .env with the runtime secrets; nothing secret leaves this machine.
set -euo pipefail

REPO="${REPO:-bytemaster333/account-demolisher}"
REMOTE_DIR="${REMOTE_DIR:-/opt/account-demolisher}"

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <tag> <ssh-target> [ssh options...]" >&2
  exit 2
fi
TAG="$1"
TARGET="$2"
shift 2
SSH_OPTS=("$@")

# the tag ends up in file names and a remote command, so it is checked once here
if [[ ! "$TAG" =~ ^v[0-9A-Za-z._-]+$ ]]; then
  echo "refusing tag '$TAG': expected v followed by letters, digits, '.', '_' or '-'" >&2
  exit 1
fi
NAME="account-demolisher-${TAG}.tar.gz"

git fetch --quiet origin "refs/tags/${TAG}:refs/tags/${TAG}"
COMMIT="$(git rev-list -n 1 "$TAG")"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

gh release download "$TAG" --repo "$REPO" --pattern "$NAME" --dir "$WORK"
gh attestation verify "$WORK/$NAME" \
  --repo "$REPO" \
  --signer-workflow "${REPO}/.github/workflows/release.yml" \
  --source-digest "$COMMIT" \
  --deny-self-hosted-runners

if command -v sha256sum >/dev/null 2>&1; then
  SHA="$(sha256sum "$WORK/$NAME" | cut -d' ' -f1)"
else
  SHA="$(shasum -a 256 "$WORK/$NAME" | cut -d' ' -f1)"
fi
echo "verified $NAME ($SHA), built from $COMMIT"

# the deployment files (compose, caddy, release/Dockerfile, the docs app) at the
# commit the artifact was built from, then the artifact itself
git archive "$COMMIT" | ssh "${SSH_OPTS[@]}" "$TARGET" "tar -x -C '$REMOTE_DIR'"
ssh "${SSH_OPTS[@]}" "$TARGET" "find '$REMOTE_DIR/release' -maxdepth 1 -name 'account-demolisher-*.tar.gz' -delete"
ssh "${SSH_OPTS[@]}" "$TARGET" "cat > '$REMOTE_DIR/release/$NAME'" <"$WORK/$NAME"

ssh "${SSH_OPTS[@]}" "$TARGET" "cd '$REMOTE_DIR' && \
  export RELEASE_TAG='$TAG' RELEASE_ARTIFACT='$NAME' RELEASE_SHA256='$SHA' && \
  docker compose -f docker-compose.yml -f docker-compose.hosted.yml -f docker-compose.release.yml up --build -d && \
  docker compose -f docker-compose.yml -f docker-compose.hosted.yml -f docker-compose.release.yml ps"
