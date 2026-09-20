// Local stand-in for the live site during interop verification: serves
// join.html + assets + the repo's (FIXED) gk.json unchanged, and proxies
// /api/* to the production hub so the portal client runs unmodified
// against real hub storage. Bind 127.0.0.1 only.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = HERE.endsWith(path.sep + "portal") ? HERE.slice(0, -(1 + "portal".length)) : HERE;
const UP = "https://onlyhumans.deepflux.space";
const PORT = 8788;

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".png": "image/png", ".json": "application/json" };

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
    let p = url.pathname === "/" ? "/join.html" : decodeURIComponent(url.pathname);
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
  console.log("gk.json gk_b64:", JSON.parse(fs.readFileSync(path.join(ROOT, "gk.json"), "utf8")).gk_b64.slice(0, 8) + "…");
});
