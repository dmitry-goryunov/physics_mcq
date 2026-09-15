// Ported from https://dmitry-goryunov.github.io/answer_logger/ (app.js),
// embedded as a mode within this app so it works fully offline alongside
// everything else. Wrapped in an IIFE (the original was a plain top-level
// script) so nothing here can collide with app.js's own scope. Element ids
// and CSS classes are all prefixed "al"/"al-" to match the namespaced markup
// and stylesheet — see index.html and answer-logger.css.
//
// localStorage keys are deliberately left UNCHANGED from the original site:
// this app and the standalone answer_logger site are both hosted under
// https://dmitry-goryunov.github.io (GitHub Pages project-page paths share
// one origin), so localStorage is already shared between them — keeping the
// same keys means the log is the same log in both places, not a separate
// copy.
//
// Added beyond the original: an "Email results" button (see the bottom of
// this file) that shares the exported CSV through the OS share sheet
// (attaching the actual file, where supported) with a mailto: fallback.
(() => {
  "use strict";

  const papers = [
    "ENGAA 2016 S1", "ENGAA 2017 S1", "ENGAA 2018 S1", "ENGAA 2019 S1",
    "ENGAA 2020 S1", "ENGAA 2021 S1", "ENGAA 2022 S1", "ENGAA 2023 S1",
    "NSAA 2016 S1", "NSAA 2017 S1", "NSAA 2018 S1", "NSAA 2019 S1",
    "NSAA 2020 S1", "NSAA 2021 S1", "NSAA 2022 S1", "NSAA 2023 S1",
    "PAT 2006", "PAT 2007", "PAT 2008", "PAT 2009", "PAT 2010", "PAT 2011",
    "PAT 2012", "PAT 2013", "PAT 2014", "PAT 2015", "PAT 2016", "PAT 2017",
    "PAT 2017 Specimen", "PAT 2018", "PAT 2019", "PAT 2020", "PAT 2021",
    "PAT 2022", "PAT 2023", "PAT 2024 Specimen",
    "MAT 2007", "MAT 2008", "MAT 2009", "MAT 2010", "MAT 2011", "MAT 2012",
    "MAT 2013", "MAT 2014", "MAT 2015", "MAT 2016", "MAT 2017", "MAT 2018",
    "MAT 2019", "MAT 2020", "MAT 2021", "MAT 2022",
    "TMUA 2016 Paper 1", "TMUA 2017 Paper 1", "TMUA 2018 Paper 1", "TMUA 2019 Paper 1",
    "TMUA 2020 Paper 1", "TMUA 2021 Paper 1", "TMUA 2022 Paper 1", "TMUA 2023 Paper 1",
    "TMUA Early Specimen Paper 1"
  ];

  const $ = (id) => document.getElementById(id);
  const paperInput = $("alPaper"), qFrom = $("alQuestionFrom"), qTo = $("alQuestionTo");
  $("alPaperList").replaceChildren(...papers.map((name) => new Option(name)));

  const STORE = "esat-answer-log", PAPER_KEY = "esat-last-paper";
  const readStore = (key, fallback) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
  const writeStore = (key, value) => { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } };

  paperInput.value = readStore(PAPER_KEY, "") || "";
  paperInput.addEventListener("change", () => writeStore(PAPER_KEY, paperInput.value.trim()));

  /* ---------- question labels (numbers 1,2,3… or letters A,B,C…) ---------- */
  const normaliseLabel = (value) => String(value ?? "").trim().toUpperCase();
  const isNumericLabel = (label) => /^\d+$/.test(label);
  const isAlphaLabel = (label) => /^[A-Z]+$/.test(label);

  function lettersToIndex(label) {
    let n = 0;
    for (const ch of label) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n;
  }
  function indexToLetters(index) {
    let label = "", n = index;
    while (n > 0) { const rest = (n - 1) % 26; label = String.fromCharCode(65 + rest) + label; n = Math.floor((n - 1) / 26); }
    return label;
  }
  function labelKey(label) {
    const l = normaliseLabel(label);
    if (isNumericLabel(l)) return [0, Number(l), ""];
    if (isAlphaLabel(l)) return [1, lettersToIndex(l), ""];
    return [2, 0, l];
  }
  function compareEntries(a, b) {
    const byPaper = a.paper.localeCompare(b.paper);
    if (byPaper) return byPaper;
    const ka = labelKey(a.question), kb = labelKey(b.question);
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2].localeCompare(kb[2]);
  }
  function nextLabel(label) {
    const l = normaliseLabel(label);
    if (isNumericLabel(l)) return String(Number(l) + 1);
    if (isAlphaLabel(l)) return indexToLetters(lettersToIndex(l) + 1);
    return null;
  }
  function buildRange(fromRaw, toRaw) {
    const from = normaliseLabel(fromRaw), to = normaliseLabel(toRaw);
    const span = (a, b, toLabel) => {
      if (b < a) return { error: "Check the question range: the second box must not come before the first." };
      if (b - a + 1 > 200) return { error: "That range is too large (200 questions max)." };
      return { labels: Array.from({ length: b - a + 1 }, (_, i) => toLabel(a + i)) };
    };
    if (!from || !to) return { error: "Fill in both question boxes." };
    if (isNumericLabel(from) && isNumericLabel(to)) {
      if (Number(from) < 1) return { error: "Question numbers start at 1." };
      return span(Number(from), Number(to), (n) => String(n));
    }
    if (isAlphaLabel(from) && isAlphaLabel(to)) return span(lettersToIndex(from), lettersToIndex(to), indexToLetters);
    if (from === to) return { labels: [from] };
    return { error: "Use numbers in both boxes (1 to 20) or letters in both (A to J)." };
  }

  /* ---------- data ---------- */
  let entries = loadEntries();
  let activeId = null, running = false, startedAt = 0, ticker = null, lastSaved = 0;
  const rowRefs = new Map();

  function loadEntries() {
    let raw = [];
    try { raw = JSON.parse(readStore(STORE, "[]")); } catch { raw = []; }
    if (!Array.isArray(raw)) raw = [];
    return raw.map((e) => ({
      id: e.id || newId(),
      paper: String(e.paper ?? ""),
      question: normaliseLabel(e.question),
      answer: String(e.answer ?? ""),
      notes: String(e.notes ?? ""),
      timeMs: Number(e.timeMs) || 0,
      recorded: e.recorded ?? Boolean(String(e.answer ?? "").trim()),
      recordedAt: e.recordedAt || e.timestamp || "",
      createdAt: e.createdAt || e.timestamp || new Date().toISOString()
    }));
  }
  function newId() {
    return crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
  function save() { writeStore(STORE, JSON.stringify(entries)); lastSaved = performance.now(); }
  const byId = (id) => entries.find((e) => e.id === id) || null;
  const activeEntry = () => (activeId ? byId(activeId) : null);

  const formatTime = (ms, tenths = true) => {
    const totalTenths = Math.floor(Math.max(0, ms) / 100);
    const mins = Math.floor(totalTenths / 600);
    const secs = Math.floor((totalTenths % 600) / 10);
    return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}${tenths ? `.${totalTenths % 10}` : ""}`;
  };

  /* ---------- clock (per highlighted question) ---------- */
  function flush() {
    if (!running) return;
    const now = performance.now(), entry = activeEntry();
    if (entry) entry.timeMs += now - startedAt;
    startedAt = now;
  }
  function startClock() {
    if (running || !activeEntry()) return;
    running = true; startedAt = performance.now();
    ticker = setInterval(tick, 100);
    paintTimer(); paintRow(activeId);
  }
  function stopClock() {
    if (!running) return;
    flush(); running = false;
    clearInterval(ticker); ticker = null;
    save(); paintTimer(); paintRow(activeId);
  }
  function tick() {
    flush();
    paintTimes(); paintTimer(); paintStats();
    if (performance.now() - lastSaved > 3000) save();
  }
  function resetActiveTime() {
    const entry = activeEntry();
    if (!entry) return;
    entry.timeMs = 0; startedAt = performance.now();
    save(); paintTimes(); paintTimer(); paintStats();
  }

  /* ---------- selection ---------- */
  function select(id) {
    if (activeId === id) { startClock(); return; }
    stopClock();
    const previous = activeId;
    activeId = id;
    if (previous) paintRow(previous);
    paintRow(id);
    startClock();
    paintTimer();
  }
  function deselect() {
    stopClock();
    const previous = activeId;
    activeId = null;
    if (previous) paintRow(previous);
    paintTimer();
  }

  /* ---------- rendering ---------- */
  function render() {
    rowRefs.clear();
    $("alEmptyState").hidden = entries.length > 0;
    $("alLogBody").replaceChildren(...entries.map(buildRow));
    paintTimes(); paintStats(); paintTimer();
  }

  function buildRow(entry) {
    const tr = document.createElement("tr");
    tr.dataset.id = entry.id;

    const paperCell = document.createElement("td");
    paperCell.className = "al-paper-cell";
    paperCell.textContent = entry.paper.replace(" Paper 1", " P1");
    paperCell.title = entry.paper;

    const qCell = document.createElement("td");
    qCell.className = "al-q-cell";
    qCell.textContent = entry.question;

    const answerCell = document.createElement("td");
    const answerInput = document.createElement("input");
    answerInput.type = "text"; answerInput.className = "al-cell-input al-answer-input";
    answerInput.value = entry.answer; answerInput.placeholder = "—";
    answerInput.setAttribute("aria-label", `Answer for question ${entry.question}`);
    answerInput.addEventListener("input", () => {
      entry.answer = answerInput.value;
      save(); refreshRecordButton(entry);
    });
    answerCell.append(answerInput);

    const notesCell = document.createElement("td");
    const notesInput = document.createElement("input");
    notesInput.type = "text"; notesInput.className = "al-cell-input al-notes-input";
    notesInput.value = entry.notes; notesInput.placeholder = "notes";
    notesInput.setAttribute("aria-label", `Notes for question ${entry.question}`);
    notesInput.addEventListener("input", () => { entry.notes = notesInput.value; save(); });
    notesCell.append(notesInput);

    const timeCell = document.createElement("td");
    timeCell.className = "al-time-cell";
    const totalCell = document.createElement("td");
    totalCell.className = "al-total-cell";

    const recordCell = document.createElement("td");
    const recordBtn = document.createElement("button");
    recordBtn.type = "button"; recordBtn.className = "al-record-btn";
    recordBtn.addEventListener("click", (event) => { event.stopPropagation(); recordToggle(entry); });
    // Do not let a mouse press focus the button: focus would highlight the row and start its clock.
    recordBtn.addEventListener("mousedown", (event) => event.preventDefault());
    recordCell.append(recordBtn);

    tr.append(paperCell, qCell, answerCell, notesCell, timeCell, totalCell, recordCell);
    tr.addEventListener("click", (event) => {
      if (event.target.closest("button")) return;
      if (event.target.closest("input")) { if (activeId !== entry.id) select(entry.id); return; }
      if (activeId === entry.id) { deselect(); return; }
      select(entry.id);
      answerInput.focus();
    });
    // Tab / Shift+Tab (and any other way focus reaches a row) moves the highlight too.
    tr.addEventListener("focusin", () => { if (activeId !== entry.id) select(entry.id); });

    rowRefs.set(entry.id, { tr, timeCell, totalCell, recordBtn, answerInput, notesInput });
    paintRow(entry.id);
    return tr;
  }

  function refreshRecordButton(entry) {
    const refs = rowRefs.get(entry.id);
    if (!refs) return;
    const ready = entry.answer.trim().length > 0;
    refs.recordBtn.textContent = entry.recorded ? "✓ Recorded" : "Record";
    refs.recordBtn.disabled = !entry.recorded && !ready;
    refs.recordBtn.title = entry.recorded
      ? "Recorded; click to unrecord and edit"
      : ready ? "Record question" : "Fill in the answer first";
  }

  function paintRow(id) {
    const entry = byId(id), refs = rowRefs.get(id);
    if (!entry || !refs) return;
    refs.tr.classList.toggle("al-recorded", Boolean(entry.recorded));
    refs.tr.classList.toggle("al-active", activeId === id);
    refs.tr.classList.toggle("al-counting", activeId === id && running);
    refreshRecordButton(entry);
  }

  function paintTimes() {
    let cumulative = 0;
    for (const entry of entries) {
      cumulative += entry.timeMs;
      const refs = rowRefs.get(entry.id);
      if (!refs) continue;
      refs.timeCell.textContent = formatTime(entry.timeMs, false);
      refs.totalCell.textContent = formatTime(cumulative, false);
    }
  }

  function paintTimer() {
    const entry = activeEntry();
    $("alTimerLabel").textContent = entry ? `TIME ON QUESTION ${entry.question}` : "NO QUESTION HIGHLIGHTED";
    $("alTimer").textContent = formatTime(entry ? entry.timeMs : 0);
    $("alStartPause").disabled = !entry;
    $("alResetTimer").disabled = !entry;
    $("alStartPause").textContent = !entry ? "Start timer" : running ? "Pause timer" : "Resume timer";
  }

  function paintStats() {
    $("alAttemptCount").textContent = entries.filter((e) => e.recorded).length;
    $("alTotalTime").textContent = formatTime(entries.reduce((sum, e) => sum + e.timeMs, 0), false);
  }

  function flash(message) {
    $("alStatus").textContent = message;
    clearTimeout(flash.handle);
    flash.handle = setTimeout(() => ($("alStatus").textContent = ""), 3000);
  }

  /* ---------- recording ---------- */
  function recordToggle(entry) {
    if (entry.recorded) {
      entry.recorded = false; entry.recordedAt = "";
      save(); paintRow(entry.id); paintStats();
      flash(`Question ${entry.question} unrecorded.`);
      return;
    }
    if (!entry.answer.trim()) { flash("Fill in the answer before recording."); return; }
    if (activeId === entry.id) deselect();
    entry.recorded = true; entry.recordedAt = new Date().toISOString();
    const stamp = formatTime(entry.timeMs, false);
    save(); paintRow(entry.id); paintStats();

    const next = nextUnrecorded(entry);
    if (next) {
      select(next.id);
      const refs = rowRefs.get(next.id);
      if (refs) {
        refs.tr.scrollIntoView({ block: "nearest" });
        refs.answerInput.focus();
      }
      flash(`Question ${entry.question} recorded at ${stamp}; now timing question ${next.question}.`);
    } else {
      flash(`Question ${entry.question} recorded at ${stamp}; every row is recorded.`);
    }
  }

  function nextUnrecorded(fromEntry) {
    const index = entries.indexOf(fromEntry);
    if (index < 0) return entries.find((e) => !e.recorded) || null;
    const order = [...entries.slice(index + 1), ...entries.slice(0, index)];
    return order.find((e) => !e.recorded) || null;
  }

  /* ---------- adding a question range ---------- */
  $("alRangeForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const paperName = paperInput.value.trim();
    if (!paperName) { flash("Type a paper name first."); return; }
    const range = buildRange(qFrom.value, qTo.value);
    if (range.error) { flash(range.error); return; }
    let added = 0, skipped = 0;
    for (const label of range.labels) {
      if (entries.some((x) => x.paper === paperName && x.question === label)) { skipped++; continue; }
      entries.push({
        id: newId(), paper: paperName, question: label, answer: "", notes: "",
        timeMs: 0, recorded: false, recordedAt: "", createdAt: new Date().toISOString()
      });
      added++;
    }
    entries.sort(compareEntries);
    writeStore(PAPER_KEY, paperName);
    save(); render();
    flash(added
      ? `Added ${added} question${added === 1 ? "" : "s"}${skipped ? `; ${skipped} already in the log` : ""}.`
      : "Those questions are already in the log.");
  });

  /* ---------- add a single extra line ---------- */
  $("alAddLine").addEventListener("click", () => {
    const typed = paperInput.value.trim();
    const last = entries[entries.length - 1];
    const paperName = typed || (last ? last.paper : "");
    if (!paperName) { flash("Type a paper name first."); return; }
    const group = entries.filter((e) => e.paper === paperName).sort(compareEntries);
    let nextQ;
    if (!group.length) {
      const seed = normaliseLabel(qFrom.value);
      nextQ = isNumericLabel(seed) || isAlphaLabel(seed) ? seed : "1";
    } else {
      nextQ = nextLabel(group[group.length - 1].question);
      if (!nextQ) { flash("Cannot work out the next question from the last row; add a range instead."); return; }
    }
    let guard = 0;
    while (entries.some((e) => e.paper === paperName && e.question === nextQ) && guard++ < 500) nextQ = nextLabel(nextQ);
    entries.push({
      id: newId(), paper: paperName, question: nextQ, answer: "", notes: "",
      timeMs: 0, recorded: false, recordedAt: "", createdAt: new Date().toISOString()
    });
    entries.sort(compareEntries);
    save(); render();
    const added = entries.find((e) => e.paper === paperName && e.question === nextQ);
    const refs = added ? rowRefs.get(added.id) : null;
    if (refs) refs.tr.scrollIntoView({ block: "nearest" });
    flash(`Added question ${nextQ} for ${paperName}.`);
  });

  /* ---------- timer buttons ---------- */
  $("alStartPause").addEventListener("click", () => { if (activeEntry()) running ? stopClock() : startClock(); });
  $("alResetTimer").addEventListener("click", resetActiveTime);

  /* ---------- CSV building (shared by export + email) ---------- */
  const csvCell = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  function buildCsv() {
    const header = ["Date and time recorded", "Paper", "Question Number", "Your Answer",
      "Time Taken (seconds)", "Time Taken (m:ss)", "Total Time (m:ss)", "Recorded", "Notes"];
    let runningTotal = 0;
    const rows = entries.map((e) => [
      e.recordedAt, e.paper, e.question, e.answer,
      (e.timeMs / 1000).toFixed(1), formatTime(e.timeMs, false),
      formatTime(runningTotal += e.timeMs, false), e.recorded ? "yes" : "no", e.notes
    ]);
    return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
  }
  function csvFilename() {
    return `ESAT-answer-log-${new Date().toISOString().slice(0, 10)}.csv`;
  }
  function downloadCsvBlob(blob, filename) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  /* ---------- export / clear ---------- */
  $("alExportCsv").addEventListener("click", () => {
    flush();
    const blob = new Blob(["﻿" + buildCsv()], { type: "text/csv;charset=utf-8" });
    downloadCsvBlob(blob, csvFilename());
  });

  $("alClearLog").addEventListener("click", () => {
    if (!confirm("Clear every saved row? This cannot be undone.")) return;
    deselect(); entries = []; save(); render();
  });

  /* ---------- email results ---------- */
  // No backend, so "email" is either: hand the CSV to the OS share sheet
  // (Android lets the user pick Gmail/Outlook/etc. with the file already
  // attached), or fall back to a mailto: draft with a text summary — mailto
  // can't attach a file, so the CSV is downloaded alongside it to attach by
  // hand. Either way this only opens a draft; the user decides to send it.
  $("alEmailResults").addEventListener("click", async () => {
    flush();
    if (!entries.length) { flash("Nothing to email yet — add and record some questions first."); return; }

    const filename = csvFilename();
    const csvBlob = new Blob(["﻿" + buildCsv()], { type: "text/csv;charset=utf-8" });
    const recordedCount = entries.filter((e) => e.recorded).length;
    const totalTimeText = formatTime(entries.reduce((sum, e) => sum + e.timeMs, 0), false);
    const subject = `ESAT Answer Log — ${new Date().toLocaleDateString()}`;
    const summary = `Answer log summary:\n${recordedCount} of ${entries.length} question(s) recorded\nTotal time: ${totalTimeText}`;

    let csvFile = null;
    try {
      csvFile = new File([csvBlob], filename, { type: "text/csv" });
    } catch {
      // File constructor unsupported in some very old WebViews — falls through to mailto below.
    }

    if (csvFile && navigator.canShare && navigator.canShare({ files: [csvFile] })) {
      try {
        await navigator.share({ files: [csvFile], title: subject, text: summary });
        flash("Share sheet opened — pick your email app to send it.");
        return;
      } catch (err) {
        if (err && err.name === "AbortError") return; // user cancelled the share sheet
        // any other failure falls through to the mailto fallback below
      }
    }

    // Fallback (desktop browsers, or share failed): download the CSV and
    // open a mailto draft explaining it needs attaching by hand.
    downloadCsvBlob(csvBlob, filename);
    const body = `${summary}\n\nYour browser can't attach files automatically — a copy named "${filename}" was just downloaded. Attach it to this email before sending.`;
    window.location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    flash(`Downloaded "${filename}" and opened an email draft — attach the file before sending.`);
  });

  /* ---------- persistence safety ---------- */
  const persist = () => { flush(); save(); };
  window.addEventListener("beforeunload", persist);
  window.addEventListener("pagehide", persist);
  document.addEventListener("visibilitychange", () => { if (document.hidden) persist(); });

  render();
})();
