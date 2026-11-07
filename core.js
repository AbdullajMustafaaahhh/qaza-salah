/* Qaza Salah Tracker - core logic (no screen code here).
   Works in the browser (window.SalahCore) and in Node (for the tests). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SalahCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const START_QAZA = "2010-03-21";
  const END_QAZA = "2026-10-28";
  const START_CURRENT = "2026-10-29";
  const NAMES = ["Fajr", "Zuhr", "Asr", "Maghrib", "Isha"];
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
    "August", "September", "October", "November", "December"];

  const KEYS = {
    qaza: "qaza-salah-qaza-v2",
    current: "qaza-salah-current-v2",
    legacy: "qaza-salah-prototype-v1",            // the old prototype key (never deleted)
    legacyBackup: "qaza-salah-legacy-backup-v1",  // untouched copy of the old data
    snapshot: "qaza-salah-safety-snapshot-v2",    // copy made before restore/import
    meta: "qaza-salah-meta-v2",
    times: "qaza-salah-times-v2",                 // when each date was last changed (for Drive sync)
    dirty: "qaza-salah-dirty-v2"                  // dates changed but not yet sent to Drive
  };

  const pad = n => String(n).padStart(2, "0");
  const dateKey = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());

  function isValidKey(s) {
    if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const [y, m, d] = s.split("-").map(Number);
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  }
  // Whole-day counter that ignores time zones and daylight saving.
  function dayNumber(key) {
    const [y, m, d] = key.split("-").map(Number);
    return Math.round(Date.UTC(y, m - 1, d) / 86400000);
  }
  const daysInMonth = (y, m0) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
  const monthTitle = (y, m0) => MONTHS[m0] + " " + y;

  // Which tracker does a date belong to? "qaza", "current" or null.
  function trackerFor(key) {
    if (!isValidKey(key)) return null;
    if (key >= START_QAZA && key <= END_QAZA) return "qaza";
    if (key >= START_CURRENT) return "current";
    return null;
  }
  // Qaza: any date in its range. Current: from 29 Oct 2026 up to today (no future days).
  function canEdit(tracker, key, todayKey) {
    if (tracker === "qaza") return isValidKey(key) && key >= START_QAZA && key <= END_QAZA;
    if (tracker === "current") return isValidKey(key) && key >= START_CURRENT && key <= todayKey;
    return false;
  }

  const enc = rec => rec.map(b => (b ? "1" : "0")).join("");
  const dec = s => s.split("").map(c => c === "1");
  const emptyRec = () => [false, false, false, false, false];
  const truthy = v => v === true || v === 1 || v === "1" || (typeof v === "string" && /^(true|yes|y|x|done|completed|✓|✔)$/i.test(v.trim()));

  // Accepts: array of 5 booleans (old prototype), "10110" text, or {Fajr:true,...}.
  function normalizeRecord(v) {
    if (Array.isArray(v)) return NAMES.map((_, i) => truthy(v[i]));
    if (typeof v === "string" && /^[01]{5}$/.test(v)) return dec(v);
    if (v && typeof v === "object") {
      const low = {};
      Object.keys(v).forEach(k => { low[k.toLowerCase()] = v[k]; });
      return NAMES.map(n => truthy(low[n.toLowerCase()]));
    }
    return null;
  }

  function qazaTotalPrayers() {
    return (dayNumber(END_QAZA) - dayNumber(START_QAZA) + 1) * 5;
  }
  // Month shown on the "Current" side: today's month (or Oct 2026 if the date is before the start).
  function activeCurrentMonth(todayKey) {
    const k = todayKey < START_CURRENT ? START_CURRENT : todayKey;
    return { year: Number(k.slice(0, 4)), month: Number(k.slice(5, 7)) - 1 };
  }

  function createStore(storage, opts) {
    opts = opts || {};
    const getTodayKey = opts.getTodayKey || (() => dateKey(new Date()));
    const nowMs = opts.nowMs || (() => Date.now());
    let state = { qaza: {}, current: {} };   // date -> "10110"
    let times = { qaza: {}, current: {} };   // date -> time of last change (ms)
    let dirty = {};                          // "qaza|2015-06-10" -> time, waiting to be sent to Drive
    let loadInfo = { migrated: false };

    function getRaw(k) { try { return storage.getItem(k); } catch (e) { return null; } }
    function setRaw(k, v) { try { storage.setItem(k, v); return true; } catch (e) { return false; } }

    function cleanMap(tracker, obj) {
      const map = {}; let skipped = 0;
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        Object.keys(obj).forEach(k => {
          const v = obj[k];
          const rec = (v && typeof v === "object" && !Array.isArray(v) && typeof v.m === "string") ? normalizeRecord(v.m) : normalizeRecord(v);   // v.m = Drive file format
          if (!isValidKey(k) || trackerFor(k) !== tracker || !rec) { skipped++; return; }
          if (rec.some(Boolean)) map[k] = enc(rec);
        });
      } else if (obj != null) skipped++;
      return { map, skipped };
    }

    function persist(tracker) { return setRaw(KEYS[tracker], JSON.stringify(state[tracker])); }
    function persistBoth() { const a = persist("qaza"); const b = persist("current"); return a && b; }
    function persistMeta() { const a = setRaw(KEYS.times, JSON.stringify(times)); const b = setRaw(KEYS.dirty, JSON.stringify(dirty)); return a && b; }
    function persistAll() { const a = persistBoth(); const b = persistMeta(); return a && b; }
    const copyAll = () => JSON.parse(JSON.stringify({ state, times, dirty }));
    function putAll(c) { state = c.state; times = c.times; dirty = c.dirty; }

    // Copies the old prototype data (key "qaza-salah-prototype-v1") into the two new keys.
    // The old key is never changed or deleted. A raw backup copy is written first.
    function migrateLegacy() {
      if (getRaw(KEYS.qaza) !== null || getRaw(KEYS.current) !== null) return { migrated: false };
      const raw = getRaw(KEYS.legacy);
      if (raw === null) return { migrated: false };
      if (getRaw(KEYS.legacyBackup) === null && !setRaw(KEYS.legacyBackup, raw))
        return { migrated: false, error: "Could not make a backup copy, so old records were left untouched." };
      let parsed;
      try { parsed = JSON.parse(raw); } catch (e) {
        return { migrated: false, error: "Old records could not be read; they were left untouched." };
      }
      const maps = { qaza: {}, current: {} }; let moved = 0, skipped = 0;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        Object.keys(parsed).forEach(k => {
          const i = k.indexOf(":");
          const mode = k.slice(0, i), date = k.slice(i + 1);
          const rec = normalizeRecord(parsed[k]);
          if ((mode !== "qaza" && mode !== "current") || !isValidKey(date) || !rec) { skipped++; return; }
          if (trackerFor(date) !== mode) { skipped++; return; }   // wrong tracker for that date: stays only in the backup
          if (rec.some(Boolean)) { maps[mode][date] = enc(rec); moved++; }
        });
      }
      state = maps;
      if (!persistBoth()) { state = { qaza: {}, current: {} }; return { migrated: false, error: "Could not save migrated records." }; }
      setRaw(KEYS.meta, JSON.stringify({ migratedAt: new Date().toISOString(), moved, skipped }));
      return { migrated: true, moved, skipped };
    }

    function load() {
      state = { qaza: {}, current: {} };
      loadInfo = migrateLegacy();
      if (!loadInfo.migrated) {
        ["qaza", "current"].forEach(t => {
          const raw = getRaw(KEYS[t]);
          if (raw === null) return;
          try { state[t] = cleanMap(t, JSON.parse(raw)).map; } catch (e) { loadInfo.error = "Some saved records could not be read."; }
        });
      }
      times = { qaza: {}, current: {} }; dirty = {};
      try {
        const t = JSON.parse(getRaw(KEYS.times) || "{}");
        ["qaza", "current"].forEach(tr => { if (t && t[tr] && typeof t[tr] === "object") Object.keys(t[tr]).forEach(k => { if (isValidKey(k) && Number.isFinite(t[tr][k])) times[tr][k] = t[tr][k]; }); });
        const d = JSON.parse(getRaw(KEYS.dirty) || "{}");
        if (d && typeof d === "object") Object.keys(d).forEach(k => { if (/^(qaza|current)\|\d{4}-\d{2}-\d{2}$/.test(k) && Number.isFinite(d[k])) dirty[k] = d[k]; });
      } catch (e) { /* sync info unreadable: records themselves are fine */ }
      return loadInfo;
    }

    const getRecord = (tracker, key) => (state[tracker] && state[tracker][key]) ? dec(state[tracker][key]) : emptyRec();

    function setRecord(tracker, key, arr) {
      if (!canEdit(tracker, key, getTodayKey())) return { ok: false, error: "That date is outside this tracker's range." };
      const rec = normalizeRecord(arr);
      if (!rec) return { ok: false, error: "Invalid prayer values." };
      const before = state[tracker][key], bt = times[tracker][key], dk = tracker + "|" + key, bd = dirty[dk];
      const next = rec.some(Boolean) ? enc(rec) : undefined;
      if (before === next) return { ok: true };            // nothing changed
      if (next === undefined) delete state[tracker][key]; else state[tracker][key] = next;
      const t = Math.max(nowMs(), (bt || 0) + 1);
      times[tracker][key] = t; dirty[dk] = t;
      if (!(persist(tracker) && persistMeta())) {
        if (before === undefined) delete state[tracker][key]; else state[tracker][key] = before;
        if (bt === undefined) delete times[tracker][key]; else times[tracker][key] = bt;
        if (bd === undefined) delete dirty[dk]; else dirty[dk] = bd;
        return { ok: false, error: "Could not save. The phone storage may be full or blocked." };
      }
      return { ok: true };
    }

    function countTrue(s) { let n = 0; for (let i = 0; i < 5; i++) if (s[i] === "1") n++; return n; }

    function qazaStats() {
      let done = 0;
      Object.keys(state.qaza).forEach(k => { if (trackerFor(k) === "qaza") done += countTrue(state.qaza[k]); });
      const total = qazaTotalPrayers();
      return { done, total, remaining: Math.max(0, total - done), pct: total ? Math.min(100, done / total * 100) : 0 };
    }

    function monthStats(tracker, y, m0) {
      const days = daysInMonth(y, m0), prefix = y + "-" + pad(m0 + 1) + "-";
      const perPrayer = [0, 0, 0, 0, 0];
      Object.keys(state[tracker]).forEach(k => {
        if (!k.startsWith(prefix)) return;
        for (let i = 0; i < 5; i++) if (state[tracker][k][i] === "1") perPrayer[i]++;
      });
      const done = perPrayer.reduce((a, b) => a + b, 0), target = days * 5;
      return {
        days, target, done, remaining: Math.max(0, target - done),
        pct: target ? done / target * 100 : 0,
        perPrayer, perPrayerPct: perPrayer.map(n => n / days * 100)
      };
    }

    function lastCompletedQazaMonth() {
      const keys = Object.keys(state.qaza).filter(k => state.qaza[k].indexOf("1") >= 0).sort();
      if (!keys.length) return null;
      const k = keys[keys.length - 1];
      return { year: Number(k.slice(0, 4)), month: Number(k.slice(5, 7)) - 1, key: k };
    }

    function dayCounts() { return { qaza: Object.keys(state.qaza).length, current: Object.keys(state.current).length }; }

    // ---------- backup / restore ----------
    function exportData() {
      return {
        app: "qaza-salah-tracker", version: 2, exportedAt: new Date().toISOString(),
        note: "Each value is 5 digits in this order: Fajr, Zuhr, Asr, Maghrib, Isha. 1 = completed, 0 = not completed.",
        ranges: { qaza: [START_QAZA, END_QAZA], current: [START_CURRENT, null] },
        qaza: Object.assign({}, state.qaza), current: Object.assign({}, state.current)
      };
    }

    function validateBackup(obj) {
      const isDriveCopy = obj && typeof obj === "object" && typeof obj.rev === "number";   // a copy from the Drive backups folder
      if (!obj || typeof obj !== "object" || (obj.app !== "qaza-salah-tracker" && !isDriveCopy) || typeof obj.qaza !== "object" || typeof obj.current !== "object" || !obj.qaza || !obj.current)
        return { ok: false, error: "This file is not a Qaza Salah Tracker backup." };
      const q = cleanMap("qaza", obj.qaza), c = cleanMap("current", obj.current);
      return { ok: true, qaza: q.map, current: c.map, skipped: q.skipped + c.skipped };
    }

    function makeSnapshot(reason) {
      return setRaw(KEYS.snapshot, JSON.stringify({ createdAt: new Date().toISOString(), reason, data: exportData() }));
    }
    function getSnapshotInfo() {
      const raw = getRaw(KEYS.snapshot); if (!raw) return null;
      try {
        const s = JSON.parse(raw);
        const v = validateBackup(s.data);
        return v.ok ? { createdAt: s.createdAt, reason: s.reason, data: s.data } : null;
      } catch (e) { return null; }
    }

    // Replaces everything with the backup. A safety copy of the current records is saved first.
    // Every date is stamped "changed now", so the restore also wins over Drive when sync is on.
    function restore(obj) {
      const v = validateBackup(obj);
      if (!v.ok) return v;
      if (!makeSnapshot("before restore")) return { ok: false, error: "Could not save a safety copy first, so nothing was changed." };
      const old = copyAll(), t = nowMs();
      const oldState = state;
      state = { qaza: v.qaza, current: v.current };
      ["qaza", "current"].forEach(tr => {
        new Set(Object.keys(oldState[tr]).concat(Object.keys(state[tr]))).forEach(k => { times[tr][k] = t; dirty[tr + "|" + k] = t; });
      });
      if (!persistAll()) {
        putAll(old); persistAll();
        return { ok: false, error: "Could not save the restored records. Nothing was changed." };
      }
      return { ok: true, skipped: v.skipped, qazaDays: Object.keys(v.qaza).length, currentDays: Object.keys(v.current).length };
    }

    // ---------- CSV ----------
    function toCsv(tracker) {
      const rows = ["Date,Fajr,Zuhr,Asr,Maghrib,Isha"];
      Object.keys(state[tracker]).sort().forEach(k => {
        rows.push(k + "," + dec(state[tracker][k]).map(b => (b ? "TRUE" : "FALSE")).join(","));
      });
      return rows.join("\r\n") + "\r\n";
    }

    function splitCsvLine(line, delim) {
      const out = []; let cur = "", q = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (q) {
          if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch;
        } else if (ch === '"') q = true;
        else if (ch === delim) { out.push(cur); cur = ""; }
        else cur += ch;
      }
      out.push(cur);
      return out.map(s => s.trim());
    }

    // Returns { key } or { ambiguous:true, key } or null.
    function parseDateText(s) {
      s = String(s || "").trim();
      let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:$|[T\s])/);
      if (m) { const k = m[1] + "-" + pad(+m[2]) + "-" + pad(+m[3]); return isValidKey(k) ? { key: k } : null; }
      m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);
      if (m) {
        let a = +m[1], b = +m[2]; const y = +m[3];
        let day, mon, ambiguous = false;
        if (a > 12) { day = a; mon = b; } else if (b > 12) { mon = a; day = b; } else { mon = a; day = b; ambiguous = a !== b; }  // Google Sheets (US) order
        const k = y + "-" + pad(mon) + "-" + pad(day);
        return isValidKey(k) ? { key: k, ambiguous } : null;
      }
      if (/[A-Za-z]{3}/.test(s)) {
        const t = new Date(s);
        if (!isNaN(t)) { const k = dateKey(t); return isValidKey(k) ? { key: k } : null; }
      }
      return null;
    }

    // Reads CSV text (for example an export of the old Prayer_Data sheet).
    function parseCsv(text) {
      text = String(text || "").replace(/^\uFEFF/, "");
      const lines = text.split(/\r\n|\n|\r/).filter(l => l.trim() !== "");
      if (!lines.length) return { rows: [], invalid: 0, total: 0, ambiguous: false };
      const delim = [",", ";", "\t"].map(d => [d, lines[0].split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
      const head = splitCsvLine(lines[0], delim).map(h => h.toLowerCase());
      const idx = { date: head.indexOf("date") };
      const alias = { fajr: ["fajr"], zuhr: ["zuhr", "dhuhr", "zuhar"], asr: ["asr"], maghrib: ["maghrib"], isha: ["isha", "isha'a", "esha"] };
      const cols = NAMES.map(n => { const a = alias[n.toLowerCase()]; return head.findIndex(h => a.indexOf(h) >= 0); });
      let hasHeader = idx.date >= 0 && cols.every(c => c >= 0);
      let dateCol = idx.date, prayerCols = cols;
      if (!hasHeader) { dateCol = 0; prayerCols = [1, 2, 3, 4, 5]; }
      const body = hasHeader ? lines.slice(1) : lines;
      const byKey = {}; let invalid = 0, ambiguous = false;
      body.forEach(line => {
        const cells = splitCsvLine(line, delim);
        const d = parseDateText(cells[dateCol]);
        if (!d) { invalid++; return; }
        if (d.ambiguous) ambiguous = true;
        const rec = prayerCols.map(c => truthy(cells[c] === undefined ? "" : cells[c]));
        byKey[d.key] = byKey[d.key] ? byKey[d.key].map((v, i) => v || rec[i]) : rec;
      });
      const rows = Object.keys(byKey).sort().map(k => ({ key: k, rec: byKey[k] }));
      return { rows, invalid, total: body.length, ambiguous };
    }

    function planImport(rows) {
      const today = getTodayKey();
      const plan = { qaza: [], current: [], outOfRange: 0, first: null, last: null, prayersToAdd: 0 };
      rows.forEach(r => {
        const t = trackerFor(r.key);
        if (!t || !canEdit(t, r.key, today)) { plan.outOfRange++; return; }
        const old = getRecord(t, r.key);
        const add = r.rec.filter((v, i) => v && !old[i]).length;
        plan[t].push(r); plan.prayersToAdd += add;
        if (!plan.first || r.key < plan.first) plan.first = r.key;
        if (!plan.last || r.key > plan.last) plan.last = r.key;
      });
      return plan;
    }

    // Adds completed prayers from the plan. Nothing already completed is ever removed.
    function applyImport(plan) {
      if (!makeSnapshot("before import")) return { ok: false, error: "Could not save a safety copy first, so nothing was changed." };
      const old = copyAll(), t = nowMs();
      ["qaza", "current"].forEach(tr => {
        plan[tr].forEach(r => {
          const cur = getRecord(tr, r.key), merged = cur.map((v, i) => v || r.rec[i]);
          if (merged.some(Boolean) && enc(merged) !== enc(cur)) {
            state[tr][r.key] = enc(merged);
            times[tr][r.key] = Math.max(t, (times[tr][r.key] || 0) + 1); dirty[tr + "|" + r.key] = times[tr][r.key];
          }
        });
      });
      if (!persistAll()) { putAll(old); persistAll(); return { ok: false, error: "Could not save imported records. Nothing was changed." }; }
      return { ok: true };
    }

    // ---------- Drive sync helpers (used by sync.js) ----------
    const orMask = (a, b) => a.split("").map((c, i) => (c === "1" || b[i] === "1" ? "1" : "0")).join("");
    // Newer change wins. Same time (or both unknown) -> prayers are combined.
    function pickRecord(cur, inc) {
      if (cur.t === inc.t) return { m: orMask(cur.m, inc.m), t: cur.t };
      return inc.t > cur.t ? { m: inc.m, t: inc.t } : { m: cur.m, t: cur.t };
    }
    function getChanges() {
      const out = { qaza: {}, current: {} };
      Object.keys(dirty).forEach(dk => {
        const [tr, k] = dk.split("|");
        out[tr][k] = { m: state[tr][k] || "00000", t: times[tr][k] || 0 };
      });
      return out;
    }
    function clearDirty(sent) {
      ["qaza", "current"].forEach(tr => Object.keys((sent && sent[tr]) || {}).forEach(k => {
        const dk = tr + "|" + k;
        if (dirty[dk] !== undefined && dirty[dk] === sent[tr][k].t) delete dirty[dk];
      }));
      persistMeta();
    }
    function markAllDirty() {
      ["qaza", "current"].forEach(tr => new Set(Object.keys(state[tr]).concat(Object.keys(times[tr]))).forEach(k => { dirty[tr + "|" + k] = times[tr][k] || 0; }));
      persistMeta();
    }
    const dirtyCount = () => Object.keys(dirty).length;
    function applyRemote(remote) {
      if (!remote || typeof remote !== "object") return { ok: false, changed: 0 };
      const old = copyAll(); let changed = 0;
      ["qaza", "current"].forEach(tr => {
        const r = remote[tr]; if (!r || typeof r !== "object") return;
        Object.keys(r).forEach(k => {
          const inc = r[k];
          if (!isValidKey(k) || trackerFor(k) !== tr || !inc || typeof inc.m !== "string" || !/^[01]{5}$/.test(inc.m)) return;
          const it = Number.isFinite(inc.t) ? inc.t : 0, dk = tr + "|" + k;
          const known = state[tr][k] !== undefined || times[tr][k] !== undefined;
          const cur = { m: state[tr][k] || "00000", t: times[tr][k] || 0 };
          const res = known ? pickRecord(cur, { m: inc.m, t: it }) : { m: inc.m, t: it };
          if (res.m !== cur.m || res.t !== cur.t) {
            if (res.m === "00000") delete state[tr][k]; else state[tr][k] = res.m;
            if (res.t > 0) times[tr][k] = res.t;
            changed++;
          }
          if (res.m !== inc.m) dirty[dk] = res.t;                 // our combined result must go back to Drive
          else if (res.t === it && it > cur.t) delete dirty[dk];  // Drive's version replaced our older one
        });
      });
      if (!persistAll()) { putAll(old); persistAll(); return { ok: false, changed: 0, error: "Could not save records from Drive." }; }
      return { ok: true, changed };
    }

    return {
      load, getRecord, setRecord, canEdit: (t, k) => canEdit(t, k, getTodayKey()),
      qazaStats, monthStats, lastCompletedQazaMonth, dayCounts,
      exportData, validateBackup, restore, makeSnapshot, getSnapshotInfo,
      getChanges, clearDirty, markAllDirty, dirtyCount, applyRemote,
      toCsv, parseCsv, planImport, applyImport,
      get loadInfo() { return loadInfo; }
    };
  }

  return {
    START_QAZA, END_QAZA, START_CURRENT, NAMES, MONTHS, KEYS,
    dateKey, isValidKey, dayNumber, daysInMonth, monthTitle, trackerFor, canEdit,
    normalizeRecord, qazaTotalPrayers, activeCurrentMonth, createStore
  };
});
