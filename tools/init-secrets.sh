#!/usr/bin/env bash
# Bootstrap gitignored secrets for a fresh clone. The build embeds
# secrets/global.key via include_bytes! and fails without it.
#
# DEV KEY: writes a single 0x00 byte so tests/builds run without the real
# community key. Nodes built with the dev key can only admit each other.
# For a production build, place the real 32-byte key at secrets/global.key
# (never committed; distributed with release binaries only).
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f secrets/global.key ]; then
  bytes=$(wc -c < secrets/global.key)
  echo "secrets/global.key exists ($bytes bytes) - leaving it alone"
  [ "$bytes" -eq 32 ] && echo "-> production key in place"
  [ "$bytes" -eq 1 ] && echo "-> dev placeholder key"
  exit 0
fi

mkdir -p secrets
printf '\x00' > secrets/global.key
echo "wrote DEV global key (single 0x00 byte) to secrets/global.key"
echo "replace with the real 32-byte key before cutting release builds"
