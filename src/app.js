import { RelayPool } from "./relay.js";
import {
  extractImageUrls, hasImages, parseProfile, renderContent, formatDate,
  reactedEventId, reactedAuthor, reactionSymbol, shortId, fallbackName, avatarFallback,
} from "./nostr.js";

const DEFAULT_RELAYS = ["wss://yabu.me", "wss://r.kojira.io"];
const REACTION_BATCH = 40;   // kind-7 events fetched per page
const MAX_PAGES_PER_SCROLL = 6; // auto-page while a filter yields nothing visible

const app = {
  pubkey: null,
  pool: new RelayPool(DEFAULT_RELAYS),
  activeRelays: [...DEFAULT_RELAYS],
  useUserRelays: false,
  userRelays: [],

  filters: { since: null, until: null, image: "all" },

  cursor: null,          // reaction created_at pagination cursor (until)
  loading: false,
  exhausted: false,

  seenReactions: new Set(),
  shownPosts: new Set(),
  profileCache: new Map(), // pubkey -> profile|null
  postCache: new Map(),    // id -> event|null (null = confirmed missing)
};

// ---------- DOM refs ----------
const $ = (id) => document.getElementById(id);
const els = {
  loginBtn: $("login-btn"),
  logoutBtn: $("logout-btn"),
  userChip: $("user-chip"),
  userAvatar: $("user-avatar"),
  userName: $("user-name"),
  useUserRelays: $("use-user-relays"),
  relayList: $("relay-list"),
  dateFrom: $("date-from"),
  dateTo: $("date-to"),
  applyBtn: $("apply-btn"),
  status: $("status"),
  feed: $("feed"),
  sentinel: $("sentinel"),
  loader: $("loader"),
  end: $("end"),
  lightbox: $("lightbox"),
  lightboxImg: $("lightbox-img"),
};

// ---------- status helpers ----------
function setStatus(msg, isError = false) {
  els.status.textContent = msg || "";
  els.status.classList.toggle("error", !!isError);
}

function renderRelayList() {
  const statuses = app.pool.status();
  els.relayList.innerHTML = "";
  for (const s of statuses) {
    const li = document.createElement("li");
    const dot = document.createElement("span");
    dot.className = "relay-dot" + (s.connected ? " on" : "");
    li.appendChild(dot);
    li.appendChild(document.createTextNode(s.url.replace(/^wss?:\/\//, "")));
    li.title = s.url;
    els.relayList.appendChild(li);
  }
}

// ---------- login ----------
async function login() {
  if (!window.nostr || typeof window.nostr.getPublicKey !== "function") {
    setStatus("No NIP-07 extension found. Install one (e.g. Alby, nos2x) and reload.", true);
    return;
  }
  els.loginBtn.disabled = true;
  setStatus("Requesting your public key…");
  try {
    app.pubkey = await window.nostr.getPublicKey();
  } catch (err) {
    setStatus("Login was rejected or failed.", true);
    els.loginBtn.disabled = false;
    return;
  }

  els.loginBtn.hidden = true;
  els.logoutBtn.hidden = false;
  els.userChip.hidden = false;
  els.userName.textContent = fallbackName(app.pubkey);
  els.userAvatar.src = avatarFallback(app.pubkey);

  await applyRelayMode();
  await loadOwnProfile();
  els.loginBtn.disabled = false;
  await resetAndLoad();
}

function logout() {
  app.pubkey = null;
  els.loginBtn.hidden = false;
  els.logoutBtn.hidden = true;
  els.userChip.hidden = true;
  els.feed.innerHTML = "";
  els.end.hidden = true;
  setStatus("");
}

async function loadOwnProfile() {
  const prof = await fetchProfiles([app.pubkey]);
  const p = prof.get(app.pubkey);
  if (p) {
    els.userName.textContent = p.name || p.handle || fallbackName(app.pubkey);
    if (p.picture) els.userAvatar.src = p.picture;
  }
}

// ---------- relays ----------
async function applyRelayMode() {
  if (app.useUserRelays && app.pubkey) {
    setStatus("Discovering your relays…");
    const relays = await discoverUserRelays();
    if (relays.length) {
      app.activeRelays = relays;
      setStatus(`Using ${relays.length} of your relays.`);
    } else {
      app.activeRelays = [...DEFAULT_RELAYS];
      setStatus("No personal relays found — using defaults.");
    }
  } else {
    app.activeRelays = [...DEFAULT_RELAYS];
  }
  app.pool.setRelays(app.activeRelays);
  renderRelayList();
}

async function discoverUserRelays() {
  const set = new Set();
  // NIP-07 getRelays()
  try {
    if (window.nostr && typeof window.nostr.getRelays === "function") {
      const r = await window.nostr.getRelays();
      for (const [url, policy] of Object.entries(r || {})) {
        if (!policy || policy.read !== false) set.add(url);
      }
    }
  } catch (_) { /* ignore */ }

  // NIP-65 relay list (kind 10002) — queried from default relays.
  try {
    const probe = new RelayPool(DEFAULT_RELAYS);
    const events = await probe.query({ kinds: [10002], authors: [app.pubkey], limit: 1 }, { timeout: 5000 });
    probe.destroy();
    if (events[0]) {
      for (const tag of events[0].tags || []) {
        if (tag[0] === "r" && tag[1]) {
          const marker = tag[2];
          if (!marker || marker === "read") set.add(tag[1]);
        }
      }
    }
  } catch (_) { /* ignore */ }

  return [...set].filter((u) => /^wss?:\/\//.test(u)).slice(0, 12);
}

// ---------- data fetching ----------
async function fetchProfiles(pubkeys) {
  const missing = [...new Set(pubkeys)].filter((pk) => pk && !app.profileCache.has(pk));
  if (missing.length) {
    const events = await app.pool.query({ kinds: [0], authors: missing, limit: missing.length * 2 });
    const latest = new Map();
    for (const ev of events) {
      const cur = latest.get(ev.pubkey);
      if (!cur || ev.created_at > cur.created_at) latest.set(ev.pubkey, ev);
    }
    for (const pk of missing) {
      app.profileCache.set(pk, latest.has(pk) ? parseProfile(latest.get(pk)) : null);
    }
  }
  const out = new Map();
  for (const pk of pubkeys) out.set(pk, app.profileCache.get(pk) || null);
  return out;
}

async function fetchPosts(ids) {
  const missing = [...new Set(ids)].filter((id) => id && !app.postCache.has(id));
  if (missing.length) {
    // Chunk to keep filters reasonable for relays.
    for (let i = 0; i < missing.length; i += 100) {
      const chunk = missing.slice(i, i + 100);
      const events = await app.pool.query({ ids: chunk, kinds: [1], limit: chunk.length });
      for (const ev of events) app.postCache.set(ev.id, ev);
      for (const id of chunk) if (!app.postCache.has(id)) app.postCache.set(id, null);
    }
  }
  const out = new Map();
  for (const id of ids) out.set(id, app.postCache.get(id) || null);
  return out;
}

// ---------- pagination / feed ----------
function passesImageFilter(post) {
  if (app.filters.image === "all") return true;
  const has = hasImages(post);
  return app.filters.image === "with" ? has : !has;
}

async function loadMore() {
  if (app.loading || app.exhausted || !app.pubkey) return;
  app.loading = true;
  els.loader.hidden = false;

  let addedThisScroll = 0;
  try {
    for (let page = 0; page < MAX_PAGES_PER_SCROLL; page++) {
      const filter = { kinds: [7], authors: [app.pubkey], limit: REACTION_BATCH };
      if (app.filters.since != null) filter.since = app.filters.since;
      const upper = [app.cursor, app.filters.until].filter((v) => v != null);
      if (upper.length) filter.until = Math.min(...upper);

      const reactions = await app.pool.query(filter);
      if (reactions.length === 0) { app.exhausted = true; break; }

      // Advance cursor past the oldest reaction we saw.
      const oldest = reactions[reactions.length - 1].created_at;
      const nextCursor = oldest - 1;
      if (app.cursor != null && nextCursor >= app.cursor) { app.exhausted = true; break; }
      app.cursor = nextCursor;

      // Keep new, in-range reactions in chronological (desc) order.
      const fresh = [];
      for (const r of reactions) {
        if (app.seenReactions.has(r.id)) continue;
        app.seenReactions.add(r.id);
        if (app.filters.since != null && r.created_at < app.filters.since) continue;
        if (app.filters.until != null && r.created_at > app.filters.until) continue;
        const eid = reactedEventId(r);
        if (!eid || app.shownPosts.has(eid)) continue;
        fresh.push({ reaction: r, eventId: eid });
      }

      if (fresh.length === 0) continue;

      const posts = await fetchPosts(fresh.map((f) => f.eventId));
      const authorPubkeys = [];
      for (const f of fresh) {
        const post = posts.get(f.eventId);
        if (post) authorPubkeys.push(post.pubkey);
      }
      const profiles = await fetchProfiles(authorPubkeys);

      for (const f of fresh) {
        const post = posts.get(f.eventId);
        if (!post) continue;
        if (app.shownPosts.has(post.id)) continue;
        if (!passesImageFilter(post)) continue;
        app.shownPosts.add(post.id);
        const profile = profiles.get(post.pubkey);
        els.feed.appendChild(buildCard(post, profile, f.reaction));
        addedThisScroll++;
      }

      if (addedThisScroll > 0) break; // got something visible; wait for next scroll
    }
  } catch (err) {
    setStatus(`Error loading reactions: ${err && err.message ? err.message : err}`, true);
  } finally {
    app.loading = false;
    els.loader.hidden = true;
    updateEndState(addedThisScroll);
    // If nothing shown yet and sentinel still visible, keep paging.
    if (!app.exhausted && els.feed.childElementCount > 0) maybeContinue();
    else if (!app.exhausted && els.feed.childElementCount === 0) maybeContinue();
  }
}

function updateEndState(added) {
  if (app.exhausted) {
    els.end.hidden = els.feed.childElementCount === 0 ? true : false;
    if (els.feed.childElementCount === 0) renderEmpty();
    setStatus(els.feed.childElementCount
      ? `Showing ${els.feed.childElementCount} reacted post${els.feed.childElementCount === 1 ? "" : "s"}.`
      : "No reacted posts match these filters.");
  } else {
    setStatus(`Showing ${els.feed.childElementCount} reacted post${els.feed.childElementCount === 1 ? "" : "s"}…`);
  }
}

function renderEmpty() {
  if (els.feed.querySelector(".empty")) return;
  const div = document.createElement("div");
  div.className = "empty";
  div.innerHTML = `<div class="big">🫥</div><div>No reacted posts match these filters.</div>`;
  els.feed.appendChild(div);
}

let continueTimer = null;
function maybeContinue() {
  if (continueTimer) return;
  continueTimer = setTimeout(() => {
    continueTimer = null;
    const rect = els.sentinel.getBoundingClientRect();
    if (!app.exhausted && rect.top < window.innerHeight + 200) loadMore();
  }, 120);
}

async function resetAndLoad() {
  els.feed.innerHTML = "";
  els.end.hidden = true;
  app.cursor = null;
  app.exhausted = false;
  app.loading = false;
  app.seenReactions.clear();
  app.shownPosts.clear();
  showSkeleton();
  setStatus("Fetching your reactions…");
  await loadMore();
  clearSkeleton();
}

function showSkeleton() {
  clearSkeleton();
  const wrap = document.createElement("div");
  wrap.className = "skeleton";
  wrap.id = "skeleton";
  for (let i = 0; i < 6; i++) {
    const c = document.createElement("div");
    c.className = "sk-card";
    wrap.appendChild(c);
  }
  els.feed.appendChild(wrap);
}
function clearSkeleton() {
  const s = document.getElementById("skeleton");
  if (s) s.remove();
}

// ---------- card rendering ----------
function buildCard(post, profile, reaction) {
  const card = document.createElement("article");
  card.className = "card";

  const name = (profile && (profile.name || profile.handle)) || fallbackName(post.pubkey);
  const handle = profile && profile.handle ? `@${profile.handle}` : shortId(post.pubkey, 10, 6);
  const pic = (profile && profile.picture) || avatarFallback(post.pubkey);

  // head
  const head = document.createElement("div");
  head.className = "card-head";
  const av = document.createElement("img");
  av.className = "avatar";
  av.loading = "lazy";
  av.alt = "";
  av.src = pic;
  av.onerror = () => { av.onerror = null; av.src = avatarFallback(post.pubkey); };
  const authorBox = document.createElement("div");
  authorBox.className = "card-author";
  const nameEl = document.createElement("div");
  nameEl.className = "name";
  nameEl.textContent = name;
  const handleEl = document.createElement("div");
  handleEl.className = "handle";
  handleEl.textContent = handle;
  authorBox.append(nameEl, handleEl);
  const reactionEl = document.createElement("span");
  reactionEl.className = "card-reaction";
  reactionEl.title = "Your reaction";
  reactionEl.textContent = reactionSymbol(reaction.content);
  head.append(av, authorBox, reactionEl);

  // body text
  const body = document.createElement("div");
  body.className = "card-body";
  const text = document.createElement("div");
  text.className = "card-text";
  text.innerHTML = renderContent(post);
  if (text.textContent.trim() === "") text.remove();
  else body.appendChild(text);

  // media
  const images = extractImageUrls(post);
  let media = null;
  if (images.length) {
    media = document.createElement("div");
    media.className = "card-media" + (images.length > 1 ? " multi" : "");
    for (const url of images.slice(0, 4)) {
      const img = document.createElement("img");
      img.loading = "lazy";
      img.alt = "post image";
      img.src = url;
      img.addEventListener("click", () => openLightbox(url));
      img.onerror = () => { img.style.display = "none"; };
      media.appendChild(img);
    }
  }

  // foot
  const foot = document.createElement("div");
  foot.className = "card-foot";
  const date = document.createElement("span");
  date.textContent = formatDate(post.created_at);
  const link = document.createElement("a");
  link.href = `https://njump.me/${post.id}`;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "Open ↗";
  foot.append(date, link);

  card.append(head, body);
  if (media) card.appendChild(media);
  card.appendChild(foot);
  return card;
}

// ---------- lightbox ----------
function openLightbox(url) {
  els.lightboxImg.src = url;
  els.lightbox.hidden = false;
}
function closeLightbox() {
  els.lightbox.hidden = true;
  els.lightboxImg.src = "";
}

// ---------- filters ----------
function dayStart(value) {
  if (!value) return null;
  const d = new Date(value + "T00:00:00");
  return Math.floor(d.getTime() / 1000);
}
function dayEnd(value) {
  if (!value) return null;
  const d = new Date(value + "T23:59:59");
  return Math.floor(d.getTime() / 1000);
}

async function applyFilters() {
  if (!app.pubkey) { setStatus("Connect with NIP-07 first.", true); return; }
  app.filters.since = dayStart(els.dateFrom.value);
  app.filters.until = dayEnd(els.dateTo.value);
  app.profileCache.clear(); // keep small; profiles refetched lazily anyway
  await resetAndLoad();
}

// ---------- wire up ----------
function initEvents() {
  els.loginBtn.addEventListener("click", login);
  els.logoutBtn.addEventListener("click", logout);
  els.applyBtn.addEventListener("click", applyFilters);

  els.useUserRelays.addEventListener("change", async () => {
    app.useUserRelays = els.useUserRelays.checked;
    await applyRelayMode();
    if (app.pubkey) await resetAndLoad();
  });

  document.querySelectorAll(".seg").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".seg").forEach((b) => {
        b.classList.remove("active");
        b.setAttribute("aria-checked", "false");
      });
      btn.classList.add("active");
      btn.setAttribute("aria-checked", "true");
      app.filters.image = btn.dataset.image;
      if (app.pubkey) resetAndLoad();
    });
  });

  els.lightbox.addEventListener("click", (e) => {
    if (e.target === els.lightbox || e.target.classList.contains("lightbox-close")) closeLightbox();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeLightbox(); });

  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) loadMore();
    }
  }, { rootMargin: "600px 0px" });
  io.observe(els.sentinel);

  // Periodically refresh relay connection dots.
  setInterval(renderRelayList, 1500);
}

function init() {
  renderRelayList();
  initEvents();
  if (!window.nostr) {
    setStatus("Tip: this app needs a NIP-07 browser extension to connect.");
  }
}

// Expose helpers for automated/browser verification.
window.__nrv = { app, isImageUrlSelfTest };
import("./nostr.js").then((m) => { window.__nrv.nostr = m; });

// Small self-test used by the verification script (no private data involved).
function isImageUrlSelfTest() {
  return import("./nostr.js").then((m) => {
    const cases = [
      ["https://x.com/a/b/photo.JPG?width=800&token=abc", true],
      ["https://x.com/image.png#frag", true],
      ["https://x.com/render?file=cat.png", false],
      ["https://x.com/a.webp", true],
      ["https://x.com/nope", false],
      ["https://x.com/path.mp4?x=1", false],
    ];
    return cases.map(([url, want]) => ({ url, want, got: m.isImageUrl(url), ok: m.isImageUrl(url) === want }));
  });
}

init();
