/* Qaza Salah Tracker - Daily Arc Challenge (habits). Completely separate from the Qaza / Current prayer data.
   Works in the browser (window.SalahHabits) and in Node (for the tests). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SalahHabits = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const KEY = "qaza-salah-habits-v1";
  const TRACK_START = "2026-11-01";   // the first day the starting habits count
  const MIN_DATE = "2026-01-01";      // the earliest day you can fill in
  const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

  // [id, name, only on Fridays]  - in this order
  const DEFAULTS = [
    ["tahajjud", "Tahajjud", 0], ["fajr_wake", "Wake up for Fajr", 0], ["prayers5", "Prayers 5 times", 0],
    ["qaza5", "Qaza 5 namaz", 0], ["quran5", "Quran (5 Pages)", 0], ["insta1h", "Instagram screen time less than 1 hour", 0],
    ["game1h", "Game less than 1 hour", 0], ["screen3h", "Screen time less than 3h", 0], ["sleep", "6 to 8 hour Sleep", 0],
    ["yasin", "Surah Yasin after Fajr", 0], ["waqiah", "Surah Waqiah after Magrib", 0], ["mulk", "Surah Mulk after Esha", 0],
    ["durud", "Durud (1,000)", 0], ["estagfer", "Estagfer (1,000)", 0], ["kahf", "Surah Kahf (Friday Reminder)", 1]
  ];

  const pad = n => String(n).padStart(2, "0");
  function isValidKey(s) {
    if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const [y, m, d] = s.split("-").map(Number);
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  }
  const daysInMonth = (y, m0) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
  const weekday = key => { const [y, m, d] = key.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };   // 5 = Friday
  const keyOf = (y, m0, d) => y + "-" + pad(m0 + 1) + "-" + pad(d);
  const sortIds = arr => Array.from(new Set(arr)).sort();

  function createHabits(storage, opts) {
    opts = opts || {};
    const getTodayKey = opts.getTodayKey || (() => { const d = new Date(); return keyOf(d.getFullYear(), d.getMonth(), d.getDate()); });
    const nowMs = opts.nowMs || (() => Date.now());
    let defs = {};    // id -> {n:name, f:0/1 only Fridays, a:first day, x:first day it no longer applies (or null), o:order, t:changed-at}
    let days = {};    // date -> {c:[done ids], t}
    let dirty = {};   // "d|2026-11-14" / "h|tahajjud" -> time, waiting to be sent to Drive

    const getRaw = k => { try { return storage.getItem(k); } catch (e) { return null; } };
    const setRaw = (k, v) => { try { storage.setItem(k, v); return true; } catch (e) { return false; } };
    const persist = () => setRaw(KEY, JSON.stringify({ defs, days, dirty }));
    const copy = () => JSON.parse(JSON.stringify({ defs, days, dirty }));
    const putBack = c => { defs = c.defs; days = c.days; dirty = c.dirty; };

    function seedDefaults() {
      defs = {};
      DEFAULTS.forEach((d, i) => { defs[d[0]] = { n: d[1], f: d[2], a: TRACK_START, x: null, o: i + 1, t: 0 }; });
    }
    function cleanDef(d) {
      if (!d || typeof d !== "object" || typeof d.n !== "string" || !d.n.trim() || d.n.length > 80 || !isValidKey(d.a)) return null;
      if (d.x !== null && d.x !== undefined && !isValidKey(d.x)) return null;
      return { n: d.n.trim(), f: d.f ? 1 : 0, a: d.a, x: d.x || null, o: Number.isFinite(d.o) ? d.o : 999, t: Number.isFinite(d.t) ? d.t : 0 };
    }
    function cleanDay(key, d) {
      if (!isValidKey(key) || key < MIN_DATE || key > "2100-12-31" || !d || !Array.isArray(d.c)) return null;
      const c = d.c.filter(id => typeof id === "string" && ID_RE.test(id));
      return { c: sortIds(c).slice(0, 100), t: Number.isFinite(d.t) ? d.t : 0 };
    }

    function load() {
      defs = {}; days = {}; dirty = {};
      const raw = getRaw(KEY);
      let ok = false;
      if (raw !== null) {
        try {
          const o = JSON.parse(raw);
          if (o && typeof o === "object") {
            Object.keys(o.defs || {}).forEach(id => { const d = ID_RE.test(id) ? cleanDef(o.defs[id]) : null; if (d) defs[id] = d; });
            Object.keys(o.days || {}).forEach(k => { const d = cleanDay(k, o.days[k]); if (d) days[k] = d; });
            Object.keys(o.dirty || {}).forEach(k => { if (/^(d\|\d{4}-\d{2}-\d{2}|h\|[A-Za-z0-9_-]{1,40})$/.test(k) && Number.isFinite(o.dirty[k])) dirty[k] = o.dirty[k]; });
            ok = Object.keys(defs).length > 0;
          }
        } catch (e) { /* unreadable: start from the standard list; the stored text is left untouched until the next change */ }
      }
      if (!ok) seedDefaults();
      return { ok };
    }

    // ---------- reading ----------
    const isActiveOn = (d, key) => d.a <= key && (!d.x || key < d.x) && (!d.f || weekday(key) === 5);
    const byOrder = (a, b) => (a[1].o - b[1].o) || a[1].n.localeCompare(b[1].n);
    function applicable(key) {
      return Object.keys(defs).map(id => [id, defs[id]]).filter(e => isActiveOn(e[1], key)).sort(byOrder).map(e => ({ id: e[0], name: e[1].n, fridayOnly: !!e[1].f }));
    }
    const doneIds = key => (days[key] ? days[key].c : []);
    function dayScore(key) {
      const list = applicable(key), done = new Set(doneIds(key));
      const total = list.length, n = list.filter(h => done.has(h.id)).length;
      return { done: n, total, pct: total ? n / total * 100 : 0 };
    }
    function range(fromKey, toKey) {
      let done = 0, total = 0;
      const [fy, fm, fd] = fromKey.split("-").map(Number), [ty, tm, td] = toKey.split("-").map(Number);
      for (let t = Date.UTC(fy, fm - 1, fd), end = Date.UTC(ty, tm - 1, td); t <= end; t += 86400000) {
        const dt = new Date(t), s = dayScore(keyOf(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
        done += s.done; total += s.total;
      }
      return { done, total, pct: total ? done / total * 100 : 0 };
    }
    // The whole month / whole year is the denominator (like the Current Month card), days before the habits existed count as nothing.
    const monthStats = (y, m0) => range(keyOf(y, m0, 1), keyOf(y, m0, daysInMonth(y, m0)));
    const yearStats = y => range(y + "-01-01", y + "-12-31");
    function dayInfo(key) { const [y, m, d] = key.split("-").map(Number); return { day: d, daysInMonth: daysInMonth(y, m - 1) }; }
    // habits shown in the editor: everything that has not been removed yet
    const editable = todayKey => Object.keys(defs).map(id => [id, defs[id]]).filter(e => !e[1].x || e[1].x > todayKey).sort(byOrder)
      .map(e => ({ id: e[0], name: e[1].n, fridayOnly: !!e[1].f }));

    // ---------- changing ----------
    function commit(mutate) {
      const old = copy();
      mutate();
      if (!persist()) { putBack(old); return { ok: false, error: "Could not save. The phone storage may be full or blocked." }; }
      return { ok: true };
    }
    function setDone(key, id, value) {
      if (!isValidKey(key) || key < MIN_DATE) return { ok: false, error: "That date is not available." };
      if (key > getTodayKey()) return { ok: false, error: "Future days are locked." };
      if (!applicable(key).some(h => h.id === id)) return { ok: false, error: "That habit does not apply on this day." };
      const cur = new Set(doneIds(key));
      if (cur.has(id) === !!value) return { ok: true };
      return commit(() => {
        if (value) cur.add(id); else cur.delete(id);
        const t = Math.max(nowMs(), (days[key] ? days[key].t : 0) + 1);
        days[key] = { c: sortIds(Array.from(cur)), t }; dirty["d|" + key] = t;
      });
    }
    function newId() { return "u" + nowMs().toString(36) + Math.random().toString(36).slice(2, 6); }
    function addHabit(name, fridayOnly) {
      name = String(name || "").trim();
      if (!name) return { ok: false, error: "Please type the habit name." };
      if (name.length > 80) return { ok: false, error: "The name is too long (80 letters at most)." };
      let id = "";
      const r = commit(() => {
        id = newId(); const t = nowMs();
        const maxO = Object.keys(defs).reduce((m, k) => Math.max(m, defs[k].o), 0);
        defs[id] = { n: name, f: fridayOnly ? 1 : 0, a: getTodayKey(), x: null, o: maxO + 1, t }; dirty["h|" + id] = t;
      });
      return r.ok ? { ok: true, id } : r;
    }
    function renameHabit(id, name) {
      name = String(name || "").trim();
      if (!defs[id]) return { ok: false, error: "Habit not found." };
      if (!name) return { ok: false, error: "Please type the habit name." };
      if (name.length > 80) return { ok: false, error: "The name is too long (80 letters at most)." };
      return commit(() => { const t = Math.max(nowMs(), defs[id].t + 1); defs[id] = Object.assign({}, defs[id], { n: name, t }); dirty["h|" + id] = t; });
    }
    // From today on the habit disappears. Earlier days keep exactly the score they had.
    function removeHabit(id) {
      if (!defs[id] || defs[id].x) return { ok: false, error: "Habit not found." };
      return commit(() => { const t = Math.max(nowMs(), defs[id].t + 1); defs[id] = Object.assign({}, defs[id], { x: getTodayKey(), t }); dirty["h|" + id] = t; });
    }

    // ---------- backup / restore ----------
    function exportData() { return { defs: JSON.parse(JSON.stringify(defs)), days: JSON.parse(JSON.stringify(days)) }; }
    function validate(data) {
      if (!data || typeof data !== "object" || typeof data.defs !== "object" || typeof data.days !== "object" || !data.defs || !data.days) return { ok: false, error: "No habits data in this file." };
      const nd = {}, ndays = {};
      Object.keys(data.defs).forEach(id => { const d = ID_RE.test(id) ? cleanDef(data.defs[id]) : null; if (d) nd[id] = d; });
      Object.keys(data.days).forEach(k => { const d = cleanDay(k, data.days[k]); if (d) ndays[k] = d; });
      if (!Object.keys(nd).length) return { ok: false, error: "The habits list in this file is empty." };
      return { ok: true, defs: nd, days: ndays };
    }
    // Replaces all habits. Every item is stamped "changed now", so the restore also wins over Drive.
    function importAll(data) {
      const v = validate(data); if (!v.ok) return v;
      return commit(() => {
        const t = nowMs(), old = { defs, days };
        defs = v.defs; days = v.days; dirty = {};
        // habits that exist now but not in the file are kept as "removed from today", so they cannot come back from Drive
        Object.keys(old.defs).forEach(id => { if (!defs[id]) defs[id] = Object.assign({}, old.defs[id], { x: old.defs[id].x || getTodayKey() }); });
        Object.keys(defs).forEach(id => { defs[id].t = t; dirty["h|" + id] = t; });
        Object.keys(old.days).concat(Object.keys(days)).forEach(k => { if (days[k]) days[k].t = t; else days[k] = { c: [], t }; dirty["d|" + k] = t; });
      });
    }

    // ---------- Drive sync helpers (used by sync.js) ----------
    function getChanges() {
      const out = { days: {}, defs: {} };
      Object.keys(dirty).forEach(k => {
        const kind = k[0], id = k.slice(2);
        if (kind === "d" && days[id]) out.days[id] = { c: days[id].c.slice(), t: days[id].t };
        if (kind === "h" && defs[id]) out.defs[id] = { n: defs[id].n, f: defs[id].f, a: defs[id].a, x: defs[id].x, o: defs[id].o, t: defs[id].t };
      });
      return out;
    }
    function clearDirty(sent) {
      if (!sent) return;
      Object.keys(sent.days || {}).forEach(k => { if (dirty["d|" + k] === sent.days[k].t) delete dirty["d|" + k]; });
      Object.keys(sent.defs || {}).forEach(k => { if (dirty["h|" + k] === sent.defs[k].t) delete dirty["h|" + k]; });
      persist();
    }
    function markAllDirty() {
      Object.keys(days).forEach(k => { dirty["d|" + k] = days[k].t; });
      Object.keys(defs).forEach(k => { dirty["h|" + k] = defs[k].t; });
      persist();
    }
    const dirtyCount = () => Object.keys(dirty).length;
    // Newer change wins. Same time: for a day the done-lists are combined; a habit keeps the local copy.
    function applyRemote(remote) {
      if (!remote || typeof remote !== "object") return { ok: true, changed: 0 };
      const old = copy(); let changed = 0;
      Object.keys(remote.defs || {}).forEach(id => {
        const inc = ID_RE.test(id) ? cleanDef(remote.defs[id]) : null; if (!inc) return;
        const cur = defs[id];
        if (!cur || inc.t > cur.t) { defs[id] = inc; delete dirty["h|" + id]; changed++; }
      });
      Object.keys(remote.days || {}).forEach(k => {
        const inc = cleanDay(k, remote.days[k]); if (!inc) return;
        const cur = days[k];
        if (!cur || inc.t > cur.t) { days[k] = inc; delete dirty["d|" + k]; changed++; }
        else if (inc.t === cur.t) {
          const merged = sortIds(cur.c.concat(inc.c));
          if (merged.join() !== cur.c.join()) { days[k] = { c: merged, t: cur.t }; dirty["d|" + k] = cur.t; changed++; }
        }
      });
      if (!persist()) { putBack(old); return { ok: false, changed: 0, error: "Could not save habits from Drive." }; }
      return { ok: true, changed };
    }

    return {
      load, applicable, doneIds, dayScore, monthStats, yearStats, dayInfo, editable,
      setDone, addHabit, renameHabit, removeHabit, exportData, validate, importAll,
      getChanges, clearDirty, markAllDirty, dirtyCount, applyRemote,
      dayCount: () => Object.keys(days).length
    };
  }

  return { createHabits, DEFAULTS, TRACK_START, MIN_DATE, weekday, daysInMonth };
});
