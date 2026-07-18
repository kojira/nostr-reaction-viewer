// Nostr helpers: image detection, profile parsing, content rendering.

const IMAGE_EXTENSIONS = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "avif", "apng", "jfif", "heic", "heif",
]);

const URL_RE = /\bhttps?:\/\/[^\s<>"'`)]+/gi;

/**
 * Detect whether a URL points at an image using ONLY the pathname extension.
 * Query parameters and fragments are ignored (as required).
 */
export function isImageUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch (_) {
    return false;
  }
  // Use pathname only — deliberately ignore url.search and url.hash.
  const path = url.pathname;
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  const ext = path.slice(dot + 1).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

/** Collect image URLs from a kind-1 event's content and imeta (NIP-92) tags. */
export function extractImageUrls(event) {
  const found = [];
  const seen = new Set();
  const push = (u) => {
    if (u && !seen.has(u) && isImageUrl(u)) { seen.add(u); found.push(u); }
  };

  const content = event?.content || "";
  const matches = content.match(URL_RE) || [];
  for (const m of matches) push(m.replace(/[.,;:!?]+$/, ""));

  // NIP-92 imeta tags: ["imeta", "url https://...", "m image/png", ...]
  for (const tag of event?.tags || []) {
    if (tag[0] === "imeta") {
      for (const part of tag.slice(1)) {
        if (typeof part === "string" && part.startsWith("url ")) push(part.slice(4).trim());
      }
    }
  }
  return found;
}

export function hasImages(event) {
  return extractImageUrls(event).length > 0;
}

/** Parse a kind-0 metadata event into a normalized profile object. */
export function parseProfile(event) {
  if (!event) return null;
  let meta = {};
  try { meta = JSON.parse(event.content || "{}"); } catch (_) { meta = {}; }
  return {
    pubkey: event.pubkey,
    name: meta.display_name || meta.displayName || meta.name || "",
    handle: meta.name || meta.nip05 || "",
    picture: typeof meta.picture === "string" ? meta.picture : "",
    about: meta.about || "",
  };
}

export function shortId(hex, head = 8, tail = 4) {
  if (!hex) return "";
  if (hex.length <= head + tail) return hex;
  return `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}

export function fallbackName(pubkey) {
  return `npub ${shortId(pubkey, 6, 4)}`;
}

/** Deterministic gradient avatar (data URI) for users without a picture. */
export function avatarFallback(pubkey) {
  let h = 0;
  for (let i = 0; i < (pubkey || "").length; i++) h = (h * 31 + pubkey.charCodeAt(i)) >>> 0;
  const a = h % 360;
  const b = (a + 60 + (h >> 8) % 120) % 360;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='80' height='80'>
    <defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>
    <stop offset='0' stop-color='hsl(${a},70%,55%)'/><stop offset='1' stop-color='hsl(${b},70%,45%)'/>
    </linearGradient></defs><rect width='80' height='80' fill='url(#g)'/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const ESCAPE = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ESCAPE[c]);
}

/**
 * Render post text as safe HTML: escape everything, then linkify non-image
 * URLs. Image URLs are removed from the text since they render as media.
 */
export function renderContent(event) {
  const content = event?.content || "";
  const imageUrls = new Set(extractImageUrls(event));
  let out = "";
  let last = 0;
  URL_RE.lastIndex = 0;
  let m;
  while ((m = URL_RE.exec(content)) !== null) {
    out += escapeHtml(content.slice(last, m.index));
    const clean = m[0].replace(/[.,;:!?]+$/, "");
    const trailer = m[0].slice(clean.length);
    if (imageUrls.has(clean)) {
      // drop image URL from text
    } else {
      const safe = escapeHtml(clean);
      out += `<a href="${safe}" target="_blank" rel="noopener noreferrer">${safe}</a>`;
    }
    out += escapeHtml(trailer);
    last = m.index + m[0].length;
  }
  out += escapeHtml(content.slice(last));
  return out.trim();
}

export function formatDate(sec) {
  const d = new Date(sec * 1000);
  return d.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

/** Extract the reacted event id (last `e` tag) from a kind-7 reaction. */
export function reactedEventId(reaction) {
  const eTags = (reaction.tags || []).filter((t) => t[0] === "e" && t[1]);
  if (eTags.length === 0) return null;
  return eTags[eTags.length - 1][1];
}

export function reactedAuthor(reaction) {
  const pTags = (reaction.tags || []).filter((t) => t[0] === "p" && t[1]);
  return pTags.length ? pTags[pTags.length - 1][1] : null;
}

/** Normalize a reaction content string into a display emoji. */
export function reactionSymbol(content) {
  const c = (content || "").trim();
  if (c === "" || c === "+") return "❤️";
  if (c === "-") return "👎";
  if (/^:.+:$/.test(c)) return "⭐"; // custom shortcode emoji
  return c.slice(0, 4);
}
