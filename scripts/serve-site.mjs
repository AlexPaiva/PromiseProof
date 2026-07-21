// Minimal static file server for the assembled site (dist/site). Used only by
// the Judge Mode Playwright harness; the real site is served by Cloudflare.
//
//   node scripts/serve-site.mjs [rootDir] [port]

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const ROOT = resolve(process.argv[2] ?? "dist/site");
const PORT = Number(process.argv[3] ?? 4188);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".map": "application/json",
};

const server = createServer(async (req, res) => {
  try {
    let pathname = decodeURIComponent((req.url ?? "/").split("?")[0]);
    if (pathname.endsWith("/")) pathname += "index.html";
    const full = normalize(join(ROOT, pathname));
    if (full !== ROOT && !full.startsWith(ROOT + sep)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    const body = await readFile(full);
    res.writeHead(200, {
      "content-type": TYPES[extname(full)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}`);
});
