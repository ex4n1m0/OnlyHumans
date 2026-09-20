#!/usr/bin/env bash
# Verify the release-GK Windows build: room id, secret-absence in exe +
# installer, and a window scan proving the GK is embedded as raw bytes.
# NEVER prints secret values — only verdicts/counts/offsets.
set -u
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.."
export PATH="$HOME/.cargo/bin:$PATH"
set -a; source secrets/release-gk.env; set +a
export OH_GK_A OH_GK_B
OH_PUB="${OH_PUB:-$(cd .. && pwd)/ohpub}"
export OH_PUB

EXE=target/release/OnlyHumans.exe
SETUP=$(ls -t target/release/bundle/nsis/*-setup.exe 2>/dev/null | head -1)
EXPECT_ROOM=3a5075c38b232fc1d2d55d0bdbba84ea

echo "== room_id (release profile) =="
ROOM=$(cargo run -q --release -p onlyhumans_core --example room_id 2>/dev/null | head -1)
echo "derived room: $ROOM"
[ "$ROOM" = "$EXPECT_ROOM" ] || { echo "FAIL: room mismatch"; exit 1; }

echo "installer: $SETUP"

echo "== secret-absence + window scan =="
python - <<'PYEOF'
import hashlib, sys, glob, os, json, base64

def load():
    a = bytes.fromhex(os.environ["OH_GK_A"])
    b = bytes.fromhex(os.environ["OH_GK_B"])
    s = bytes(x ^ y for x, y in zip(a, b))
    channel = open("core/src/gk_channel.bin", "rb").read()
    gk = hashlib.sha256(b"OH1-gk-v2|" + channel + s).digest()
    return a.hex(), b.hex(), s.hex(), gk.hex(), gk

a_hex, b_hex, s_hex, gk_hex, gk = load()
needles = {"share A": a_hex, "share B": b_hex, "secret S": s_hex, "GK hex": gk_hex}
setups = glob.glob("target/release/bundle/nsis/*-setup.exe")
files = {"EXE": "target/release/OnlyHumans.exe"}
if setups:
    files["INSTALLER"] = setups[0]
rc = 0
for fname, path in files.items():
    data = open(path, "rb").read()
    for label, needle in needles.items():
        for variant in (needle, needle.upper()):
            if variant.encode() in data:
                print(f"LEAK: {label} hex string FOUND in {fname}")
                rc = 1
                break
        else:
            print(f"clean: {fname} — {label} hex string absent")

exe = open("target/release/OnlyHumans.exe", "rb").read()
target_room = "3a5075c38b232fc1d2d55d0bdbba84ea"
hits = []
for i in range(len(exe) - 32):
    w = exe[i:i+32]
    if hashlib.sha256(b"OH1-room-v1|" + w).hexdigest()[:32] == target_room:
        hits.append(i)
        if len(hits) >= 3:
            break
if hits:
    print(f"window scan: GK found as raw bytes at exe offset(s) {[hex(h) for h in hits]} (expected, accepted residual)")
else:
    print("window scan: GK NOT found as raw bytes — INVESTIGATE")
    rc = 1

print("== site gk.json consistency ==")
gk_b64url = base64.urlsafe_b64encode(gk).decode().rstrip("=")
site_path = os.path.join(os.environ.get("OH_PUB", os.path.join("..", "ohpub")), "gk.json")
if os.path.exists(site_path):
    site = json.load(open(site_path))
    if site.get("gk_b64") == gk_b64url:
        print(f"site gk.json GK matches this build's release GK (site version {site.get('version')})")
    else:
        print("MISMATCH: site gk.json holds a DIFFERENT GK than this build's shares")
        print("  -> the portal and this installer would live in split room universes")
        rc = 1
else:
    print(f"note: {site_path} absent — skipped site comparison (set OH_PUB)")
sys.exit(rc)
PYEOF
rc=$?
[ $rc -eq 0 ] && echo "ALL VERIFICATIONS PASSED" || echo "VERIFICATION FAILURES PRESENT"
exit $rc
