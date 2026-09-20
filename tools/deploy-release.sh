#!/usr/bin/env bash
# Ship a release. Every deployment bumps the patch version, rebuilds with
# the release-channel global key, prunes older artifacts from the download
# dir (one file per platform — prior versions are leftovers, they get
# deleted) and regenerates ohpub/version.json to match what is shipped.
#
#   . tools/deploy-release.sh                  # bump + build + publish
#   OH_NO_BUMP=1 . tools/deploy-release.sh     # re-ship the same version
#   OH_PUB=/path/to/ohpub . tools/...          # non-default site root
#
# Platform-aware: run it on Windows (Git Bash) to ship the NSIS installer,
# from WSL to ship deb/AppImage. Blocks for platforms not built in this
# run keep their existing version.json entries.
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.."
OH_PUB="${OH_PUB:-$(cd .. && pwd)/ohpub}"

if [ ! -d "$OH_PUB/download" ]; then
  echo "download dir '$OH_PUB/download' not found — set OH_PUB." >&2
  exit 1
fi

# --- 1. bump the patch version in tauri.conf, both crates, npm package ---
cur=$(node -p 'require("./src-tauri/tauri.conf.json").version')
if [ "${OH_NO_BUMP:-0}" = "1" ]; then
  new="$cur"
else
  new=$(node -p 'process.argv[1].replace(/(\d+)$/, m => String(+m + 1))' "$cur")
fi
echo "deploy: version $cur -> $new"
node -e '
  const fs = require("fs");
  const f = "src-tauri/tauri.conf.json";
  const c = JSON.parse(fs.readFileSync(f, "utf8"));
  c.version = process.argv[1];
  fs.writeFileSync(f, JSON.stringify(c, null, 2) + "\n");
' "$new"
sed -i "s/^version = \"$cur\"/version = \"$new\"/" src-tauri/Cargo.toml core/Cargo.toml
npm version "$new" --no-git-tag-version --allow-same-version >/dev/null

# --- 1b. mint a FRESH channel key per release ------------------------------
# Policy: every version is its own room — a new base key with every bump
# means old and new builds never mix (the site tells users to update).
# OH_KEEP_KEY=1 reuses the existing key (re-shipping / patching a release).
if [ "${OH_KEEP_KEY:-0}" != "1" ]; then
  if [ "$new" = "$cur" ] && [ "${OH_FORCE_NEW_KEY:-0}" != "1" ]; then
    echo "deploy: refusing to mint a fresh channel key for the SAME version ($new)." >&2
    echo "  Everyone already running $new would land in a split, dead universe." >&2
    echo "  Re-ship $new with its existing key via OH_KEEP_KEY=1, or set" >&2
    echo "  OH_FORCE_NEW_KEY=1 if you truly mean to cut a new universe unbumped." >&2
    exit 1
  fi
  mkdir -p secrets
  A=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  B=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  printf '# Release-channel global key - minted %s (fresh per release: every version is its own room).\n# Two XOR shares (secret = A xor B); never commit this file.\nexport OH_GK_A=%s\nexport OH_GK_B=%s\n' \
    "$(date +%F)" "$A" "$B" > secrets/release-gk.env
  echo "deploy: minted fresh channel key for $new"
else
  if [ ! -f secrets/release-gk.env ]; then
    echo "deploy: OH_KEEP_KEY=1 but secrets/release-gk.env does not exist — the build" >&2
    echo "  would fall back to a per-clone local key and the site would publish a GK" >&2
    echo "  that matches no shipped installer. Mint first (normal bump) instead." >&2
    exit 1
  fi
fi

# --- 2. build with the release-channel key (release-build.sh ritual) -----
. ./tools/release-build.sh
BUNDLE_DIR="target/release/bundle"
DL="$OH_PUB/download"

# --- 2b. publish the web-portal key ----------------------------------------
# The browser portal (/join) derives its rooms from the FINISHED global key
# GK = SHA256("OH1-gk-v2" | channel | secret) — the same 32 bytes build.rs
# embeds in the app. NEVER write the shares or the raw secret to the site:
# the finished GK is the portal's contract (it reaches every browser tab by
# design), while the secret/channel must stay off the public site. Getting
# this wrong splits the app and portal room universes (they never meet).
if [ -n "${OH_GLOBAL_KEY:-}" ]; then
  echo "deploy: OH_GLOBAL_KEY is set — build.rs would prefer it over the release shares and the site would publish a different GK. Unset it and use OH_GK_A/OH_GK_B." >&2
  exit 1
fi
GK_B64=$(node -e '
  const fs = require("fs");
  const a = Buffer.from(process.env.OH_GK_A || "", "hex");
  const b = Buffer.from(process.env.OH_GK_B || "", "hex");
  if (a.length !== 32 || b.length !== 32) throw new Error("release key shares missing");
  const secret = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) secret[i] = a[i] ^ b[i];
  const channel = fs.readFileSync("core/src/gk_channel.bin");
  if (channel.length !== 16) throw new Error("gk_channel.bin must be 16 bytes");
  process.stdout.write(require("crypto").createHash("sha256")
    .update(Buffer.concat([Buffer.from("OH1-gk-v2|"), channel, secret]))
    .digest("base64url"));
')
node -e '
  const fs = require("fs");
  fs.writeFileSync(process.argv[1] + "/gk.json",
    JSON.stringify({ version: process.argv[2], gk_b64: process.argv[3] }, null, 2) + "\n");
' "$OH_PUB" "$new" "$GK_B64"
echo "deploy: wrote $OH_PUB/gk.json (finished GK for the web portal)"

# The DEPLOYED portal reads the GK from the /api/gk function backed by
# Vercel env vars — the git tree carries no key file, so a git-push
# deploy must still serve the right universe. Env changes take effect on
# the next `vercel --prod` (run it after this script).
if command -v vercel >/dev/null 2>&1 && [ -d "$OH_PUB/.vercel" ]; then
  ( cd "$OH_PUB" \
    && { vercel env rm OH_GK_B64 production -y >/dev/null 2>&1 || true; } \
    && { vercel env rm OH_GK_VERSION production -y >/dev/null 2>&1 || true; } \
    && printf '%s' "$GK_B64" | vercel env add OH_GK_B64 production \
    && printf '%s' "$new" | vercel env add OH_GK_VERSION production ) \
  || { echo "deploy: failed to set the Vercel OH_GK_* env vars — /api/gk would serve a stale universe. Fix and re-run before deploying." >&2; exit 1; }
  echo "deploy: set Vercel env OH_GK_B64/OH_GK_VERSION (live on the next deploy)"
else
  echo "deploy: NOTE — vercel CLI or $OH_PUB/.vercel missing; /api/gk env vars NOT updated. Set OH_GK_B64/OH_GK_VERSION manually before deploying." >&2
fi

# --- 3. ship fresh artifacts ----------------------------------------------
# tauri emits OnlyHumans_<ver>_x64-setup.exe; the site has always linked
# the flatter OnlyHumans-Setup-<ver>.exe — keep that public name. Match the
# exact version: older bundles linger in the bundle dir and a glob would
# feed cp two sources.
cp -f "$BUNDLE_DIR"/nsis/OnlyHumans_"$new"_x64-setup.exe "$DL/OnlyHumans-Setup-$new.exe" ||
  echo "no NSIS bundle in this run (linux host?) — windows entry unchanged"
cp -f "$BUNDLE_DIR"/deb/*.deb "$DL"/ 2>/dev/null || true
cp -f "$BUNDLE_DIR"/appimage/*.AppImage "$DL"/ 2>/dev/null || true

# --- 4. prune older artifacts: keep the newest of each platform family ----
# Runs AFTER the copy so the file this deploy just superseded also goes.
prune() {
  find "$DL" -maxdepth 1 -name "$1" -printf '%f\n' | sort -V | head -n -1 |
    while read -r f; do rm -f "$DL/$f"; done
}
prune 'OnlyHumans-Setup-*.exe'
prune 'OnlyHumans_*_amd64.AppImage'
prune 'OnlyHumans_*_amd64.deb'

node tools/gen-version-json.js "$OH_PUB" "$new" "$(date +%F)"
echo "deploy: shipped to $DL"
