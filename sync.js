/* Qaza Salah Tracker - Google Drive sync (talks to google-drive-sync/Code.gs).
   Works in the browser (window.SalahSync) and in Node (for the tests). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SalahSync = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const CONFIG_KEY = "qaza-salah-sync-v2";
  const CODE_PREFIX = "QSC1.";

  function b64encode(str) {
    if (typeof btoa === "function") return btoa(unescape(encodeURIComponent(str)));
    return Buffer.from(str, "utf8").toString("base64");
  }
  function b64decode(str) {
    if (typeof atob === "function") return decodeURIComponent(escape(atob(str)));
    return Buffer.from(str, "base64").toString("utf8");
  }

  // Accepts a connection code ("QSC1....") or a web app link plus a secret.
  function parseConnection(linkOrCode, secret) {
    const v = String(linkOrCode || "").trim();
    if (v.indexOf(CODE_PREFIX) === 0) {
      try {
        const o = JSON.parse(b64decode(v.slice(CODE_PREFIX.length)));
        if (o && typeof o.u === "string" && typeof o.s === "string") return parseConnection(o.u, o.s);
      } catch (e) { /* fall through */ }
      return { ok: false, error: "That connection code is not valid. Copy it again from your other phone." };
    }
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[^\s]+\/exec$/.test(v))
      return { ok: false, error: "The link must start with https://script.google.com/macros/s/ and end with /exec" };
    const s = String(secret || "").trim();
    if (!s) return { ok: false, error: "Please type your secret code." };
    return { ok: true, url: v, secret: s };
  }

  function createSync(opts) {
    const store = opts.store, storage = opts.storage, fetchFn = opts.fetchFn;
    const nowMs = opts.nowMs || (() => Date.now());
    const onStatus = opts.onStatus || function () {};
    const onDataChanged = opts.onDataChanged || function () {};
    const setTimer = opts.setTimer || setTimeout, clearTimer = opts.clearTimer || clearTimeout;
    const debounceMs = opts.debounceMs === undefined ? 2000 : opts.debounceMs;
    const timeoutMs = opts.timeoutMs || 30000;

    let cfg = null, running = false, again = false, timer = null;
    let status = { state: "off", message: "Not connected", lastSync: 0 };

    function setStatus(state, message) {
      status = { state, message: message || "", lastSync: cfg ? cfg.lastSync || 0 : 0 };
      onStatus(status);
    }
    function loadCfg() {
      try {
        const o = JSON.parse(storage.getItem(CONFIG_KEY));
        if (o && typeof o.url === "string" && typeof o.secret === "string") cfg = { url: o.url, secret: o.secret, rev: Number(o.rev) || 0, lastSync: Number(o.lastSync) || 0 };
      } catch (e) { cfg = null; }
      setStatus(cfg ? "idle" : "off", cfg ? "Connected" : "Not connected");
    }
    function saveCfg() { try { storage.setItem(CONFIG_KEY, JSON.stringify(cfg)); return true; } catch (e) { return false; } }

    async function post(body) {
      let ctl = null, to = null;
      if (typeof AbortController !== "undefined") { ctl = new AbortController(); to = setTimeout(() => ctl.abort(), timeoutMs); }
      try {
        // Plain text body: avoids the browser "preflight" check that Google Apps Script does not support.
        const res = await fetchFn(cfg.url, { method: "POST", body: JSON.stringify(Object.assign({ token: cfg.secret }, body)), redirect: "follow", signal: ctl ? ctl.signal : undefined });
        const text = await res.text();
        let json;
        try { json = JSON.parse(text); } catch (e) { throw Object.assign(new Error("The server did not answer correctly. Check the link and that the deployment access is 'Anyone'."), { kind: "server" }); }
        return json;
      } finally { if (to) clearTimeout(to); }
    }
    const isNetworkError = e => !e.kind;

    async function connect(linkOrCode, secret) {
      const p = parseConnection(linkOrCode, secret);
      if (!p.ok) return p;
      const prev = cfg;
      cfg = { url: p.url, secret: p.secret, rev: 0, lastSync: 0 };
      try {
        const r = await post({ action: "ping" });
        if (!r.ok) { cfg = prev; return { ok: false, error: r.error === "unauthorized" ? "Wrong secret code." : "The server refused: " + r.error }; }
      } catch (e) {
        cfg = prev;
        return { ok: false, error: isNetworkError(e) ? "Could not reach Google. Check your internet and the link." : e.message };
      }
      store.makeSnapshot("before connecting to Drive");
      store.markAllDirty();
      if (!saveCfg()) { cfg = prev; return { ok: false, error: "Could not save the connection on this device." }; }
      const res = await syncNow();
      return res.ok ? { ok: true } : res;
    }

    async function syncNow() {
      if (!cfg) return { ok: false, error: "Not connected" };
      if (running) { again = true; return { ok: true, queued: true }; }
      running = true; clearTimer(timer); timer = null;
      setStatus("syncing", "Syncing...");
      let result = { ok: true };
      try {
        const changes = store.getChanges();
        const r = await post({ action: "sync", since: cfg.rev, changes });
        if (!r.ok) {
          result = { ok: false, error: r.error === "unauthorized" ? "Wrong secret code." : "Server error: " + r.error };
          setStatus("error", result.error);
        } else {
          store.clearDirty(changes);                       // the server has saved everything we sent
          const applied = store.applyRemote(r.records);    // may mark a combined result as "still to send"
          if (!applied.ok) { result = { ok: false, error: applied.error }; setStatus("error", applied.error); }
          else {
            if (store.dirtyCount() > 0) again = true;      // edits made during the request, or a combined result
            cfg.rev = r.rev; cfg.lastSync = nowMs(); saveCfg();
            if (applied.changed) onDataChanged(applied.changed);
            setStatus("synced", "Synced");
          }
        }
      } catch (e) {
        result = { ok: false, error: e.message };
        setStatus(isNetworkError(e) ? "offline" : "error", isNetworkError(e) ? "Offline. Will sync when the internet is back." : e.message);
      }
      running = false;
      if (again) { again = false; if (result.ok) schedule(0); }
      return result;
    }

    function schedule(ms) {
      if (!cfg) return;
      clearTimer(timer);
      timer = setTimer(() => { timer = null; syncNow(); }, ms === undefined ? debounceMs : ms);
    }
    function disconnect() {
      cfg = null; clearTimer(timer); timer = null;
      try { storage.removeItem(CONFIG_KEY); } catch (e) { /* ignore */ }
      setStatus("off", "Not connected");
    }
    function makeCode() { return cfg ? CODE_PREFIX + b64encode(JSON.stringify({ u: cfg.url, s: cfg.secret })) : ""; }

    loadCfg();
    return {
      connect, syncNow, schedule, disconnect, makeCode,
      isConnected: () => !!cfg, getStatus: () => status, isRunning: () => running,
      pending: () => store.dirtyCount()
    };
  }

  return { createSync, parseConnection, CONFIG_KEY, CODE_PREFIX };
});
