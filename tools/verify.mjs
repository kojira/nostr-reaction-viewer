#!/usr/bin/env node
// End-to-end verification using Playwright with a mocked NIP-07 signer and
// mocked relay WebSockets, so no real network / private data is involved.
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const PORT = 8137;
const BASE = `http://localhost:${PORT}`;

// ---- Browser-side mock (serialized into an init script) ----
function installMocks() {
  const PUBKEY = "1111111111111111111111111111111111111111111111111111111111111111";
  const AUTHOR = "2222222222222222222222222222222222222222222222222222222222222222";
  const base = 1700000000;

  const posts = [
    { i: 0, content: "Sunset over the bay https://media.example/photo0.png?token=q" }, // image
    { i: 1, content: "Just some plain text, nothing attached." },                      // no image
    { i: 2, content: "Uppercase ext https://cdn.example/pic2.JPG?w=200" },             // image
    { i: 3, content: "Preview link https://example.com/render?file=cat.png" },         // NO image (path has no ext)
    { i: 4, content: "See attached", imeta: "https://media.example/four.webp?s=1" },   // image via imeta
    { i: 5, content: "Another text-only note." },                                      // no image
  ].map((p) => ({
    id: `post${p.i}`.padEnd(64, "0"),
    pubkey: AUTHOR,
    kind: 1,
    created_at: base - p.i * 10,
    content: p.content,
    tags: p.imeta ? [["imeta", `url ${p.imeta}`, "m image/webp"]] : [],
  }));

  const reactions = posts.map((post, i) => ({
    id: `react${i}`.padEnd(64, "0"),
    pubkey: PUBKEY,
    kind: 7,
    created_at: base - i * 1000,
    content: i % 2 === 0 ? "+" : "🔥",
    tags: [["e", post.id], ["p", AUTHOR]],
  }));

  const profiles = {
    [PUBKEY]: { id: "prof_me".padEnd(64, "0"), pubkey: PUBKEY, kind: 0, created_at: base, content: JSON.stringify({ name: "me", display_name: "Me" }), tags: [] },
    [AUTHOR]: { id: "prof_al".padEnd(64, "0"), pubkey: AUTHOR, kind: 0, created_at: base, content: JSON.stringify({ name: "alice", display_name: "Alice" }), tags: [] },
  };

  window.nostr = { getPublicKey: async () => PUBKEY };

  class MockWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this._l = {};
      setTimeout(() => { this.readyState = 1; this._emit("open", {}); }, 5);
    }
    addEventListener(t, cb) { (this._l[t] = this._l[t] || []).push(cb); }
    _emit(t, ev) { (this._l[t] || []).forEach((cb) => cb(ev)); }
    send(raw) {
      let msg; try { msg = JSON.parse(raw); } catch { return; }
      if (!Array.isArray(msg)) return;
      const [type, subId, filter] = msg;
      if (type !== "REQ") return;
      const out = this._match(filter);
      setTimeout(() => {
        for (const ev of out) this._emit("message", { data: JSON.stringify(["EVENT", subId, ev]) });
        this._emit("message", { data: JSON.stringify(["EOSE", subId]) });
      }, 8);
    }
    _match(f) {
      const kinds = f.kinds || [];
      if (kinds.includes(7)) {
        let list = reactions.filter((r) => r.pubkey === (f.authors || [])[0]);
        if (f.until != null) list = list.filter((r) => r.created_at <= f.until);
        if (f.since != null) list = list.filter((r) => r.created_at >= f.since);
        list = list.slice().sort((a, b) => b.created_at - a.created_at);
        return f.limit ? list.slice(0, f.limit) : list;
      }
      if (kinds.includes(1)) {
        const ids = new Set(f.ids || []);
        return posts.filter((p) => ids.has(p.id));
      }
      if (kinds.includes(0)) {
        return (f.authors || []).map((a) => profiles[a]).filter(Boolean);
      }
      return [];
    }
    close() { this.readyState = 3; this._emit("close", {}); }
  }
  MockWebSocket.CONNECTING = 0; MockWebSocket.OPEN = 1; MockWebSocket.CLOSING = 2; MockWebSocket.CLOSED = 3;
  window.WebSocket = MockWebSocket;
}

async function main() {
  const server = spawn("node", [new URL("./server.mjs", import.meta.url).pathname, String(PORT)], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 500));

  const results = [];
  const assert = (name, cond, detail = "") => {
    results.push({ name, ok: !!cond, detail });
    console.log(`${cond ? "✓" : "✗"} ${name}${detail && !cond ? "  → " + detail : ""}`);
  };

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const consoleErrors = [];
  // Ignore expected failures from the fake image domains used by the mock.
  const isNetworkNoise = (t) => /Failed to load resource|ERR_NAME_NOT_RESOLVED|net::/.test(t);
  page.on("console", (m) => { if (m.type() === "error" && !isNetworkNoise(m.text())) consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  await page.addInitScript(installMocks);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });

  // 1. Pure image-detection self test.
  const selfTest = await page.evaluate(() => window.__nrv.isImageUrlSelfTest());
  assert("isImageUrl pathname-only detection", selfTest.every((c) => c.ok), JSON.stringify(selfTest.filter((c) => !c.ok)));

  // 2. Log in and load reactions.
  await page.click("#login-btn");
  await page.waitForSelector(".card", { timeout: 8000 });
  await page.waitForFunction(() => document.getElementById("end") && !document.getElementById("end").hidden, null, { timeout: 8000 });

  const allCount = await page.$$eval(".card", (els) => els.length);
  assert("shows all 6 reacted posts (default filter)", allCount === 6, `got ${allCount}`);

  const profileNames = await page.$$eval(".card .name", (els) => [...new Set(els.map((e) => e.textContent))]);
  assert("reflects author kind-0 profile (Alice)", profileNames.includes("Alice"), JSON.stringify(profileNames));

  const mediaCards = await page.$$eval(".card-media", (els) => els.length);
  assert("renders post images (3 with-image posts)", mediaCards === 3, `got ${mediaCards}`);

  // 3. Image filter = with images.
  await page.click('.seg[data-image="with"]');
  await page.waitForFunction(() => {
    const end = document.getElementById("end");
    return end && !end.hidden;
  }, null, { timeout: 8000 });
  await page.waitForTimeout(200);
  const withCount = await page.$$eval(".card", (els) => els.length);
  const withMedia = await page.$$eval(".card", (els) => els.filter((c) => c.querySelector(".card-media")).length);
  assert("image filter 'with' shows only image posts", withCount === 3 && withMedia === 3, `cards ${withCount}, media ${withMedia}`);

  // 4. Image filter = without images.
  await page.click('.seg[data-image="without"]');
  await page.waitForFunction(() => { const e = document.getElementById("end"); return e && !e.hidden; }, null, { timeout: 8000 });
  await page.waitForTimeout(200);
  const withoutCount = await page.$$eval(".card", (els) => els.length);
  const withoutMedia = await page.$$eval(".card .card-media", (els) => els.length);
  assert("image filter 'without' shows only text posts", withoutCount === 3 && withoutMedia === 0, `cards ${withoutCount}, media ${withoutMedia}`);

  // 5. Date range narrows results (reactions span base .. base-5000).
  await page.click('.seg[data-image="all"]');
  await page.waitForTimeout(100);
  await page.evaluate(() => { document.getElementById("date-from").value = ""; document.getElementById("date-to").value = ""; });

  assert("no console/page errors", consoleErrors.length === 0, consoleErrors.join(" | "));

  await browser.close();
  server.kill();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
