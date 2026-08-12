(() => {
  "use strict";

  const CACHE_NAME = "physics-mcq-cache-v15"; // keep in sync with sw.js
  const PROGRESS_KEY = "physics_mcq_offline_progress_v1";
  const INCORRECT_KEY = "physics_mcq_offline_incorrect_v1";
  const OVERRIDES_KEY = "physics_mcq_offline_overrides_v1";
  const FLAGGED_KEY = "physics_mcq_offline_flagged_v1";
  const LOG_COLUMNS = ["topic", "question_number", "page", "correct_answer"];

  const els = {
    layout: document.querySelector(".layout"),
    sidebar: document.getElementById("sidebar"),
    main: document.getElementById("main"),
    progressTable: document.getElementById("progress-table"),
    banner: document.getElementById("offline-banner"),
  };

  /** @type {any} */
  let BANK = null;
  let TOPIC_NAMES = [];
  let TOPIC_TOTALS = new Map();
  let QUESTIONS_BY_TOPIC = new Map();
  let QUESTION_LOOKUP = new Map();
  let ASSET_MANIFEST = [];

  let completed = new Set(); // keys: `${topic} ${number}`
  let incorrectCounts = new Map(); // topic -> lifetime wrong-submission count
  let answerOverrides = new Map(); // key(topic, number) -> corrected answer letter
  let flagged = new Set(); // keys: key(topic, number), flagged for later review
  let deferredInstallPrompt = null;

  // Scratch pad canvas persists as a single DOM node moved between renders
  // (see mountScratchPad) so drawings survive re-renders within a question.
  let scratchCanvas = null;
  let scratchCtx = null;
  let scratchDrawing = false;
  let scratchLast = null;
  let scratchQuestionKey = null;
  let scratchLastRect = null; // {width, height} in CSS px, for resize detection
  let scratchManualHeight = null; // px height from dragging the resize handle; null = auto-match
  let scratchResizeObserver = null;
  let scratchIgnoreNextResize = false;
  let scratchResizeDebounce = null;

  // Question-image annotation canvas — same persistence pattern as the
  // scratch pad above, but drawn as a transparent overlay directly on top of
  // the question image so strokes annotate the diagram itself.
  let annotateCanvas = null;
  let annotateCtx = null;
  let annotateDrawing = false;
  let annotateLast = null;
  let annotateQuestionKey = null;
  let annotateLastRect = null;

  const state = {
    selectedTopic: null,
    mode: "count",
    count: 10,
    rangeFrom: 1,
    rangeTo: 1,
    confirmReset: false,
    showAllQuestions: false,
    orderMode: "ordered", // "ordered" | "section" | "all"
    sidebarCollapsed: true,
    quiz: null, // { keys: [[topic, number], ...], position, correct, submitted, feedback, selectedAnswer, showSolution, nonce }
    csvFile: null,
    csvMessage: null,
    offline: { total: 0, cached: 0, checking: true, downloading: false },
    questionZoom: 1,
    solutionZoom: 1,
    questionDrawMode: false,
    esatMode: true,
  };

  const ZOOM_LEVELS = [1, 1.25, 1.5, 1.75, 2];
  const BASE_IMAGE_HEIGHT = 300;

  const key = (topic, number) => `${topic} ${number}`;

  function rangeNumbers(start, end) {
    const numbers = [];
    for (let n = start; n <= end; n++) numbers.push(n);
    return numbers;
  }

  // Per-topic question numbers in scope for ESAT prep (mirrors quiz_core.py's
  // ESAT_TOPIC_RANGES). A topic absent or mapped to [] has no ESAT questions.
  const ESAT_TOPIC_RANGES = {
    Measurement: rangeNumbers(51, 55),
    Kinematics: rangeNumbers(1, 48),
    Dynamics: rangeNumbers(1, 50),
    Forces: rangeNumbers(1, 48),
    "Work, Energy, Power": rangeNumbers(1, 46),
    "Motion in a Circle": [],
    "Gravitational Field": [4, 7, 10, 14],
    Oscillations: [],
    "Thermal Physics": rangeNumbers(1, 70),
    "Wave Motion": rangeNumbers(1, 50),
    Superposition: rangeNumbers(1, 20),
    "Electric Fields": [],
    "Current of Electricity": rangeNumbers(1, 50),
    "D.C. Circuits": rangeNumbers(1, 35),
    Electromagnetism: rangeNumbers(1, 50),
    "Electromagnetic Induction": rangeNumbers(1, 40),
    "Alternating Currents": rangeNumbers(25, 35),
    "Quantum Physics": [],
    "Lasers and Semiconductors": [],
    "Nuclear Physics": rangeNumbers(1, 50),
  };

  // Intersected against real question numbers so a listed range that runs
  // past a topic's actual count is silently clamped, not pulled in anyway.
  function esatQuestionNumbers(topic) {
    const numbers = ESAT_TOPIC_RANGES[topic] || [];
    return new Set(numbers.filter((n) => QUESTION_LOOKUP.has(key(topic, n))));
  }

  function zoomBarHtml(action, current, extraButtonsHtml) {
    const options = ZOOM_LEVELS.map(
      (level) =>
        `<option value="${level}" ${level === current ? "selected" : ""}>${level}×</option>`
    ).join("");
    return `<div class="image-zoom-bar"><label>Zoom <select data-action="${action}">${options}</select></label>${
      extraButtonsHtml || ""
    }</div>`;
  }

  function zoomedImageBoxHtml(imgHtml, zoom, annotateMount) {
    const height = Math.round(BASE_IMAGE_HEIGHT * zoom);
    const overlayHtml = annotateMount
      ? `<div class="image-annotate-mount" data-mount="${annotateMount}"></div>`
      : "";
    return `<div class="image-zoom-wrap"><div class="resizable-image-box" style="width:${
      zoom * 100
    }%; height:${height}px;">${imgHtml}${overlayHtml}</div></div>`;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ---------- data loading ----------

  async function loadBank() {
    const response = await fetch("data/questions.json");
    BANK = await response.json();
    TOPIC_NAMES = BANK.topics.map((t) => t.name);
    TOPIC_TOTALS = new Map(BANK.topics.map((t) => [t.name, Number(t.count)]));
    QUESTIONS_BY_TOPIC = new Map(TOPIC_NAMES.map((name) => [name, []]));
    QUESTION_LOOKUP = new Map();
    for (const q of BANK.questions) {
      q.question_number = Number(q.question_number);
      q.page = Number(q.page);
      QUESTIONS_BY_TOPIC.get(q.topic).push(q);
      QUESTION_LOOKUP.set(key(q.topic, q.question_number), q);
    }
    for (const list of QUESTIONS_BY_TOPIC.values()) {
      list.sort((a, b) => a.question_number - b.question_number);
    }
  }

  async function loadAssetManifest() {
    try {
      const response = await fetch("asset-manifest.json");
      ASSET_MANIFEST = await response.json();
    } catch (err) {
      ASSET_MANIFEST = [];
    }
  }

  function loadProgress() {
    try {
      const raw = localStorage.getItem(PROGRESS_KEY);
      if (!raw) return new Set();
      const pairs = JSON.parse(raw);
      return new Set(pairs.map(([topic, number]) => key(topic, Number(number))));
    } catch (err) {
      return new Set();
    }
  }

  function saveProgress() {
    const pairs = Array.from(completed).map((k) => {
      const [topic, number] = k.split(" ");
      return [topic, Number(number)];
    });
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(pairs));
  }

  function loadIncorrectCounts() {
    try {
      const raw = localStorage.getItem(INCORRECT_KEY);
      if (!raw) return new Map();
      const obj = JSON.parse(raw);
      return new Map(
        Object.entries(obj).filter(([, count]) => Number.isInteger(count) && count > 0)
      );
    } catch (err) {
      return new Map();
    }
  }

  function saveIncorrectCounts() {
    const obj = Object.fromEntries(incorrectCounts);
    localStorage.setItem(INCORRECT_KEY, JSON.stringify(obj));
  }

  const VALID_ANSWERS = new Set(["A", "B", "C", "D"]);

  function loadAnswerOverrides() {
    try {
      const raw = localStorage.getItem(OVERRIDES_KEY);
      if (!raw) return new Map();
      const obj = JSON.parse(raw);
      return new Map(
        Object.entries(obj).filter(([, answer]) => VALID_ANSWERS.has(answer))
      );
    } catch (err) {
      return new Map();
    }
  }

  function saveAnswerOverrides() {
    const obj = Object.fromEntries(answerOverrides);
    localStorage.setItem(OVERRIDES_KEY, JSON.stringify(obj));
  }

  function loadFlags() {
    try {
      const raw = localStorage.getItem(FLAGGED_KEY);
      if (!raw) return new Set();
      const pairs = JSON.parse(raw);
      return new Set(pairs.map(([topic, number]) => key(topic, Number(number))));
    } catch (err) {
      return new Set();
    }
  }

  function saveFlags() {
    const pairs = Array.from(flagged).map((k) => {
      const [topic, number] = k.split(" ");
      return [topic, Number(number)];
    });
    localStorage.setItem(FLAGGED_KEY, JSON.stringify(pairs));
  }

  // ---------- domain logic (mirrors quiz_core.py) ----------

  function topicState() {
    return TOPIC_NAMES.map((topic) => {
      let total, correct;
      if (state.esatMode) {
        const numbers = esatQuestionNumbers(topic);
        total = numbers.size;
        correct = 0;
        for (const n of numbers) {
          if (completed.has(key(topic, n))) correct += 1;
        }
      } else {
        total = TOPIC_TOTALS.get(topic);
        correct = 0;
        for (const q of QUESTIONS_BY_TOPIC.get(topic)) {
          if (completed.has(key(topic, q.question_number))) correct += 1;
        }
      }
      const incorrect = incorrectCounts.get(topic) || 0;
      return { topic, correct, incorrect, unanswered: total - correct, total };
    });
  }

  function shuffleArray(arr) {
    const copy = arr.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  function selectUnanswered(topic, count, includeCompleted, randomize, esatOnly) {
    const allowed = esatOnly ? esatQuestionNumbers(topic) : null;
    let unanswered = QUESTIONS_BY_TOPIC.get(topic).filter(
      (q) =>
        (!allowed || allowed.has(q.question_number)) &&
        (includeCompleted || !completed.has(key(topic, q.question_number)))
    );
    if (randomize) unanswered = shuffleArray(unanswered);
    const n = Math.min(Math.max(0, count), unanswered.length);
    return unanswered.slice(0, n);
  }

  function selectUnansweredRange(topic, from, to, includeCompleted, randomize, esatOnly) {
    const low = Math.min(from, to);
    const high = Math.max(from, to);
    const allowed = esatOnly ? esatQuestionNumbers(topic) : null;
    let inRange = QUESTIONS_BY_TOPIC.get(topic).filter(
      (q) =>
        q.question_number >= low &&
        q.question_number <= high &&
        (!allowed || allowed.has(q.question_number)) &&
        (includeCompleted || !completed.has(key(topic, q.question_number)))
    );
    if (randomize) inRange = shuffleArray(inRange);
    return inRange;
  }

  function selectAllTopics(count, includeCompleted, esatOnly) {
    let pool = [];
    for (const topic of TOPIC_NAMES) {
      const allowed = esatOnly ? esatQuestionNumbers(topic) : null;
      for (const q of QUESTIONS_BY_TOPIC.get(topic)) {
        if (allowed && !allowed.has(q.question_number)) continue;
        if (includeCompleted || !completed.has(key(topic, q.question_number))) {
          pool.push(q);
        }
      }
    }
    pool = shuffleArray(pool);
    const n = Math.min(Math.max(0, count), pool.length);
    return pool.slice(0, n);
  }

  function topicBounds(topic, esatOnly) {
    if (esatOnly) {
      const numbers = Array.from(esatQuestionNumbers(topic)).sort((a, b) => a - b);
      if (!numbers.length) return [0, 0];
      return [numbers[0], numbers[numbers.length - 1]];
    }
    const list = QUESTIONS_BY_TOPIC.get(topic);
    return [list[0].question_number, list[list.length - 1].question_number];
  }

  // ---------- CSV (RFC4180-ish, compatible with quiz_core.py's csv module output) ----------

  function csvField(value) {
    const text = String(value);
    if (/[",\n\r]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  }

  function progressToCsv() {
    const rows = [LOG_COLUMNS.join(",")];
    for (const q of BANK.questions) {
      if (completed.has(key(q.topic, q.question_number))) {
        rows.push(
          [q.topic, q.question_number, q.page, q.correct_answer]
            .map(csvField)
            .join(",")
        );
      }
    }
    return rows.join("\r\n") + "\r\n";
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    let i = 0;
    const cleaned = text.replace(/^﻿/, "");
    while (i < cleaned.length) {
      const ch = cleaned[i];
      if (inQuotes) {
        if (ch === '"') {
          if (cleaned[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          inQuotes = false;
          i += 1;
          continue;
        }
        field += ch;
        i += 1;
        continue;
      }
      if (ch === '"') {
        inQuotes = true;
        i += 1;
        continue;
      }
      if (ch === ",") {
        row.push(field);
        field = "";
        i += 1;
        continue;
      }
      if (ch === "\r") {
        i += 1;
        continue;
      }
      if (ch === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
    }
    if (field.length > 0 || row.length > 0) {
      row.push(field);
      rows.push(row);
    }
    return rows.filter((r) => r.length > 1 || r[0] !== "");
  }

  function progressFromCsv(text) {
    const rows = parseCsv(text);
    if (rows.length === 0) return { imported: new Set(), rejected: 0 };
    const header = rows[0].map((h) => h.trim().toLowerCase());
    const topicIdx = header.indexOf("topic");
    const numberIdx = header.indexOf("question_number");
    const answerIdx = header.indexOf("correct_answer");

    const imported = new Set();
    let rejected = 0;
    for (const row of rows.slice(1)) {
      const topic = (row[topicIdx] || "").trim();
      const numberRaw = (row[numberIdx] || "").trim();
      const answer = (row[answerIdx] || "").trim().toUpperCase();
      const number = Number(numberRaw);
      if (!topic || !Number.isInteger(number) || !answer) {
        rejected += 1;
        continue;
      }
      const question = QUESTION_LOOKUP.get(key(topic, number));
      if (!question || question.correct_answer !== answer) {
        rejected += 1;
        continue;
      }
      imported.add(key(topic, number));
    }
    return { imported, rejected };
  }

  function downloadBlob(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // ---------- quiz state helpers ----------

  function clearQuiz() {
    state.quiz = null;
  }

  function startQuiz(topic, questions) {
    state.quiz = {
      keys: questions.map((q) => [q.topic, q.question_number]),
      topic,
      position: 0,
      correct: 0,
      submitted: false,
      feedback: null,
      wasNewCorrect: false,
      selectedAnswer: null,
      showSolution: false,
      nonce: Math.random().toString(36).slice(2),
    };
  }

  // ---------- scratch pad (touch/pen drawing under the solution) ----------

  function attachScratchListeners(canvas, ctx) {
    const pointerPos = (e) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    canvas.addEventListener("pointerdown", (e) => {
      scratchDrawing = true;
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch (err) {
        // Some browsers/input drivers reject capture for a given pointer id;
        // drawing still works without it, just less reliable outside bounds.
      }
      scratchLast = pointerPos(e);
      ctx.lineWidth = Math.max(1.2, (e.pressure || 0.5) * 3.5);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!scratchDrawing) return;
      const p = pointerPos(e);
      ctx.lineWidth = Math.max(1.2, (e.pressure || 0.5) * 3.5);
      ctx.beginPath();
      ctx.moveTo(scratchLast.x, scratchLast.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      scratchLast = p;
    });
    ["pointerup", "pointercancel", "pointerleave"].forEach((evt) =>
      canvas.addEventListener(evt, () => {
        scratchDrawing = false;
        scratchLast = null;
      })
    );
  }

  // The pad's height flexes to match the taller sibling column (e.g. when the
  // "answer key is wrong" button appears), so the canvas backing store must be
  // resized to match — preserving existing strokes by rescaling them, since a
  // plain width/height change would wipe the canvas.
  function resizeScratchCanvas(canvas, ctx, preserveContent) {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const newWidth = Math.max(1, Math.round(rect.width * dpr));
    const newHeight = Math.max(1, Math.round(rect.height * dpr));

    let snapshot = null;
    if (preserveContent && canvas.width > 0 && canvas.height > 0) {
      snapshot = document.createElement("canvas");
      snapshot.width = canvas.width;
      snapshot.height = canvas.height;
      snapshot.getContext("2d").drawImage(canvas, 0, 0);
    }

    canvas.width = newWidth;
    canvas.height = newHeight;
    ctx.scale(dpr, dpr);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#1a1a1a";

    if (snapshot) {
      ctx.drawImage(
        snapshot,
        0,
        0,
        snapshot.width,
        snapshot.height,
        0,
        0,
        newWidth,
        newHeight
      );
    }

    scratchLastRect = { width: rect.width, height: rect.height };
  }

  // Tracks the user dragging the CSS `resize: vertical` handle on .scratch-pad.
  // Programmatic height changes (auto-match) also fire ResizeObserver, so they
  // set scratchIgnoreNextResize first to avoid being mistaken for a manual drag.
  function setupScratchResizeObserver() {
    if (scratchResizeObserver) return;
    scratchResizeObserver = new ResizeObserver((entries) => {
      if (scratchIgnoreNextResize) {
        scratchIgnoreNextResize = false;
        return;
      }
      const entry = entries[0];
      if (!entry || entry.contentRect.height <= 0) return;
      scratchManualHeight = Math.round(entry.contentRect.height);
      if (scratchResizeDebounce) clearTimeout(scratchResizeDebounce);
      scratchResizeDebounce = setTimeout(() => {
        if (scratchCanvas && scratchCtx) {
          resizeScratchCanvas(scratchCanvas, scratchCtx, true);
        }
      }, 150);
    });
  }

  // The canvas element is created once and moved (not recreated) into each
  // render's placeholder, since re-parsing it via innerHTML would wipe it.
  function mountScratchPad(currentKey) {
    const mount = els.main.querySelector('[data-mount="scratch-pad"]');
    if (!mount) return;

    const isNew = !scratchCanvas;
    if (isNew) {
      scratchCanvas = document.createElement("canvas");
      scratchCanvas.className = "scratch-pad-canvas";
    }
    mount.appendChild(scratchCanvas);

    if (isNew) {
      scratchCtx = scratchCanvas.getContext("2d");
      attachScratchListeners(scratchCanvas, scratchCtx);
    }

    // Match the pad's height to the question column (e.g. so it reaches down
    // to "I'm right" when that button is showing) via an explicit px height —
    // grid/flex auto-sizing can't shrink this back down once grown, since a
    // flex-grow descendant makes the row's intrinsic size ambiguous. A manual
    // drag of the resize handle (bottom-right corner) overrides this until
    // the page reloads.
    const scratchPadEl = mount.closest(".scratch-pad");
    const columns = els.main.querySelectorAll(".quiz-body > div");
    if (scratchPadEl && columns.length === 2) {
      let targetHeight;
      if (scratchManualHeight != null) {
        targetHeight = scratchManualHeight;
      } else {
        const questionColumnHeight = columns[0].getBoundingClientRect().height;
        const offsetWithinColumn =
          scratchPadEl.getBoundingClientRect().top -
          columns[1].getBoundingClientRect().top;
        targetHeight = Math.max(220, questionColumnHeight - offsetWithinColumn);
      }
      scratchIgnoreNextResize = true;
      scratchPadEl.style.height = `${targetHeight}px`;
      setupScratchResizeObserver();
      scratchResizeObserver.disconnect();
      scratchResizeObserver.observe(scratchPadEl);
    }

    const isNewQuestion = currentKey !== scratchQuestionKey;
    scratchQuestionKey = currentKey;

    const rect = scratchCanvas.getBoundingClientRect();
    const sizeChanged =
      !scratchLastRect ||
      Math.abs(rect.width - scratchLastRect.width) > 0.5 ||
      Math.abs(rect.height - scratchLastRect.height) > 0.5;

    if (isNew || sizeChanged) {
      resizeScratchCanvas(scratchCanvas, scratchCtx, !isNew && !isNewQuestion);
    }

    if (isNewQuestion) {
      scratchCtx.clearRect(0, 0, scratchCanvas.width, scratchCanvas.height);
    }
  }

  // ---------- question-image annotation (draw directly on the question) ----------
  // Same canvas-persistence approach as the scratch pad above. Drawing is
  // opt-in (state.questionDrawMode) so the box's existing pinch/scroll-to-pan
  // behavior at higher zoom levels keeps working when the toggle is off.

  function attachAnnotateListeners(canvas, ctx) {
    const pointerPos = (e) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    canvas.addEventListener("pointerdown", (e) => {
      annotateDrawing = true;
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch (err) {
        // see attachScratchListeners
      }
      annotateLast = pointerPos(e);
      ctx.lineWidth = Math.max(1.2, (e.pressure || 0.5) * 3.5);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!annotateDrawing) return;
      const p = pointerPos(e);
      ctx.lineWidth = Math.max(1.2, (e.pressure || 0.5) * 3.5);
      ctx.beginPath();
      ctx.moveTo(annotateLast.x, annotateLast.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      annotateLast = p;
    });
    ["pointerup", "pointercancel", "pointerleave"].forEach((evt) =>
      canvas.addEventListener(evt, () => {
        annotateDrawing = false;
        annotateLast = null;
      })
    );
  }

  function resizeAnnotateCanvas(canvas, ctx, preserveContent) {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const newWidth = Math.max(1, Math.round(rect.width * dpr));
    const newHeight = Math.max(1, Math.round(rect.height * dpr));

    let snapshot = null;
    if (preserveContent && canvas.width > 0 && canvas.height > 0) {
      snapshot = document.createElement("canvas");
      snapshot.width = canvas.width;
      snapshot.height = canvas.height;
      snapshot.getContext("2d").drawImage(canvas, 0, 0);
    }

    canvas.width = newWidth;
    canvas.height = newHeight;
    ctx.scale(dpr, dpr);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#e11d48";

    if (snapshot) {
      ctx.drawImage(
        snapshot,
        0,
        0,
        snapshot.width,
        snapshot.height,
        0,
        0,
        newWidth,
        newHeight
      );
    }

    annotateLastRect = { width: rect.width, height: rect.height };
  }

  function mountAnnotateCanvas(currentKey) {
    const mount = els.main.querySelector('[data-mount="question-annotate"]');
    if (!mount) return;

    const isNew = !annotateCanvas;
    if (isNew) {
      annotateCanvas = document.createElement("canvas");
      annotateCanvas.className = "image-annotate-canvas";
    }
    mount.appendChild(annotateCanvas);

    if (isNew) {
      annotateCtx = annotateCanvas.getContext("2d");
      attachAnnotateListeners(annotateCanvas, annotateCtx);
    }

    annotateCanvas.style.pointerEvents = state.questionDrawMode ? "auto" : "none";
    annotateCanvas.style.touchAction = state.questionDrawMode ? "none" : "auto";
    annotateCanvas.style.cursor = state.questionDrawMode ? "crosshair" : "default";

    const isNewQuestion = currentKey !== annotateQuestionKey;
    annotateQuestionKey = currentKey;

    const rect = annotateCanvas.getBoundingClientRect();
    const sizeChanged =
      !annotateLastRect ||
      Math.abs(rect.width - annotateLastRect.width) > 0.5 ||
      Math.abs(rect.height - annotateLastRect.height) > 0.5;

    if (isNew || sizeChanged) {
      resizeAnnotateCanvas(annotateCanvas, annotateCtx, !isNew && !isNewQuestion);
    }

    if (isNewQuestion) {
      annotateCtx.clearRect(0, 0, annotateCanvas.width, annotateCanvas.height);
    }
  }

  // ---------- rendering ----------

  function render() {
    renderSidebar();
    renderMain();
    renderProgressTable();
  }

  function renderSidebar() {
    const states = topicState();
    const stateByTopic = new Map(states.map((s) => [s.topic, s]));
    const flaggedCount = flagged.size;
    const availableTopics = state.esatMode
      ? TOPIC_NAMES.filter((t) => stateByTopic.get(t).total > 0)
      : TOPIC_NAMES;
    if (!state.selectedTopic || !availableTopics.includes(state.selectedTopic)) {
      state.selectedTopic = availableTopics[0];
    }
    const current = stateByTopic.get(state.selectedTopic);
    const allSections = state.orderMode === "all";
    let poolSize;
    if (allSections) {
      const totalAll = TOPIC_NAMES.reduce(
        (sum, t) => sum + stateByTopic.get(t).total,
        0
      );
      const correctAll = TOPIC_NAMES.reduce(
        (sum, t) => sum + stateByTopic.get(t).correct,
        0
      );
      poolSize = state.showAllQuestions ? totalAll : totalAll - correctAll;
    } else {
      poolSize = state.showAllQuestions ? current.total : current.unanswered;
    }
    const maximum = Math.max(1, poolSize);
    const [minNumber, maxNumber] = topicBounds(state.selectedTopic, state.esatMode);
    const effectiveMode = allSections ? "count" : state.mode;

    if (state.count > maximum) state.count = Math.min(10, maximum);
    if (!state.rangeFromTouched) state.rangeFrom = minNumber;
    if (!state.rangeToTouched) state.rangeTo = maxNumber;

    let rangePool = poolSize;
    if (effectiveMode === "range") {
      const from = clamp(state.rangeFrom, minNumber, maxNumber);
      const to = clamp(state.rangeTo, minNumber, maxNumber);
      rangePool = selectUnansweredRange(
        state.selectedTopic,
        from,
        to,
        state.showAllQuestions,
        false,
        state.esatMode
      ).length;
    }

    const startDisabled =
      poolSize === 0 || (effectiveMode === "range" && rangePool === 0);

    const topicOptions = availableTopics.map(
      (name) =>
        `<option value="${escapeHtml(name)}" ${
          name === state.selectedTopic ? "selected" : ""
        }>${escapeHtml(name)}</option>`
    ).join("");

    const bodyHtml = state.sidebarCollapsed
      ? ""
      : `
      <label class="checkbox-row"><input type="checkbox" data-action="toggle-esat" ${
        state.esatMode ? "checked" : ""
      }/> ESAT-specific question set</label>
      <p class="caption">Limits topics, question pools, and every percentage below to the ESAT-relevant question subset.</p>

      <div class="field">
        <label for="topic-select">Topic</label>
        <select id="topic-select" data-action="select-topic">${topicOptions}</select>
      </div>

      <div class="progress-bar"><div class="progress-bar-fill" style="width:${
        current.total ? (current.correct / current.total) * 100 : 0
      }%"></div></div>
      <p class="caption">${current.correct} correct; ${current.incorrect} incorrect; ${
      current.unanswered
    } unanswered; ${current.total} total</p>

      <label class="checkbox-row"><input type="checkbox" data-action="toggle-show-all" ${
        state.showAllQuestions ? "checked" : ""
      }/> Show all questions (not just unanswered)</label>

      <div class="field">
        <label>Order</label>
        <div class="mode-row">
          <label><input type="radio" name="order" value="ordered" data-action="select-order" ${
            state.orderMode === "ordered" ? "checked" : ""
          }/> Ordered</label>
          <label><input type="radio" name="order" value="section" data-action="select-order" ${
            state.orderMode === "section" ? "checked" : ""
          }/> Random in this section</label>
          <label><input type="radio" name="order" value="all" data-action="select-order" ${
            state.orderMode === "all" ? "checked" : ""
          }/> Random in all sections</label>
        </div>
      </div>

      ${
        allSections
          ? `<p class="caption">Question range isn't available across all sections.</p>`
          : `<div class="field">
        <label>Select questions by</label>
        <div class="mode-row">
          <label><input type="radio" name="mode" value="count" data-action="select-mode" ${
            state.mode === "count" ? "checked" : ""
          }/> Count</label>
          <label><input type="radio" name="mode" value="range" data-action="select-mode" ${
            state.mode === "range" ? "checked" : ""
          }/> Question range</label>
        </div>
      </div>`
      }

      ${
        effectiveMode === "count"
          ? `<div class="field">
              <label for="count-input">Number of questions</label>
              <input type="number" id="count-input" data-action="count-input"
                min="1" max="${maximum}" step="1" value="${Math.min(
              state.count,
              maximum
            )}" ${poolSize === 0 ? "disabled" : ""}/>
            </div>`
          : `<div class="range-row">
              <div class="field">
                <label for="range-from">From question #</label>
                <input type="number" id="range-from" data-action="range-from"
                  min="${minNumber}" max="${maxNumber}" step="1" value="${clamp(
              state.rangeFrom,
              minNumber,
              maxNumber
            )}" ${poolSize === 0 ? "disabled" : ""}/>
              </div>
              <div class="field">
                <label for="range-to">To question #</label>
                <input type="number" id="range-to" data-action="range-to"
                  min="${minNumber}" max="${maxNumber}" step="1" value="${clamp(
              state.rangeTo,
              minNumber,
              maxNumber
            )}" ${poolSize === 0 ? "disabled" : ""}/>
              </div>
            </div>
            <p class="caption">${rangePool} ${
              state.showAllQuestions ? "question(s)" : "unanswered question(s)"
            } in that range.</p>`
      }

      <button class="btn btn-primary" data-action="start-quiz" ${
        startDisabled ? "disabled" : ""
      }>Start quiz</button>

      ${
        current.unanswered === 0
          ? `<p class="success-note" style="margin-top:0.8rem;">All questions in this topic are recorded as correct.</p>`
          : ""
      }

      <hr class="divider" />
      <h2>Flagged questions</h2>
      <p class="caption">${flaggedCount} question(s) flagged for review.</p>
      <button class="btn" data-action="review-flagged" ${
        flaggedCount === 0 ? "disabled" : ""
      }>Review flagged questions</button>

      <hr class="divider" />
      <h2>Topic reset</h2>
      <p class="caption">Removes recorded correct answers and the incorrect count for the selected topic.</p>
      <label class="checkbox-row"><input type="checkbox" data-action="confirm-reset" ${
        state.confirmReset ? "checked" : ""
      }/> Confirm reset</label>
      <button class="btn" data-action="reset-topic" ${
        !state.confirmReset || (current.correct === 0 && current.incorrect === 0)
          ? "disabled"
          : ""
      }>Reset this topic</button>

      <hr class="divider" />
      <h2>Correct-answer log</h2>
      <button class="btn" data-action="download-csv">Download CSV log</button>
      <div style="margin-top:0.8rem;">
        <input class="file-input" type="file" accept=".csv" data-action="csv-file" />
        <button class="btn" data-action="import-csv" ${
          state.csvFile ? "" : "disabled"
        }>Import log</button>
      </div>
      ${
        state.csvMessage
          ? `<p class="success-note" style="margin-top:0.6rem;">${escapeHtml(
              state.csvMessage
            )}</p>`
          : ""
      }

      <hr class="divider" />
      <h2>Offline access</h2>
      ${renderOfflineSection()}

      <p class="caption" style="margin-top:1rem;">
        Progress is stored only on this device (browser local storage). Download the
        CSV log as a portable backup, or import it on another device.
      </p>
    `;

    els.sidebar.innerHTML = `
      <div class="sidebar-header">
        <h2>Quiz setup</h2>
        <button type="button" class="sidebar-toggle" data-action="toggle-sidebar" aria-label="${
          state.sidebarCollapsed ? "Expand" : "Collapse"
        } quiz setup">${state.sidebarCollapsed ? "▸" : "▾"}</button>
      </div>
      ${bodyHtml}
    `;
    if (els.layout) {
      els.layout.classList.toggle("sidebar-collapsed", state.sidebarCollapsed);
    }
  }

  function renderOfflineSection() {
    const { total, cached, checking, downloading } = state.offline;
    const ready = total > 0 && cached >= total;
    let statusHtml;
    if (checking) {
      statusHtml = `<p class="caption">Checking offline cache…</p>`;
    } else if (ready) {
      statusHtml = `<p class="success-note">All question images are cached for offline use.</p>`;
    } else if (downloading) {
      const pct = total ? Math.round((cached / total) * 100) : 0;
      statusHtml = `
        <div class="offline-progress">
          <div class="progress-bar"><div class="progress-bar-fill" style="width:${pct}%"></div></div>
          <p class="caption">Caching images for offline use… ${cached} / ${total}</p>
        </div>`;
    } else {
      statusHtml = `<p class="caption">${cached} / ${total} images cached.</p>
        <button class="btn btn-primary" data-action="download-offline">Download for offline use</button>`;
    }

    const installHtml = deferredInstallPrompt
      ? `<button class="btn" style="margin-top:0.6rem;" data-action="install-app">Install app</button>`
      : "";

    return statusHtml + installHtml;
  }

  function clamp(value, min, max) {
    const n = Number.isFinite(value) ? value : min;
    return Math.min(Math.max(n, min), max);
  }

  function renderMain() {
    const quiz = state.quiz;
    if (!quiz) {
      els.main.innerHTML = `<div class="empty-state">Choose a topic and number of questions in the sidebar, then start a quiz.</div>`;
      return;
    }

    if (quiz.position >= quiz.keys.length) {
      els.main.innerHTML = `
        <div class="success-note" style="font-size:1rem;">
          Quiz complete. ${quiz.correct} of ${quiz.keys.length} questions were newly recorded as correct.
        </div>
        <button class="btn btn-primary" style="margin-top:1rem; width:auto; padding-left:1.5rem; padding-right:1.5rem;" data-action="choose-another-quiz">Choose another quiz</button>
      `;
      return;
    }

    const [topic, number] = quiz.keys[quiz.position];
    const question = QUESTION_LOOKUP.get(key(topic, number));
    const isLast = quiz.position + 1 >= quiz.keys.length;
    const choices = ["A", "B", "C", "D"];
    const isFlagged = flagged.has(key(topic, number));

    const questionAnnotateButtons = `
      <button type="button" class="btn image-annotate-toggle" data-action="toggle-question-draw" style="${
        state.questionDrawMode
          ? "background:var(--primary); border-color:var(--primary); color:#fff;"
          : ""
      }">${state.questionDrawMode ? "✏️ Drawing on" : "✏️ Draw"}</button>
      <button type="button" class="btn image-annotate-clear" data-action="clear-question-annotate">Clear</button>
    `;

    els.main.innerHTML = `
      <div class="quiz-header">
        <div>
          <h2>${escapeHtml(topic)} · Question ${number}</h2>
          <div class="question-meta">Question ${quiz.position + 1} of ${quiz.keys.length}</div>
        </div>
        <div class="metric">
          <div class="value">${quiz.correct}</div>
          <div class="label">Correct this quiz</div>
          <button type="button" class="btn flag-toggle ${
            isFlagged ? "flag-toggle-active" : ""
          }" data-action="toggle-flag">${
      isFlagged ? "🚩 Flagged" : "🏳️ Flag question"
    }</button>
        </div>
      </div>
      <div class="progress-bar"><div class="progress-bar-fill" style="width:${
        ((quiz.position + 1) / quiz.keys.length) * 100
      }%"></div></div>

      <div class="quiz-body">
        <div>
          ${zoomBarHtml("zoom-question", state.questionZoom, questionAnnotateButtons)}
          ${zoomedImageBoxHtml(
            `<img class="question-image" src="img/${question.page}_q.webp" alt="Question ${number}" />`,
            state.questionZoom,
            "question-annotate"
          )}

          <div class="answer-choices">
            ${choices
              .map(
                (choice) => `
              <div class="answer-choice">
                <input type="radio" id="choice-${choice}" name="answer" value="${choice}"
                  data-action="choose-answer"
                  ${quiz.selectedAnswer === choice ? "checked" : ""}
                  ${quiz.submitted ? "disabled" : ""}/>
                <label for="choice-${choice}">${choice}</label>
              </div>`
              )
              .join("")}
          </div>

          <div class="btn-row">
            <button class="btn btn-primary" data-action="submit-answer" ${
              quiz.selectedAnswer === null || quiz.submitted ? "disabled" : ""
            }>Submit answer</button>
            <button class="btn" data-action="next-question" ${
              quiz.submitted ? "" : "disabled"
            }>${isLast ? "Finish quiz" : "Next question"}</button>
          </div>

          ${
            quiz.feedback
              ? `<div class="feedback feedback-${quiz.feedback.kind}">${escapeHtml(
                  quiz.feedback.text
                )}</div>`
              : ""
          }
          ${
            quiz.feedback && quiz.feedback.kind === "error"
              ? `<button type="button" class="btn" style="margin-top:0.6rem;" data-action="override-answer">I'm right — the answer key is wrong (mark ${escapeHtml(
                  quiz.selectedAnswer
                )} as correct)</button>`
              : ""
          }
          ${
            quiz.feedback
              ? `<button type="button" class="btn" style="margin-top:0.6rem;" data-action="undo-answer">Undo — let me answer again</button>`
              : ""
          }
        </div>

        <div>
          <button class="btn solution-toggle" data-action="toggle-solution">${
            quiz.showSolution ? "Hide solution" : "Show solution"
          }</button>
          ${
            quiz.showSolution
              ? zoomBarHtml("zoom-solution", state.solutionZoom) +
                zoomedImageBoxHtml(
                  `<img class="solution-image" src="img/${question.page}_s.webp" alt="Solution ${number}" />`,
                  state.solutionZoom
                )
              : `<div class="solution-placeholder">Tap <strong>Show solution</strong> to reveal the source answer page.</div>`
          }
          ${
            answerOverrides.has(key(topic, number))
              ? `<p class="caption" style="margin-top:0.5rem;">Note: you've corrected this question's answer key to <strong>${escapeHtml(
                  answerOverrides.get(key(topic, number))
                )}</strong> (overrides the answer shown in the solution image above).</p>`
              : ""
          }

          <div class="scratch-pad">
            <div class="scratch-pad-header">
              <span>Scratch pad</span>
              <button type="button" class="btn scratch-pad-clear" data-action="clear-scratch-pad">Clear</button>
            </div>
            <div class="scratch-pad-mount" data-mount="scratch-pad"></div>
          </div>
        </div>
      </div>
    `;

    mountScratchPad(key(topic, number));
    mountAnnotateCanvas(key(topic, number));
  }

  function renderProgressTable() {
    const allStates = topicState();
    const states = state.esatMode
      ? allStates.filter((s) => s.total > 0)
      : allStates;
    const allTopicsRow = {
      topic: "All topics",
      correct: states.reduce((sum, s) => sum + s.correct, 0),
      incorrect: states.reduce((sum, s) => sum + s.incorrect, 0),
      unanswered: states.reduce((sum, s) => sum + s.unanswered, 0),
      total: states.reduce((sum, s) => sum + s.total, 0),
    };

    const rowHtml = (s, isTotal) => {
      const pct = s.total ? Math.round((s.correct / s.total) * 100) : 0;
      return `<tr class="${isTotal ? "progress-table-total" : ""}">
        <td>${escapeHtml(s.topic)}</td>
        <td>${s.correct}</td>
        <td>${s.incorrect}</td>
        <td>${s.unanswered}</td>
        <td>${s.total}</td>
        <td>
          <div class="progress-table-pct">
            <div class="progress-bar"><div class="progress-bar-fill" style="width:${pct}%"></div></div>
            <span>${pct}%</span>
          </div>
        </td>
      </tr>`;
    };

    const rows =
      rowHtml(allTopicsRow, true) + states.map((s) => rowHtml(s, false)).join("");
    els.progressTable.innerHTML = `
      <table class="progress-table">
        <thead><tr><th>Topic</th><th>Correct</th><th>Incorrect</th><th>Unanswered</th><th>Total</th><th>% Complete</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  function showBanner(kind, text, autoHideMs) {
    els.banner.className = `banner banner-${kind}`;
    els.banner.textContent = text;
    if (autoHideMs) {
      setTimeout(() => {
        els.banner.className = "banner banner-hidden";
      }, autoHideMs);
    }
  }

  // ---------- event handling ----------

  document.addEventListener("change", (event) => {
    const action = event.target.dataset.action;
    if (!action) return;

    switch (action) {
      case "select-topic":
        state.selectedTopic = event.target.value;
        state.rangeFromTouched = false;
        state.rangeToTouched = false;
        render();
        break;
      case "select-mode":
        state.mode = event.target.value;
        render();
        break;
      case "count-input":
        state.count = clamp(parseInt(event.target.value, 10), 1, 100000);
        render();
        break;
      case "range-from":
        state.rangeFrom = parseInt(event.target.value, 10);
        state.rangeFromTouched = true;
        render();
        break;
      case "range-to":
        state.rangeTo = parseInt(event.target.value, 10);
        state.rangeToTouched = true;
        render();
        break;
      case "confirm-reset":
        state.confirmReset = event.target.checked;
        render();
        break;
      case "toggle-show-all":
        state.showAllQuestions = event.target.checked;
        render();
        break;
      case "toggle-esat":
        state.esatMode = event.target.checked;
        state.rangeFromTouched = false;
        state.rangeToTouched = false;
        render();
        break;
      case "select-order":
        state.orderMode = event.target.value;
        render();
        break;
      case "choose-answer":
        if (state.quiz && !state.quiz.submitted) {
          state.quiz.selectedAnswer = event.target.value;
          render();
        }
        break;
      case "csv-file":
        state.csvFile = event.target.files[0] || null;
        render();
        break;
      case "zoom-question":
        state.questionZoom = parseFloat(event.target.value) || 1;
        render();
        break;
      case "zoom-solution":
        state.solutionZoom = parseFloat(event.target.value) || 1;
        render();
        break;
      default:
        break;
    }
  });

  document.addEventListener("click", (event) => {
    const action = event.target.dataset.action;
    if (!action) return;

    switch (action) {
      case "start-quiz": {
        const [minNumber, maxNumber] = topicBounds(state.selectedTopic, state.esatMode);
        const randomize = state.orderMode !== "ordered";
        let selected;
        if (state.orderMode === "all") {
          selected = selectAllTopics(state.count, state.showAllQuestions, state.esatMode);
        } else if (state.mode === "count") {
          selected = selectUnanswered(
            state.selectedTopic,
            state.count,
            state.showAllQuestions,
            randomize,
            state.esatMode
          );
        } else {
          const from = clamp(state.rangeFrom, minNumber, maxNumber);
          const to = clamp(state.rangeTo, minNumber, maxNumber);
          selected = selectUnansweredRange(
            state.selectedTopic,
            from,
            to,
            state.showAllQuestions,
            randomize,
            state.esatMode
          );
        }
        startQuiz(state.selectedTopic, selected);
        state.sidebarCollapsed = true;
        render();
        break;
      }
      case "review-flagged": {
        const flaggedQuestions = [];
        for (const topic of TOPIC_NAMES) {
          for (const q of QUESTIONS_BY_TOPIC.get(topic)) {
            if (flagged.has(key(topic, q.question_number))) flaggedQuestions.push(q);
          }
        }
        startQuiz(null, flaggedQuestions);
        state.sidebarCollapsed = true;
        render();
        break;
      }
      case "reset-topic": {
        const topic = state.selectedTopic;
        let removed = 0;
        for (const k of Array.from(completed)) {
          if (k.startsWith(topic + " ")) {
            completed.delete(k);
            removed += 1;
          }
        }
        saveProgress();
        incorrectCounts.delete(topic);
        saveIncorrectCounts();
        state.confirmReset = false;
        if (state.quiz && state.quiz.topic === topic) clearQuiz();
        showBanner("success", `Removed ${removed} recorded answer(s) from ${topic}.`, 4000);
        render();
        break;
      }
      case "download-csv":
        downloadBlob("correct_answers.csv", progressToCsv(), "text/csv");
        break;
      case "import-csv": {
        if (!state.csvFile) break;
        const reader = new FileReader();
        reader.onload = () => {
          const { imported, rejected } = progressFromCsv(String(reader.result));
          completed = imported;
          saveProgress();
          clearQuiz();
          state.csvMessage = `Imported ${imported.size} correct answer(s).${
            rejected ? ` Rejected ${rejected} invalid row(s).` : ""
          }`;
          state.csvFile = null;
          render();
        };
        reader.readAsText(state.csvFile);
        break;
      }
      case "submit-answer": {
        const quiz = state.quiz;
        if (!quiz || quiz.selectedAnswer === null || quiz.submitted) break;
        const [topic, number] = quiz.keys[quiz.position];
        const question = QUESTION_LOOKUP.get(key(topic, number));
        const k = key(topic, number);
        const effectiveAnswer = answerOverrides.get(k) || question.correct_answer;
        const isCorrect = quiz.selectedAnswer === effectiveAnswer;
        quiz.submitted = true;
        if (isCorrect) {
          const wasNew = !completed.has(k);
          completed.add(k);
          saveProgress();
          if (wasNew) quiz.correct += 1;
          quiz.wasNewCorrect = wasNew;
          quiz.feedback = {
            kind: "success",
            text: `Correct. The answer is ${effectiveAnswer}.`,
          };
        } else {
          incorrectCounts.set(topic, (incorrectCounts.get(topic) || 0) + 1);
          saveIncorrectCounts();
          quiz.wasNewCorrect = false;
          quiz.feedback = {
            kind: "error",
            text: "Incorrect. This question was not recorded and remains unanswered.",
          };
        }
        render();
        break;
      }
      case "override-answer": {
        const quiz = state.quiz;
        if (!quiz || !quiz.submitted || !quiz.feedback || quiz.feedback.kind !== "error") {
          break;
        }
        const [topic, number] = quiz.keys[quiz.position];
        const k = key(topic, number);
        answerOverrides.set(k, quiz.selectedAnswer);
        saveAnswerOverrides();
        const wasNew = !completed.has(k);
        completed.add(k);
        saveProgress();
        if (wasNew) quiz.correct += 1;
        quiz.wasNewCorrect = wasNew;
        quiz.feedback = {
          kind: "success",
          text: `Marked as correct. The answer key for this question has been corrected to ${quiz.selectedAnswer}.`,
        };
        render();
        break;
      }
      case "undo-answer": {
        const quiz = state.quiz;
        if (!quiz || !quiz.submitted) break;
        if (quiz.wasNewCorrect) {
          const [topic, number] = quiz.keys[quiz.position];
          const k = key(topic, number);
          completed.delete(k);
          saveProgress();
          quiz.correct = Math.max(0, quiz.correct - 1);
        }
        quiz.submitted = false;
        quiz.feedback = null;
        quiz.wasNewCorrect = false;
        render();
        break;
      }
      case "next-question": {
        const quiz = state.quiz;
        if (!quiz || !quiz.submitted) break;
        quiz.position += 1;
        quiz.submitted = false;
        quiz.feedback = null;
        quiz.wasNewCorrect = false;
        quiz.selectedAnswer = null;
        quiz.showSolution = false;
        render();
        break;
      }
      case "toggle-solution":
        if (state.quiz) {
          state.quiz.showSolution = !state.quiz.showSolution;
          render();
        }
        break;
      case "choose-another-quiz":
        clearQuiz();
        render();
        break;
      case "clear-scratch-pad":
        if (scratchCtx && scratchCanvas) {
          scratchCtx.clearRect(0, 0, scratchCanvas.width, scratchCanvas.height);
        }
        break;
      case "toggle-question-draw":
        state.questionDrawMode = !state.questionDrawMode;
        render();
        break;
      case "toggle-flag": {
        const quiz = state.quiz;
        if (!quiz) break;
        const [topic, number] = quiz.keys[quiz.position];
        const k = key(topic, number);
        if (flagged.has(k)) {
          flagged.delete(k);
        } else {
          flagged.add(k);
        }
        saveFlags();
        render();
        break;
      }
      case "clear-question-annotate":
        if (annotateCtx && annotateCanvas) {
          annotateCtx.clearRect(0, 0, annotateCanvas.width, annotateCanvas.height);
        }
        break;
      case "download-offline":
        downloadForOffline();
        break;
      case "install-app":
        installApp();
        break;
      case "toggle-sidebar":
        state.sidebarCollapsed = !state.sidebarCollapsed;
        renderSidebar();
        break;
      default:
        break;
    }
  });

  // ---------- offline caching ----------

  async function refreshOfflineStatus() {
    state.offline.total = ASSET_MANIFEST.length;
    if (!("caches" in window) || ASSET_MANIFEST.length === 0) {
      state.offline.checking = false;
      renderSidebar();
      return;
    }
    try {
      const cache = await caches.open(CACHE_NAME);
      const keys = await cache.keys();
      const cachedUrls = new Set(keys.map((r) => new URL(r.url).pathname.split("/").pop()));
      let cachedCount = 0;
      for (const path of ASSET_MANIFEST) {
        const filename = path.split("/").pop();
        if (cachedUrls.has(filename)) cachedCount += 1;
      }
      state.offline.cached = cachedCount;
    } catch (err) {
      // ignore
    }
    state.offline.checking = false;
    renderSidebar();
  }

  async function downloadForOffline() {
    if (!("caches" in window) || state.offline.downloading) return;
    state.offline.downloading = true;
    renderSidebar();

    const cache = await caches.open(CACHE_NAME);
    const CONCURRENCY = 8;
    let index = 0;
    let cached = state.offline.cached;
    let lastRender = 0;

    async function worker() {
      while (index < ASSET_MANIFEST.length) {
        const path = ASSET_MANIFEST[index];
        index += 1;
        try {
          const existing = await cache.match(path);
          if (!existing) {
            const response = await fetch(path);
            if (response.ok) await cache.put(path, response);
          }
        } catch (err) {
          // skip failed asset, continue
        }
        cached += 1;
        state.offline.cached = cached;
        const now = Date.now();
        if (now - lastRender > 200) {
          lastRender = now;
          renderSidebar();
        }
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    state.offline.downloading = false;
    renderSidebar();
    showBanner("success", "Offline content ready. You can now use this app without a network connection.", 5000);
  }

  function installApp() {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    deferredInstallPrompt.userChoice.finally(() => {
      deferredInstallPrompt = null;
      renderSidebar();
    });
  }

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    renderSidebar();
  });

  // ---------- boot ----------

  async function boot() {
    completed = loadProgress();
    incorrectCounts = loadIncorrectCounts();
    answerOverrides = loadAnswerOverrides();
    flagged = loadFlags();
    await Promise.all([loadBank(), loadAssetManifest()]);
    state.selectedTopic = TOPIC_NAMES[0];
    render();
    refreshOfflineStatus();

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
  }

  boot();
})();
