#!/usr/bin/env bash
# Release build ritual. The channel secret never touches git: it lives in
# the gitignored secrets/release-gk.env as two XOR shares (OH_GK_A/B).
#
#   . tools/release-build.sh          # builds installer + app with the
#                                      # release-channel global key
#
# Fresh clones: no ritual needed. build.rs gives every clone its own
# random global key (secrets/local-gk.key), so clones build fine but can
# never join the release-channel room. Compare any build's room with:
#   cargo run -p onlyhumans_core --example room_id
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f secrets/release-gk.env ]; then
  echo "secrets/release-gk.env missing — this machine is not a release machine." >&2
  echo "Builds will use the local per-clone key (own room, not the channel room)." >&2
fi
# shellcheck disable=SC1091
[ -f secrets/release-gk.env ] && . secrets/release-gk.env
export PATH="$HOME/.cargo/bin:$PATH"

echo "release room id: $(cargo run -q -p onlyhumans_core --example room_id)"
npx tauri build "$@"
