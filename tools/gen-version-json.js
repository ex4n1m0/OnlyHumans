// Regenerate ohpub/version.json from the files actually present in the
// download dir. Run by tools/deploy-release.sh:
//   node tools/gen-version-json.js <ohpub-root> <new-version> <today>
//
// Platform-aware: blocks whose artifacts were not rebuilt in this run keep
// their previous entries (e.g. a Windows-only deploy leaves the linux
// block pointing at the still-shipped 1.0.0 AppImage). Field formats match
// what index.html renders: windows size "5.4 MB", appimageSize "87 MB",
// debSize "10.7" (site appends MB).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const [ohpub, version, date] = process.argv.slice(2);
const dl = path.join(ohpub, "download");
const file = p => "/download/" + path.basename(p);
const exists = p => fs.existsSync(p) ? p : null;
const mb = p => (fs.statSync(p).size / 1048576).toFixed(1);

const outPath = path.join(ohpub, "version.json");
const prev = fs.existsSync(outPath)
  ? JSON.parse(fs.readFileSync(outPath, "utf8"))
  : {};

const out = { ...prev, version: prev.version, date: prev.date };

const win = exists(path.join(dl, `OnlyHumans-Setup-${version}.exe`));
if (win) {
  out.version = version;
  out.date = date;
  out.size = mb(win) + " MB";
  out.file = file(win);
}

const appimage = exists(path.join(dl, `OnlyHumans_${version}_amd64.AppImage`));
const deb = exists(path.join(dl, `OnlyHumans_${version}_amd64.deb`));
if (appimage || deb) {
  out.linux = {
    ...(prev.linux || {}),
    version,
    date,
    ...(appimage
      ? { appimage: file(appimage), appimageSize: mb(appimage) + " MB" }
      : {}),
    ...(deb ? { deb: file(deb), debSize: mb(deb) } : {}),
  };
}

if (!out.version) {
  console.error("gen-version-json: no artifacts for " + version + " and no previous state");
  process.exit(1);
}

// Stamp the GK fingerprint (first 8 hex of the deployed GK, from the
// gk.json deploy-release.sh just wrote). A split-universe ship — site
// gk.json vs installer GK — becomes diffable post-hoc: sha256 of gk.json's
// gk_b64 bytes must start with this prefix.
const gkPath = path.join(ohpub, "gk.json");
if (fs.existsSync(gkPath)) {
  const gkB64 = JSON.parse(fs.readFileSync(gkPath, "utf8")).gk_b64 ?? "";
  out.gk = crypto.createHash("sha256").update(Buffer.from(gkB64, "base64url")).digest("hex").slice(0, 8);
} else {
  delete out.gk;
}

fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
console.log(fs.readFileSync(outPath, "utf8"));
