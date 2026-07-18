#!/usr/bin/env node
// Tiny dependency-free static file server for local verification.
// Usage: node tools/server.mjs [port] [root]
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.argv[2] || 8123);
const root = process.argv[3] || join(fileURLToPath(new URL("../", import.meta.url)));

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

const server = http.createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    if (path === "/") path = "/index.html";
    const full = normalize(join(root, path));
    if (!full.startsWith(normalize(root))) { res.writeHead(403).end("Forbidden"); return; }
    const info = await stat(full).catch(() => null);
    if (!info || !info.isFile()) { res.writeHead(404).end("Not found"); return; }
    const body = await readFile(full);
    res.writeHead(200, { "Content-Type": TYPES[extname(full)] || "application/octet-stream" });
    res.end(body);
  } catch (err) {
    res.writeHead(500).end(String(err));
  }
});

server.listen(port, () => {
  console.log(`static server on http://localhost:${port} (root: ${root})`);
});
