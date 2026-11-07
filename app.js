/* Qaza Salah Tracker - screens and buttons. Calculations live in core.js. */
(() => {
  "use strict";
  const C = window.SalahCore;
  const NAMES = C.NAMES;
  const COLORS = ["#91D2EC", "#F4D477", "#E7A078", "#7773B8", "#244A7C"];
  const $ = id => document.getElementById(id);

  // "now" can be replaced by the automatic tests (window.__SALAH_NOW__). Normal use is the real clock.
  const now = () => (window.__SALAH_NOW__ ? new Date(window.__SALAH_NOW__) : new Date());
  const todayKey = () => C.dateKey(now());

  // ---------- storage (falls back to memory if the browser blocks storage) ----------
  let storageOk = true;
  function pickStorage() {
    try {
      const t = "__salah_test__";
      window.localStorage.setItem(t, "1"); window.localStorage.removeItem(t);
      return window.localStorage;
    } catch (e) {
      storageOk = false;
      const mem = {};
      return { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } };
    }
  }
  const storage = pickStorage();
  const store = C.createStore(storage, { getTodayKey: todayKey });
  const loadInfo = store.load();

  // ---------- state ----------
  let view = "overview";          // "overview" | "qaza" | "current"
  let selected = null;            // selected date key (only while the day sheet is open)
  const cal = { qaza: { year: 2010, month: 2 }, current: C.activeCurrentMonth(todayKey()) };
  let toastTimer;
  let lastDay = todayKey();

  const fmtN = n => Number(n).toLocaleString("en-US");
  const pct1 = p => p.toFixed(1) + "%";
  const monthIndex = c => c.year * 12 + c.month;
  const longDate = key => { const [y, m, d] = key.split("-").map(Number); return d + " " + C.MONTHS[m - 1] + " " + y; };
  const shortDate = key => { const [y, m, d] = key.split("-").map(Number); return d + " " + C.MONTHS[m - 1].slice(0, 3) + " " + y; };

  function qazaStartMonth() {
    const last = store.lastCompletedQazaMonth();
    return last ? { year: last.year, month: last.month } : { year: 2010, month: 2 };
  }

  // ---------- overview ----------
  function renderOverview() {
    const cm = C.activeCurrentMonth(todayKey());
    const ms = store.monthStats("current", cm.year, cm.month);
    $("currentTitle").textContent = C.monthTitle(cm.year, cm.month) + " Progress";
    $("currentDone").textContent = fmtN(ms.done);
    $("currentCaption").textContent = "of " + fmtN(ms.target) + " prayers completed (" + ms.days + " days × 5)";
    $("currentBar").style.width = ms.pct + "%";
    $("currentRemaining").textContent = fmtN(ms.remaining) + " remaining";
    $("currentPercent").textContent = pct1(ms.pct);
    $("prayerBars").innerHTML = NAMES.map((n, i) =>
      `<span class="pbar-row" data-prayer="${n}"><span class="pbar-name">${n}</span>` +
      `<span class="pbar-track"><i style="width:${ms.perPrayerPct[i]}%;background:${COLORS[i]}"></i></span>` +
      `<span class="pbar-count">${ms.perPrayer[i]}/${ms.days}</span></span>`).join("");

    const q = store.qazaStats();
    $("qazaDone").textContent = fmtN(q.done);
    $("qazaCaption").textContent = "of " + fmtN(q.total) + " Qaza prayers completed";
    $("qazaRemaining").textContent = fmtN(q.remaining) + " remaining";
    $("qazaPercent").textContent = pct1(q.pct);
    $("qazaBar").style.width = q.pct + "%";
    $("todayLabel").textContent = now().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  }

  // ---------- calendar ----------
  function ring(rec) {
    const r = 19, circ = 2 * Math.PI * r, seg = circ / 5, gap = 3.4;
    return `<svg class="ring" viewBox="0 0 48 48" aria-hidden="true">${NAMES.map((_, i) =>
      `<circle cx="24" cy="24" r="${r}" style="--c:${COLORS[i]}" stroke-dasharray="${seg - gap} ${circ - seg + gap}" stroke-dashoffset="${-(i * seg + gap / 2)}" class="${rec[i] ? "on" : ""}"></circle>`).join("")}</svg>`;
  }

  function renderCalendar() {
    if (view === "overview") return;
    const tracker = view, c = cal[tracker], today = todayKey();
    $("monthTitle").textContent = C.monthTitle(c.year, c.month);
    const grid = $("calendarGrid"); grid.innerHTML = "";
    const first = new Date(c.year, c.month, 1), days = C.daysInMonth(c.year, c.month);
    for (let i = 0; i < first.getDay(); i++) { const b = document.createElement("div"); b.className = "blank"; grid.append(b); }
    for (let d = 1; d <= days; d++) {
      const key = C.dateKey(new Date(c.year, c.month, d));
      const b = document.createElement("button");
      b.className = "day-cell" + (key === today && tracker === "current" ? " today" : "") + (key === selected ? " selected" : "");
      b.disabled = !store.canEdit(tracker, key);
      b.dataset.date = key;
      b.setAttribute("aria-label", longDate(key));
      b.innerHTML = ring(store.getRecord(tracker, key)) + `<span class="day-number">${d}</span>`;
      b.addEventListener("click", () => openDay(key));
      grid.append(b);
    }
    const idx = monthIndex(c);
    if (tracker === "qaza") {
      $("prevMonth").disabled = idx <= 2010 * 12 + 2;
      $("nextMonth").disabled = idx >= 2026 * 12 + 9;
    } else {
      $("prevMonth").disabled = idx <= 2026 * 12 + 9;
      $("nextMonth").disabled = false;
    }
  }

  function refreshAll() { renderOverview(); renderCalendar(); }

  // ---------- navigation ----------
  function showView(next) {
    view = next; selected = null;
    document.querySelectorAll(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.tab === next));
    $("overviewSection").hidden = next !== "overview";
    $("trackerSection").hidden = next === "overview";
    if (next === "qaza") {
      cal.qaza = qazaStartMonth();                 // month of the last completed Qaza prayer
      $("trackerEyebrow").textContent = "HISTORICAL QAZA";
      $("trackerTitle").textContent = "Qaza Tracker";
      $("todayBtn").textContent = "Latest";
      $("trackerHint").textContent = "Select a date to update its five prayer records.";
    } else if (next === "current") {
      cal.current = C.activeCurrentMonth(todayKey()); // this month
      $("trackerEyebrow").textContent = "DAILY RECORD";
      $("trackerTitle").textContent = "Current";
      $("todayBtn").textContent = "Today";
      $("trackerHint").textContent = "Select a date to update its five prayer records. Future days stay locked.";
    }
    refreshAll();
    window.scrollTo(0, 0);
  }

  function shiftMonth(delta) {
    const c = cal[view], d = new Date(c.year, c.month + delta, 1);
    cal[view] = { year: d.getFullYear(), month: d.getMonth() };
    renderCalendar();
  }

  // ---------- day sheet ----------
  function openDay(key) {
    if (view === "overview" || !store.canEdit(view, key)) return;
    selected = key;
    $("modalType").textContent = view === "qaza" ? "QAZA RECORD" : "CURRENT RECORD";
    $("dayTitle").textContent = longDate(key);
    renderDayRows();
    $("dayModal").hidden = false;
    renderCalendar();
  }
  function renderDayRows() {
    const vals = store.getRecord(view, selected);
    $("prayerList").innerHTML = NAMES.map((name, i) =>
      `<label class="prayer-row"><span class="prayer-left"><i class="prayer-dot" style="--p:${COLORS[i]}"></i>${name}</span>` +
      `<span class="prayer-state"><span>${vals[i] ? "Completed" : "Pending"}</span><input type="checkbox" data-index="${i}" ${vals[i] ? "checked" : ""}></span></label>`).join("");
    const n = vals.filter(Boolean).length;
    $("dayProgress").textContent = n + " of 5 completed";
    $("dayBar").style.width = (n * 20) + "%";
  }
  function saveDay(vals) {
    const res = store.setRecord(view, selected, vals);
    if (!res.ok) toast(res.error);
    renderDayRows(); refreshAll(); syncSoon();
  }
  function closeDay() { $("dayModal").hidden = true; selected = null; renderCalendar(); }

  // ---------- small helpers ----------
  function toast(msg) {
    const t = $("toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
  }

  let confirmResolve = null;
  function confirmDialog(o) {
    return new Promise(resolve => {
      confirmResolve = resolve;
      $("confirmTitle").textContent = o.title;
      $("confirmText").textContent = o.message;
      $("confirmOk").textContent = o.ok || "OK";
      $("confirmCancel").textContent = o.cancel || "Cancel";
      $("confirmCancel").hidden = !!o.single;
      $("confirmModal").hidden = false;
    });
  }
  function closeConfirm(result) {
    $("confirmModal").hidden = true;
    const r = confirmResolve; confirmResolve = null;
    if (r) r(result);
  }

  const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  // iPhone: open the share sheet (choose "Save to Files"). Computer: normal download.
  async function saveFile(name, text, mime) {
    const blob = new Blob([text], { type: mime });
    if (isIOS()) {
      try {
        const file = new File([blob], name, { type: mime });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: name });
          return "shared";
        }
      } catch (e) { if (e && e.name === "AbortError") return "cancelled"; }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return "downloaded";
  }
  async function readFile(file) {
    if (file.text) return file.text();
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsText(file); });
  }
  const countPrayers = map => Object.keys(map).reduce((s, k) => s + map[k].split("").filter(c => c === "1").length, 0);
  const stamp = () => todayKey();
  const dayWord = n => fmtN(n) + (n === 1 ? " day" : " days");

  // ---------- Google Drive sync ----------
  const STATE_TEXT = { idle: "Connected", syncing: "Syncing...", synced: "Saved to Drive", offline: "Offline", error: "Sync problem" };
  let syncer = null;
  syncer = window.SalahSync.createSync({
    store, storage,
    fetchFn: (u, o) => window.fetch(u, o),
    onStatus: renderSyncStatus,
    onDataChanged: () => { refreshAll(); if (!$("settingsModal").hidden) renderSettings(); }
  });
  function renderSyncStatus(st) {
    const chip = $("syncChip");
    chip.hidden = st.state === "off";
    chip.textContent = "☁ " + (STATE_TEXT[st.state] || "");
    chip.className = "sync-chip state-" + st.state;
    const box = $("syncStatusText");
    if (box) {
      const last = st.lastSync ? " Last synced: " + new Date(st.lastSync).toLocaleString("en-GB") + "." : "";
      const wait = syncer && syncer.pending() ? " " + syncer.pending() + " change(s) waiting to be sent." : "";
      box.textContent = (st.state === "error" || st.state === "offline" ? st.message : STATE_TEXT[st.state] || "") + "." + last + wait;
    }
  }
  const syncSoon = () => { if (syncer.isConnected()) syncer.schedule(); };

  // ---------- settings ----------
  function renderSettings() {
    const c = store.dayCounts();
    $("settingsInfo").textContent = (syncer.isConnected() ? "Records are saved on this phone and in your Google Drive. " : "Records are saved on this device only. ") + "Qaza: " + dayWord(c.qaza) + " with records. Current: " + dayWord(c.current) + " with records." +
      (storageOk ? "" : " WARNING: this browser is blocking storage, so records will be lost when you close the app.") +
      (location.protocol === "file:" ? " NOTE: you opened this as a plain file. Chrome and Edge can lose recent changes in this mode. Download a backup now and use the app from the web address on your iPhone." : "");
    const on = syncer.isConnected();
    $("syncOff").hidden = on; $("syncOn").hidden = !on;
    if (on) renderSyncStatus(syncer.getStatus());
    const snap = store.getSnapshotInfo();
    $("snapshotBtn").hidden = !snap;
    if (snap) $("snapshotInfo").textContent = "Safety copy made " + new Date(snap.createdAt).toLocaleString("en-GB") + " (" + snap.reason + ").";
  }
  function openSettings() { renderSettings(); $("settingsModal").hidden = false; }
  function closeSettings() { $("settingsModal").hidden = true; }

  async function doBackup() {
    const r = await saveFile("qaza-salah-backup-" + stamp() + ".json", JSON.stringify(store.exportData(), null, 2), "application/json");
    if (r !== "cancelled") toast(r === "shared" ? "Backup ready. Choose Save to Files." : "Backup file downloaded.");
  }
  async function doRestoreFile(file) {
    let obj;
    try { obj = JSON.parse(await readFile(file)); } catch (e) { await confirmDialog({ title: "Cannot read file", message: "This file is not a valid backup (.json).", ok: "OK", single: true }); return; }
    const v = store.validateBackup(obj);
    if (!v.ok) { await confirmDialog({ title: "Cannot restore", message: v.error, ok: "OK", single: true }); return; }
    const cur = store.dayCounts();
    const ok = await confirmDialog({
      title: "Replace all records?",
      message: "The backup has Qaza: " + fmtN(Object.keys(v.qaza).length) + " days (" + fmtN(countPrayers(v.qaza)) + " prayers) and Current: " + fmtN(Object.keys(v.current).length) + " days (" + fmtN(countPrayers(v.current)) + " prayers). " +
        "This replaces the records now on this device (Qaza " + fmtN(cur.qaza) + " days, Current " + fmtN(cur.current) + " days). A safety copy is saved first, so you can undo this in Settings.",
      ok: "Replace records"
    });
    if (!ok) return;
    const res = store.restore(obj);
    if (!res.ok) { toast(res.error); return; }
    toast("Backup restored."); renderSettings(); refreshAll(); syncSoon();
  }
  async function doCsvImport(file) {
    const parsed = store.parseCsv(await readFile(file));
    const plan = store.planImport(parsed.rows);
    const usable = plan.qaza.length + plan.current.length;
    if (!usable) {
      await confirmDialog({ title: "Nothing to import", message: "No rows had a date inside the Qaza range (21 Mar 2010 to 28 Oct 2026) or the Current range (29 Oct 2026 to today). Check that the first column is the date, written like 2010-03-21.", ok: "OK", single: true });
      return;
    }
    let msg = "Found " + fmtN(usable) + " dates from " + shortDate(plan.first) + " to " + shortDate(plan.last) + ": Qaza " + fmtN(plan.qaza.length) + " days, Current " + fmtN(plan.current.length) + " days. " +
      "This adds " + fmtN(plan.prayersToAdd) + " completed prayers. Nothing already completed is removed.";
    const skipped = plan.outOfRange + parsed.invalid;
    if (skipped) msg += " " + fmtN(skipped) + " rows will be skipped (date missing or outside both ranges).";
    if (parsed.ambiguous) msg += " Dates like 3/4/2010 were read as month/day. If that is wrong, cancel and format the date column as yyyy-mm-dd first.";
    const ok = await confirmDialog({ title: "Import these records?", message: msg, ok: "Import" });
    if (!ok) return;
    const res = store.applyImport(plan);
    if (!res.ok) { toast(res.error); return; }
    toast("Import finished."); renderSettings(); refreshAll(); syncSoon();
  }
  async function doCsvExport(tracker) {
    const r = await saveFile("qaza-salah-" + tracker + "-" + stamp() + ".csv", store.toCsv(tracker), "text/csv");
    if (r !== "cancelled") toast(r === "shared" ? "CSV ready. Choose Save to Files." : "CSV file downloaded.");
  }
  async function doSnapshotUndo() {
    const snap = store.getSnapshotInfo(); if (!snap) return;
    const ok = await confirmDialog({
      title: "Go back to the safety copy?",
      message: "This replaces the records now on this device with the copy made " + new Date(snap.createdAt).toLocaleString("en-GB") + ". Your present records are saved as a new safety copy first.",
      ok: "Go back"
    });
    if (!ok) return;
    const res = store.restore(snap.data);
    if (!res.ok) { toast(res.error); return; }
    toast("Safety copy restored."); renderSettings(); refreshAll(); syncSoon();
  }

  // ---------- events ----------
  function onCard(el, fn) {
    el.addEventListener("click", fn);
    el.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); } });
  }
  onCard($("currentJump"), () => showView("current"));
  onCard($("qazaJump"), () => showView("qaza"));
  document.querySelectorAll(".nav-item").forEach(b => b.addEventListener("click", () => showView(b.dataset.tab)));
  $("prevMonth").addEventListener("click", () => shiftMonth(-1));
  $("nextMonth").addEventListener("click", () => shiftMonth(1));
  $("todayBtn").addEventListener("click", () => {
    if (view === "qaza") cal.qaza = qazaStartMonth(); else if (view === "current") cal.current = C.activeCurrentMonth(todayKey());
    renderCalendar();
  });

  $("closeModal").addEventListener("click", closeDay);
  $("dayModal").addEventListener("click", e => { if (e.target === $("dayModal")) closeDay(); });
  $("prayerList").addEventListener("change", e => {
    const i = e.target && e.target.dataset ? e.target.dataset.index : undefined;
    if (i === undefined || selected === null) return;
    const vals = store.getRecord(view, selected); vals[Number(i)] = e.target.checked;
    saveDay(vals);
  });
  $("markAll").addEventListener("click", () => { if (selected) saveDay([true, true, true, true, true]); });
  $("clearDay").addEventListener("click", async () => {
    if (!selected) return;
    if (!store.getRecord(view, selected).some(Boolean)) return;
    const key = selected;
    const ok = await confirmDialog({ title: "Clear this date?", message: "All completed prayers on " + longDate(key) + " will be cleared.", ok: "Clear date" });
    if (ok && selected === key) saveDay([false, false, false, false, false]);
  });

  $("settingsBtn").addEventListener("click", openSettings);
  $("closeSettings").addEventListener("click", closeSettings);
  $("settingsModal").addEventListener("click", e => { if (e.target === $("settingsModal")) closeSettings(); });
  $("backupBtn").addEventListener("click", doBackup);
  $("restoreBtn").addEventListener("click", () => { $("restoreFile").value = ""; $("restoreFile").click(); });
  $("restoreFile").addEventListener("change", e => { const f = e.target.files[0]; if (f) doRestoreFile(f); });
  $("csvImportBtn").addEventListener("click", () => { $("csvFile").value = ""; $("csvFile").click(); });
  $("csvFile").addEventListener("change", e => { const f = e.target.files[0]; if (f) doCsvImport(f); });
  $("csvQazaBtn").addEventListener("click", () => doCsvExport("qaza"));
  $("csvCurrentBtn").addEventListener("click", () => doCsvExport("current"));
  $("snapshotBtn").addEventListener("click", doSnapshotUndo);
  $("syncConnectBtn").addEventListener("click", async () => {
    const btn = $("syncConnectBtn"); btn.disabled = true; toast("Connecting...");
    const r = await syncer.connect($("syncLink").value, $("syncSecret").value);
    btn.disabled = false;
    if (!r.ok) { await confirmDialog({ title: "Could not connect", message: r.error, ok: "OK", single: true }); }
    else { $("syncLink").value = ""; $("syncSecret").value = ""; toast("Connected. Your records are now saved to Google Drive."); refreshAll(); }
    renderSettings();
  });
  $("syncNowBtn").addEventListener("click", async () => {
    const r = await syncer.syncNow();
    toast(r.ok ? "Synced with Google Drive." : r.error); renderSettings();
  });
  $("syncCodeBtn").addEventListener("click", async () => {
    const box = $("syncCodeBox"); box.value = syncer.makeCode(); box.hidden = false; box.focus(); box.select();
    try { await navigator.clipboard.writeText(box.value); toast("Connection code copied."); } catch (e) { toast("Touch and hold the code, then Copy."); }
  });
  $("syncDisconnectBtn").addEventListener("click", async () => {
    const ok = await confirmDialog({ title: "Disconnect from Google Drive?", message: "Records on this phone and in Drive both stay. New changes will no longer be sent to Drive until you connect again.", ok: "Disconnect" });
    if (!ok) return;
    syncer.disconnect(); $("syncCodeBox").hidden = true; $("syncCodeBox").value = ""; toast("Disconnected."); renderSettings();
  });
  $("confirmOk").addEventListener("click", () => closeConfirm(true));
  $("confirmCancel").addEventListener("click", () => closeConfirm(false));
  $("confirmModal").addEventListener("click", e => { if (e.target === $("confirmModal")) closeConfirm(false); });

  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    if (!$("confirmModal").hidden) closeConfirm(false);
    else if (!$("settingsModal").hidden) closeSettings();
    else if (!$("dayModal").hidden) closeDay();
  });

  // New day (or coming back to the app): update the month title, today ring and totals.
  function checkNewDay() {
    const k = todayKey();
    if (k !== lastDay) {
      lastDay = k;
      if (view === "current") cal.current = C.activeCurrentMonth(k);
      refreshAll();
    }
  }
  function syncIfStale() {
    const st = syncer.getStatus();
    if (syncer.isConnected() && !syncer.isRunning() && Date.now() - (st.lastSync || 0) > 15000) syncer.syncNow();
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { checkNewDay(); syncIfStale(); } });
  window.addEventListener("online", () => { if (syncer.isConnected()) syncer.syncNow(); });
  $("syncChip").addEventListener("click", openSettings);
  setInterval(() => { checkNewDay(); if (!document.hidden) syncIfStale(); }, 60000);

  // ---------- start ----------
  renderOverview();
  renderSyncStatus(syncer.getStatus());
  if (syncer.isConnected()) syncer.syncNow();
  if (loadInfo.migrated) toast("Your earlier records were moved safely (" + loadInfo.moved + " days).");
  else if (loadInfo.error) toast(loadInfo.error);
  else if (!storageOk) toast("Storage is blocked in this browser. Records will not be saved.");

  if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  window.__salah = { store, showView, syncer };   // used by the automatic tests
})();
