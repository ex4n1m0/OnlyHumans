#!/usr/bin/env bash
# Secret bootstrap for a fresh clone — a no-op by design.
#
# There is NO dev placeholder key and nothing to hand-place anymore:
#   * core/build.rs auto-generates secrets/local-gk.key (32 random bytes)
#     on first build, so every clone gets its own isolated room universe —
#     builds from different clones can't see each other's rooms and can't
#     reach production rooms (room ids are unguessable without the
#     matching GK).
#   * Release builds read OH_GK_A/OH_GK_B from secrets/release-gk.env,
#     minted per release by tools/deploy-release.sh on the release
#     machine. That file never leaves that machine and is gitignored.
#
# This script only guards against a stale secrets/global.key left over
# from the pre-1.1 mechanism it used to write.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f secrets/global.key ]; then
  echo "secrets/global.key exists but is DEAD CONFIG (pre-1.1 mechanism —" >&2
  echo "core/build.rs reads local-gk.key / release-gk.env only). Delete it" >&2
  echo "so nobody mistakes it for a production key." >&2
  exit 1
fi

echo "nothing to bootstrap: build.rs mints secrets/local-gk.key on first"
echo "build (per-clone universe). Release keys are minted by"
echo "tools/deploy-release.sh on the release machine."
