// After esbuild emits join-assets/portal-[hash].js, point join.html's
// preload + script tags at it and drop every other bundle (including the
// legacy unhashed portal.js). The hash IS the cache key: join.html is
// always revalidated, the bundle it names can be cached immutable for a
// year, and no deploy can ever serve a stale protocol build.
import fs from "node:fs";

const DIR = "join-assets";
// Newest by modification time — hash names do not sort by age, and a
// stale bundle from an earlier build can sort after the fresh one.
const built = fs.readdirSync(DIR)
  .filter((f) => /^portal-[0-9A-Za-z_-]+\.js$/.test(f))
  .map((f) => ({ f, m: fs.statSync(`${DIR}/${f}`).mtimeMs }))
  .sort((a, b) => b.m - a.m);
const latest = built[0]?.f;
if (!latest) throw new Error("link-bundle: no hashed portal bundle in join-assets/");

let html = fs.readFileSync("join.html", "utf8");
html = html
  .replace(/portal-[0-9A-Za-z_-]+\.js/g, latest) // refresh a previous hash
  .replace(/join-assets\/portal\.js/g, `join-assets/${latest}`); // or the legacy name
if (!html.includes(latest)) throw new Error("link-bundle: join.html rewrite failed");
fs.writeFileSync("join.html", html);

for (const f of fs.readdirSync(DIR)) {
  if (f !== latest) fs.unlinkSync(`${DIR}/${f}`);
}
console.log(`link-bundle: join.html -> join-assets/${latest}`);
