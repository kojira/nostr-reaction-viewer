// Minimal dependency-free Nostr relay pool.
// Opens one WebSocket per relay, multiplexes REQ subscriptions, and
// collects events until EOSE (or a timeout) across all relays.

let subCounter = 0;
function nextSubId() {
  subCounter += 1;
  return `nrv-${subCounter.toString(36)}-${(subCounter * 2654435761 % 0x100000000).toString(36)}`;
}

export class RelayPool {
  constructor(urls) {
    this.urls = [];
    this.sockets = new Map(); // url -> { ws, ready(Promise), status }
    this.subs = new Map(); // subId -> { handlers }
    this.setRelays(urls);
  }

  setRelays(urls) {
    const next = [...new Set(urls.filter(Boolean))];
    // Close sockets no longer needed.
    for (const url of this.sockets.keys()) {
      if (!next.includes(url)) this._closeSocket(url);
    }
    this.urls = next;
  }

  status() {
    return this.urls.map((url) => ({
      url,
      connected: this.sockets.get(url)?.status === "open",
    }));
  }

  _closeSocket(url) {
    const entry = this.sockets.get(url);
    if (entry) {
      try { entry.ws.close(); } catch (_) { /* ignore */ }
      this.sockets.delete(url);
    }
  }

  _ensureSocket(url) {
    let entry = this.sockets.get(url);
    if (entry && (entry.status === "open" || entry.status === "connecting")) return entry;

    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      entry = { ws: null, status: "error", ready: Promise.reject(err) };
      this.sockets.set(url, entry);
      return entry;
    }

    entry = { ws, status: "connecting", ready: null, onMessage: null };
    entry.ready = new Promise((resolve) => {
      ws.addEventListener("open", () => { entry.status = "open"; resolve(true); });
      ws.addEventListener("error", () => { if (entry.status !== "open") { entry.status = "error"; resolve(false); } });
      ws.addEventListener("close", () => {
        entry.status = "closed";
        if (this.sockets.get(url) === entry) this.sockets.delete(url);
        resolve(false);
      });
    });

    ws.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (!Array.isArray(msg)) return;
      const [type, subId, payload] = msg;
      const sub = this.subs.get(subId);
      if (!sub) return;
      if (type === "EVENT" && payload) sub.onEvent(payload, url);
      else if (type === "EOSE") sub.onEose(url);
    });

    this.sockets.set(url, entry);
    return entry;
  }

  /**
   * Query all relays with a single filter, resolving with a de-duplicated,
   * created_at-descending array of events once every relay has sent EOSE
   * (or the timeout elapses).
   */
  query(filter, { timeout = 6000 } = {}) {
    return new Promise((resolve) => {
      const subId = nextSubId();
      const events = new Map(); // id -> event
      const eosed = new Set();
      const targets = [...this.urls];
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._unsubscribe(subId, targets);
        this.subs.delete(subId);
        const list = [...events.values()].sort((a, b) => b.created_at - a.created_at);
        resolve(list);
      };

      const timer = setTimeout(finish, timeout);

      this.subs.set(subId, {
        onEvent: (event) => {
          if (event && event.id && !events.has(event.id)) events.set(event.id, event);
        },
        onEose: (url) => {
          eosed.add(url);
          if (eosed.size >= targets.length) finish();
        },
      });

      if (targets.length === 0) { finish(); return; }

      let opened = 0;
      let closed = 0;
      targets.forEach((url) => {
        const entry = this._ensureSocket(url);
        Promise.resolve(entry.ready).then((ok) => {
          if (settled) return;
          if (ok && entry.ws && entry.ws.readyState === WebSocket.OPEN) {
            opened += 1;
            try { entry.ws.send(JSON.stringify(["REQ", subId, filter])); } catch (_) { /* ignore */ }
          } else {
            eosed.add(url); // treat unreachable relay as done
          }
          closed += 1;
          if (closed === targets.length && opened === 0) finish();
          else if (eosed.size >= targets.length) finish();
        });
      });
    });
  }

  _unsubscribe(subId, targets) {
    for (const url of targets) {
      const entry = this.sockets.get(url);
      if (entry && entry.status === "open" && entry.ws.readyState === WebSocket.OPEN) {
        try { entry.ws.send(JSON.stringify(["CLOSE", subId])); } catch (_) { /* ignore */ }
      }
    }
  }

  destroy() {
    for (const url of [...this.sockets.keys()]) this._closeSocket(url);
    this.subs.clear();
  }
}
