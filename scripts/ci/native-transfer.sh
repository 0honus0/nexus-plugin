#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
base="${NEXUS_TEST_IMAGE:-$(cat "$root/scripts/ci/host-image.txt")}"
image="nexus-remote-tools-native-test:$(date +%s)-$$"
trap 'docker image rm "$image" >/dev/null 2>&1 || true' EXIT
docker build --build-arg "HOST_IMAGE=$base" -f "$root/scripts/ci/native-transfer.Dockerfile" -t "$image" "$root/scripts/ci"
if [[ "${1:-remote-tools}" == workspace ]]; then
  cd "$root/plugins/workspace"
  NEXUS_TEST_NATIVE_IMAGE="$image" NEXUS_TEST_IMAGE="$image" node "$root/node_modules/vitest/vitest.mjs" run tests/native-archive-host.test.ts
  exit
fi
# No network or writable repository; the private sshd uses only the container loopback.
docker run --rm --network none --mount "type=bind,src=$root,dst=/project,readonly" \
  -w /project/plugins/remote-tools --entrypoint node -e NEXUS_TEST_NATIVE_REQUIRED=1 "$image" \
  /project/node_modules/vitest/vitest.mjs run --no-cache tests/transfers.test.ts tests/archives.test.ts
