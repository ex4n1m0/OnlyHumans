// Local stand-in for the live site during interop verification: serves
// join.html + assets + a gk.json, and proxies /api/* to the production
// hub so the portal client runs unmodified against real hub storage.
// Bind 127.0.0.1 only.
//
// Builders who compiled their own app (per-clone random GK) can point the
// portal at their own universe instead of production:
//   OH_GK_JSON=/path/to/their/gk.json OH_UP=https://their-hub \
//     node portal/local-portal-server.mjs
// With the default gk.json this joins the PRODUCTION universe — fine for
// interop testing, wrong for isolated building.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = HERE.endsWith(path.sep + "portal") ? HERE.slice(0, -(1 + "portal".length)) : HERE;
const UP = process.env.OH_UP ?? "https://onlyhumans.deepflux.space";
const GK_JSON = process.env.OH_GK_JSON ?? path.join(ROOT, "gk.json");
const PORT = Number(process.env.OH_PORT ?? 8788);

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".png": "image/png", ".webp": "image/webp", ".json": "application/json" };

const body = (req) => new Promise((resolve) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => resolve(Buffer.concat(chunks)));
});

http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  try {
    if (url.pathname.startsWith("/api/")) {
      const up = await fetch(UP + url.pathname + url.search, {
        method: req.method,
        headers: { "content-type": req.headers["content-type"] ?? "application/json" },
        body: req.method === "GET" || req.method === "HEAD" ? undefined : await body(req),
      });
      res.writeHead(up.status, {
        "content-type": up.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      });
      res.end(Buffer.from(await up.arrayBuffer()));
      return;
    }
    if (url.pathname === "/gk.json" || url.pathname === "/api/gk") {
      // Both GK paths come from GK_JSON (the /api/gk function's local
      // stand-in), not ROOT: the static branch below would otherwise
      // shadow an OH_GK_JSON override with the checked-in file.
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache" });
      res.end(fs.readFileSync(GK_JSON));
      return;
    }
    let p = url.pathname === "/" || url.pathname === "/join" ? "/join.html" : decodeURIComponent(url.pathname);
    p = p.split("/").filter((seg) => seg !== ".." && seg !== ".").join("/");
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
      "cache-control": "no-cache",
    });
    res.end(fs.readFileSync(file));
  } catch (e) {
    res.writeHead(502).end(String(e));
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`portal local: http://127.0.0.1:${PORT}/ (api -> ${UP})`);
  console.log("gk.json gk_b64:", JSON.parse(fs.readFileSync(GK_JSON, "utf8")).gk_b64.slice(0, 8) + "…", `(${GK_JSON})`);
});
