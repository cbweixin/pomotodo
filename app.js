"use strict";

(() => {
  const STORAGE_KEYS = Object.freeze({
    sessions: "pomotodo:sessions:v1",
    active: "pomotodo:active:v1",
    prefs: "pomotodo:prefs:v1",
  });

  const WORKS_PER_CYCLE = 4;
  const LONG_BREAK_MINUTES = 20;

  const PRESETS = Object.freeze({
    "25_5": { presetKey: "25_5", workMinutes: 25, shortBreakMinutes: 5 },
    "30_5": { presetKey: "30_5", workMinutes: 30, shortBreakMinutes: 5 },
    "45_10": { presetKey: "45_10", workMinutes: 45, shortBreakMinutes: 10 },
    "60_10": { presetKey: "60_10", workMinutes: 60, shortBreakMinutes: 10 },
  });

  const PHASE_LABELS = Object.freeze({
    work: "Work",
    short_break: "Short Rest",
    long_break: "Long Rest",
  });

  const dom = {
    statusLine: document.getElementById("statusLine"),
    presetGroup: document.getElementById("presetGroup"),
    timeDisplay: document.getElementById("timeDisplay"),
    phaseValue: document.getElementById("phaseValue"),
    cycleValue: document.getElementById("cycleValue"),
    workValue: document.getElementById("workValue"),
    nextValue: document.getElementById("nextValue"),
    startBtn: document.getElementById("startBtn"),
    pauseBtn: document.getElementById("pauseBtn"),
    resetBtn: document.getElementById("resetBtn"),
    exportBtn: document.getElementById("exportBtn"),
    clearBtn: document.getElementById("clearBtn"),
    note: document.getElementById("note"),
    todayTotals: document.getElementById("todayTotals"),
    allTotals: document.getElementById("allTotals"),
    recentBody: document.getElementById("recentBody"),
    descModalBackdrop: document.getElementById("descModalBackdrop"),
    descInput: document.getElementById("descInput"),
    descSaveBtn: document.getElementById("descSaveBtn"),
    descSkipBtn: document.getElementById("descSkipBtn"),
  };

  /** @type {Array<any>} */
  let sessions = [];
  /** @type {any | null} */
  let activeState = null;
  /** @type {any} */
  let prefs = { selectedPresetKey: "25_5" };

  /** @type {number | null} */
  let uiTimerId = null;
  /** @type {AudioContext | null} */
  let audioCtx = null;
  /** @type {boolean} */
  let audioUnlocked = false;
  /** @type {string | null} */
  let pendingWorkDescriptionId = null;
  const DEFAULT_WORK_DESCRIPTION = "working....";

  function showNote(message, kind = "info") {
    if (!dom.note) return;
    dom.note.textContent = message || "";
    dom.note.classList.toggle("error", kind === "error");
  }

  function safeJsonParse(text, fallbackValue) {
    try {
      return JSON.parse(text);
    } catch {
      return fallbackValue;
    }
  }

  function loadStorage(key, fallbackValue) {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return fallbackValue;
      return safeJsonParse(raw, fallbackValue);
    } catch {
      return fallbackValue;
    }
  }

  function saveStorage(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function removeStorage(key) {
    localStorage.removeItem(key);
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function formatMMSS(totalSeconds) {
    const seconds = Math.max(0, Math.floor(totalSeconds));
    const mm = Math.floor(seconds / 60);
    const ss = seconds % 60;
    return `${pad2(mm)}:${pad2(ss)}`;
  }

  function formatHhMmFromSeconds(totalSeconds) {
    const seconds = Math.max(0, Math.floor(totalSeconds));
    const hh = Math.floor(seconds / 3600);
    const mm = Math.floor((seconds % 3600) / 60);
    if (hh <= 0) return `${mm}m`;
    return `${hh}h ${mm}m`;
  }

  function formatLocalDateTime(isoString) {
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return isoString;
    return d.toLocaleString();
  }

  function getPreset(presetKey) {
    return PRESETS[presetKey] || PRESETS["25_5"];
  }

  function getSelectedPresetKeyFromUI() {
    const checked = dom.presetGroup?.querySelector('input[name="preset"]:checked');
    return checked?.value || prefs.selectedPresetKey || "25_5";
  }

  function setSelectedPresetKeyInUI(presetKey) {
    const input = dom.presetGroup?.querySelector(`input[name="preset"][value="${presetKey}"]`);
    if (input) input.checked = true;
  }

  function setPresetInputsDisabled(disabled) {
    const inputs = dom.presetGroup?.querySelectorAll('input[name="preset"]') || [];
    for (const input of inputs) {
      input.disabled = disabled;
    }
  }

  function phasePlannedSeconds(phaseType, presetKey) {
    const preset = getPreset(presetKey);
    if (phaseType === "work") return preset.workMinutes * 60;
    if (phaseType === "short_break") return preset.shortBreakMinutes * 60;
    return LONG_BREAK_MINUTES * 60;
  }

  function buildNextPhaseInfo(state) {
    const preset = getPreset(state.presetKey);
    if (state.phaseType === "work") {
      if (state.workIndex < WORKS_PER_CYCLE) {
        return {
          phaseType: "short_break",
          cycleNumber: state.cycleNumber,
          workIndex: state.workIndex,
          plannedSeconds: preset.shortBreakMinutes * 60,
        };
      }
      return {
        phaseType: "long_break",
        cycleNumber: state.cycleNumber,
        workIndex: null,
        plannedSeconds: LONG_BREAK_MINUTES * 60,
      };
    }

    if (state.phaseType === "short_break") {
      return {
        phaseType: "work",
        cycleNumber: state.cycleNumber,
        workIndex: Math.min(WORKS_PER_CYCLE, state.workIndex + 1),
        plannedSeconds: preset.workMinutes * 60,
      };
    }

    return {
      phaseType: "work",
      cycleNumber: state.cycleNumber + 1,
      workIndex: 1,
      plannedSeconds: preset.workMinutes * 60,
    };
  }

  function makeId() {
    const rand = Math.random().toString(16).slice(2);
    return `${Date.now()}-${rand}`;
  }

  function startPhase({ phaseType, cycleNumber, workIndex, presetKey, plannedSeconds, startAtMs }) {
    const startedAtMs = typeof startAtMs === "number" ? startAtMs : Date.now();
    const id = makeId();
    activeState = {
      status: "running",
      presetKey,
      cycleNumber,
      workIndex,
      phaseType,
      phasePlannedSeconds: plannedSeconds,
      phaseStartedAtMs: startedAtMs,
      phaseEndsAtMs: startedAtMs + plannedSeconds * 1000,
      pausedAtMs: null,
      pausedTotalMs: 0,
      pausedRemainingMs: null,
      phaseId: id,
    };
    persistActiveState();
  }

  function setReadyPhase({ phaseType, cycleNumber, workIndex, presetKey, plannedSeconds }) {
    activeState = {
      status: "ready",
      presetKey,
      cycleNumber,
      workIndex,
      phaseType,
      phasePlannedSeconds: plannedSeconds,
    };
    persistActiveState();
  }

  function startReadyPhase() {
    if (!activeState || activeState.status !== "ready") return;
    const nowMs = Date.now();
    const plannedSeconds = activeState.phasePlannedSeconds;
    const id = makeId();
    activeState = {
      status: "running",
      presetKey: activeState.presetKey,
      cycleNumber: activeState.cycleNumber,
      workIndex: activeState.workIndex,
      phaseType: activeState.phaseType,
      phasePlannedSeconds: plannedSeconds,
      phaseStartedAtMs: nowMs,
      phaseEndsAtMs: nowMs + plannedSeconds * 1000,
      pausedAtMs: null,
      pausedTotalMs: 0,
      pausedRemainingMs: null,
      phaseId: id,
    };
    persistActiveState();
  }

  function resetActiveState() {
    activeState = null;
    removeStorage(STORAGE_KEYS.active);
  }

  function persistActiveState() {
    if (!activeState) {
      removeStorage(STORAGE_KEYS.active);
      return;
    }
    try {
      saveStorage(STORAGE_KEYS.active, activeState);
    } catch {
      showNote("Failed to persist active timer state (localStorage quota?).", "error");
    }
  }

  function persistPrefs() {
    try {
      saveStorage(STORAGE_KEYS.prefs, prefs);
    } catch {
      showNote("Failed to save preferences (localStorage quota?).", "error");
    }
  }

  function persistSessions() {
    saveStorage(STORAGE_KEYS.sessions, sessions);
  }

  function getRemainingSecondsForDisplay(nowMs) {
    if (!activeState) return null;
    if (activeState.status === "ready") return activeState.phasePlannedSeconds;
    if (activeState.status === "paused") {
      const remainingMs = typeof activeState.pausedRemainingMs === "number" ? activeState.pausedRemainingMs : 0;
      return Math.ceil(remainingMs / 1000);
    }
    const remainingMs = activeState.phaseEndsAtMs - nowMs;
    return Math.ceil(remainingMs / 1000);
  }

  function initAudio() {
    if (audioCtx) return;
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) {
      showNote("Audio not supported in this browser. Work-end alarm will be silent.", "error");
      return;
    }
    audioCtx = new AudioContextCtor();
  }

  function unlockAudioFromGesture() {
    initAudio();
    if (!audioCtx) return;
    if (audioUnlocked) return;

    // Many browsers require audio to be resumed from a user gesture.
    // We do a tiny "silent" start to unlock audio output.
    audioCtx
      .resume()
      .then(() => {
        const now = audioCtx.currentTime;
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = "sine";
        osc.frequency.value = 440;
        gain.gain.setValueAtTime(0.0001, now);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(now);
        osc.stop(now + 0.01);
        audioUnlocked = true;
      })
      .catch(() => {
        showNote("Sound is blocked by the browser. Allow site audio to hear alarms.", "error");
      });
  }

  function beepAlarm() {
    if (!audioCtx) return;
    if (audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }

    const now = audioCtx.currentTime;
    const beepCount = 3;
    const beepDuration = 0.12;
    const gap = 0.08;
    const baseFreq = 880;

    for (let i = 0; i < beepCount; i += 1) {
      const t0 = now + i * (beepDuration + gap);
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = baseFreq;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.3, t0 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + beepDuration);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(t0);
      osc.stop(t0 + beepDuration + 0.01);
    }
  }

  function finalizeCurrentPhase({ endedAtMs, isCatchUp }) {
    if (!activeState) return;
    const startedAtMs = activeState.phaseStartedAtMs;
    const pausedTotalMs = activeState.pausedTotalMs || 0;
    const durationMs = Math.max(0, endedAtMs - startedAtMs - pausedTotalMs);
    const description = activeState.phaseType === "work" ? DEFAULT_WORK_DESCRIPTION : "";
    const record = {
      id: activeState.phaseId,
      presetKey: activeState.presetKey,
      cycleNumber: activeState.cycleNumber,
      workIndex: activeState.phaseType === "long_break" ? null : activeState.workIndex,
      type: activeState.phaseType,
      description,
      plannedSeconds: activeState.phasePlannedSeconds,
      actualSeconds: Math.max(0, Math.round(durationMs / 1000)),
      pausedSeconds: Math.max(0, Math.round(pausedTotalMs / 1000)),
      startedAtIso: new Date(startedAtMs).toISOString(),
      endedAtIso: new Date(endedAtMs).toISOString(),
      createdAtIso: new Date().toISOString(),
    };

    sessions.push(record);
    try {
      persistSessions();
    } catch {
      showNote("Failed to save session history (localStorage quota?).", "error");
    }

    if (!isCatchUp && activeState.phaseType === "work") {
      beepAlarm();
    }

    return record;
  }

  function openDescriptionModal(sessionId) {
    if (!dom.descModalBackdrop || !dom.descInput) return;
    pendingWorkDescriptionId = sessionId;
    dom.descInput.value = "";
    dom.descModalBackdrop.hidden = false;
    window.setTimeout(() => {
      try {
        dom.descInput.focus();
      } catch {
        // ignore
      }
    }, 0);
  }

  function closeDescriptionModal() {
    if (!dom.descModalBackdrop) return;
    dom.descModalBackdrop.hidden = true;
    pendingWorkDescriptionId = null;
  }

  function saveDescriptionFromModal({ useDefault }) {
    if (!pendingWorkDescriptionId) {
      closeDescriptionModal();
      return;
    }
    const raw = dom.descInput?.value ?? "";
    const trimmed = String(raw).trim();
    const desc = useDefault ? DEFAULT_WORK_DESCRIPTION : trimmed.length > 0 ? trimmed : DEFAULT_WORK_DESCRIPTION;

    const idx = sessions.findIndex((s) => s && s.id === pendingWorkDescriptionId);
    if (idx >= 0) {
      sessions[idx] = { ...sessions[idx], description: desc };
      try {
        persistSessions();
      } catch {
        showNote("Saved, but failed to persist description (localStorage quota?).", "error");
      }
    }
    closeDescriptionModal();
  }

  function transitionAfterCompletion({ endedAtMs, isCatchUp, finalizedRecord }) {
    if (!activeState) return;
    const next = buildNextPhaseInfo(activeState);

    // Requested behavior:
    // - Work completion should start the rest countdown immediately (while prompting for description).
    // - Rest completion should NOT auto-start the next work session; instead wait for user to click Start.
    if (activeState.phaseType === "work") {
      startPhase({
        phaseType: next.phaseType,
        cycleNumber: next.cycleNumber,
        workIndex: next.workIndex,
        presetKey: activeState.presetKey,
        plannedSeconds: next.plannedSeconds,
        startAtMs: endedAtMs,
      });

      if (!isCatchUp && finalizedRecord?.id) openDescriptionModal(finalizedRecord.id);
      if (!isCatchUp) showNote("Work finished. Rest started.");
      return;
    }

    closeDescriptionModal();
    setReadyPhase({
      phaseType: next.phaseType,
      cycleNumber: next.cycleNumber,
      workIndex: next.workIndex,
      presetKey: activeState.presetKey,
      plannedSeconds: next.plannedSeconds,
    });

    if (!isCatchUp) showNote("Break finished. Ready for the next session — click Start.");
  }

  function handlePhaseCompletion({ isCatchUp }) {
    if (!activeState) return;
    const endedAtMs = activeState.phaseEndsAtMs;
    const finalizedRecord = finalizeCurrentPhase({ endedAtMs, isCatchUp });
    transitionAfterCompletion({ endedAtMs, isCatchUp, finalizedRecord });
  }

  function tick() {
    const nowMs = Date.now();

    if (activeState && activeState.status === "running") {
      if (nowMs >= activeState.phaseEndsAtMs) {
        handlePhaseCompletion({ isCatchUp: false });
        renderStatic();
      }
    }

    renderDynamic(nowMs);
  }

  function isSameLocalDate(a, b) {
    return (
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate()
    );
  }

  function computeTotals() {
    const now = new Date();
    let todayWorkSeconds = 0;
    let todayRestSeconds = 0;
    let allWorkSeconds = 0;
    let allRestSeconds = 0;

    for (const s of sessions) {
      const started = new Date(s.startedAtIso);
      const seconds = typeof s.actualSeconds === "number" ? s.actualSeconds : 0;
      const isWork = s.type === "work";
      if (isWork) allWorkSeconds += seconds;
      else allRestSeconds += seconds;

      if (!Number.isNaN(started.getTime()) && isSameLocalDate(started, now)) {
        if (isWork) todayWorkSeconds += seconds;
        else todayRestSeconds += seconds;
      }
    }

    return {
      todayWorkSeconds,
      todayRestSeconds,
      allWorkSeconds,
      allRestSeconds,
    };
  }

  function renderTotals() {
    const totals = computeTotals();
    dom.todayTotals.textContent = `work ${formatHhMmFromSeconds(totals.todayWorkSeconds)}, rest ${formatHhMmFromSeconds(
      totals.todayRestSeconds
    )}`;
    dom.allTotals.textContent = `work ${formatHhMmFromSeconds(totals.allWorkSeconds)}, rest ${formatHhMmFromSeconds(
      totals.allRestSeconds
    )}`;
  }

  function renderRecent() {
    const recent = sessions.slice(-20).reverse();
    dom.recentBody.innerHTML = "";

    if (recent.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 7;
      td.style.color = "var(--muted)";
      td.textContent = "No sessions yet.";
      tr.appendChild(td);
      dom.recentBody.appendChild(tr);
      return;
    }

    for (const s of recent) {
      const tr = document.createElement("tr");

      const tdStart = document.createElement("td");
      tdStart.textContent = formatLocalDateTime(s.startedAtIso);
      tr.appendChild(tdStart);

      const tdEnd = document.createElement("td");
      tdEnd.textContent = formatLocalDateTime(s.endedAtIso);
      tr.appendChild(tdEnd);

      const tdType = document.createElement("td");
      const pill = document.createElement("span");
      pill.className = `pill ${s.type}`;
      pill.textContent = PHASE_LABELS[s.type] || s.type;
      tdType.appendChild(pill);
      tr.appendChild(tdType);

      const tdDesc = document.createElement("td");
      const rawDesc = s.type === "work" ? (s.description ?? DEFAULT_WORK_DESCRIPTION) : "";
      const desc = String(rawDesc ?? "");
      const short = desc.length > 44 ? `${desc.slice(0, 41)}…` : desc;
      tdDesc.textContent = short;
      if (desc) tdDesc.title = desc;
      tr.appendChild(tdDesc);

      const tdPlanned = document.createElement("td");
      tdPlanned.textContent = `${Math.round((s.plannedSeconds || 0) / 60)}m`;
      tr.appendChild(tdPlanned);

      const tdActual = document.createElement("td");
      tdActual.textContent = formatMMSS(s.actualSeconds || 0);
      tr.appendChild(tdActual);

      const tdPaused = document.createElement("td");
      tdPaused.textContent = formatMMSS(s.pausedSeconds || 0);
      tr.appendChild(tdPaused);

      dom.recentBody.appendChild(tr);
    }
  }

  function renderStatic() {
    const selectedKey = getSelectedPresetKeyFromUI();
    const preset = getPreset(selectedKey);

    const status = activeState?.status || "idle";
    const isRunning = !!activeState && (status === "running" || status === "paused");
    const isReady = !!activeState && status === "ready";

    setPresetInputsDisabled(isRunning);

    dom.startBtn.disabled = isRunning;
    dom.resetBtn.disabled = !activeState;
    dom.pauseBtn.disabled = !isRunning;
    dom.pauseBtn.textContent = status === "paused" ? "Resume" : "Pause";

    if (!activeState) {
      dom.statusLine.textContent = "Mode: Idle";
      dom.phaseValue.textContent = PHASE_LABELS.work;
      dom.cycleValue.textContent = "1";
      dom.workValue.textContent = `1 / ${WORKS_PER_CYCLE}`;
      dom.nextValue.textContent = `${PHASE_LABELS.short_break} (${preset.shortBreakMinutes}:00)`;
      dom.timeDisplay.textContent = formatMMSS(preset.workMinutes * 60);
      document.title = "Pomotodo";
      renderTotals();
      renderRecent();
      return;
    }

    const phaseLabel = PHASE_LABELS[activeState.phaseType] || activeState.phaseType;
    const runLabel = status === "paused" ? "Paused" : status === "ready" ? "Ready" : "Running";
    dom.statusLine.textContent = `Mode: ${phaseLabel} · ${runLabel}`;
    dom.phaseValue.textContent = phaseLabel;
    dom.cycleValue.textContent = String(activeState.cycleNumber);
    dom.workValue.textContent =
      typeof activeState.workIndex === "number" ? `${activeState.workIndex} / ${WORKS_PER_CYCLE}` : "—";

    const next = buildNextPhaseInfo(activeState);
    const nextLabel = PHASE_LABELS[next.phaseType] || next.phaseType;
    dom.nextValue.textContent = `${nextLabel} (${formatMMSS(next.plannedSeconds)})`;

    renderTotals();
    renderRecent();
  }

  function renderDynamic(nowMs = Date.now()) {
    if (!activeState) {
      document.title = "Pomotodo";
      return;
    }

    const phaseLabel = PHASE_LABELS[activeState.phaseType] || activeState.phaseType;
    const remaining = getRemainingSecondsForDisplay(nowMs);
    dom.timeDisplay.textContent = formatMMSS(remaining == null ? 0 : remaining);
    document.title = `${formatMMSS(remaining == null ? 0 : remaining)} · ${phaseLabel}`;
  }

  function pauseOrResume() {
    if (!activeState) return;
    const nowMs = Date.now();

    if (activeState.status === "running") {
      const remainingMs = Math.max(0, activeState.phaseEndsAtMs - nowMs);
      activeState.status = "paused";
      activeState.pausedAtMs = nowMs;
      activeState.pausedRemainingMs = remainingMs;
      persistActiveState();
      showNote("Paused.");
      renderStatic();
      renderDynamic(nowMs);
      return;
    }

    if (activeState.status === "paused") {
      const pausedAtMs = typeof activeState.pausedAtMs === "number" ? activeState.pausedAtMs : nowMs;
      const extraPausedMs = Math.max(0, nowMs - pausedAtMs);
      const remainingMs = typeof activeState.pausedRemainingMs === "number" ? activeState.pausedRemainingMs : 0;
      activeState.pausedTotalMs = (activeState.pausedTotalMs || 0) + extraPausedMs;
      activeState.pausedAtMs = null;
      activeState.pausedRemainingMs = null;
      activeState.phaseEndsAtMs = nowMs + remainingMs;
      activeState.status = "running";
      persistActiveState();
      showNote("Resumed.");
      renderStatic();
      renderDynamic(nowMs);
    }
  }

  function start() {
    initAudio();

    closeDescriptionModal();

    if (activeState && activeState.status === "ready") {
      startReadyPhase();
      showNote("Started.");
      renderStatic();
      renderDynamic(Date.now());
      return;
    }

    if (activeState) return;

    const presetKey = getSelectedPresetKeyFromUI();
    prefs.selectedPresetKey = presetKey;
    persistPrefs();

    const plannedSeconds = phasePlannedSeconds("work", presetKey);
    startPhase({
      phaseType: "work",
      cycleNumber: 1,
      workIndex: 1,
      presetKey,
      plannedSeconds,
    });

    showNote("Started: Work");
    renderStatic();
    renderDynamic(Date.now());
  }

  function reset() {
    closeDescriptionModal();
    resetActiveState();
    showNote("Reset.");
    renderStatic();
    renderDynamic(Date.now());
  }

  function clearHistory() {
    const ok = window.confirm("Clear all saved session history? This cannot be undone.");
    if (!ok) return;
    sessions = [];
    try {
      persistSessions();
    } catch {
      // ignore
    }
    closeDescriptionModal();
    resetActiveState();
    showNote("History cleared.");
    renderStatic();
    renderDynamic(Date.now());
  }

  function csvEscape(value) {
    const s = String(value ?? "");
    if (/[",\n]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
    return s;
  }

  function exportCsv() {
    const header = [
      "id",
      "preset_key",
      "cycle_number",
      "work_index",
      "type",
      "description",
      "planned_seconds",
      "actual_seconds",
      "paused_seconds",
      "started_at_iso",
      "ended_at_iso",
    ];

    const lines = [header.join(",")];
    for (const s of sessions) {
      const row = [
        s.id,
        s.presetKey,
        s.cycleNumber,
        s.workIndex == null ? "" : s.workIndex,
        s.type,
        s.description ?? "",
        s.plannedSeconds,
        s.actualSeconds,
        s.pausedSeconds,
        s.startedAtIso,
        s.endedAtIso,
      ].map(csvEscape);
      lines.push(row.join(","));
    }

    const csv = `${lines.join("\n")}\n`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);

    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = pad2(now.getMonth() + 1);
    const dd = pad2(now.getDate());
    const filename = `pomotodo-sessions-${yyyy}-${mm}-${dd}.csv`;

    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    showNote(`Exported: ${filename}`);
  }

  function isValidActiveState(state) {
    if (!state || typeof state !== "object") return false;
    if (state.status !== "running" && state.status !== "paused" && state.status !== "ready") return false;
    if (!PRESETS[state.presetKey]) return false;
    if (state.phaseType !== "work" && state.phaseType !== "short_break" && state.phaseType !== "long_break") return false;
    if (typeof state.cycleNumber !== "number" || !Number.isFinite(state.cycleNumber) || state.cycleNumber < 1) return false;
    if (typeof state.phasePlannedSeconds !== "number" || !Number.isFinite(state.phasePlannedSeconds)) return false;

    if (state.status === "running" || state.status === "paused") {
      if (typeof state.phaseStartedAtMs !== "number" || !Number.isFinite(state.phaseStartedAtMs)) return false;
      if (typeof state.phaseEndsAtMs !== "number" || !Number.isFinite(state.phaseEndsAtMs)) return false;
      if (typeof state.pausedTotalMs !== "number" || !Number.isFinite(state.pausedTotalMs) || state.pausedTotalMs < 0) return false;
      if (typeof state.phaseId !== "string" || state.phaseId.length < 5) return false;
    }

    if (state.phaseType === "work" || state.phaseType === "short_break") {
      if (typeof state.workIndex !== "number" || state.workIndex < 1 || state.workIndex > WORKS_PER_CYCLE) return false;
    }
    if (state.status === "paused") {
      if (typeof state.pausedRemainingMs !== "number" || state.pausedRemainingMs < 0) return false;
    }
    return true;
  }

  function restoreAndCatchUp() {
    let hadParseIssue = false;

    prefs = loadStorage(STORAGE_KEYS.prefs, { selectedPresetKey: "25_5" }) || { selectedPresetKey: "25_5" };
    if (!PRESETS[prefs.selectedPresetKey]) prefs.selectedPresetKey = "25_5";
    setSelectedPresetKeyInUI(prefs.selectedPresetKey);

    const loadedSessions = loadStorage(STORAGE_KEYS.sessions, []);
    if (!Array.isArray(loadedSessions)) hadParseIssue = true;
    sessions = Array.isArray(loadedSessions) ? loadedSessions : [];

    const loadedActive = loadStorage(STORAGE_KEYS.active, null);
    activeState = isValidActiveState(loadedActive) ? loadedActive : null;
    if (loadedActive && !activeState) hadParseIssue = true;

    if (activeState && activeState.status === "running") {
      const nowMs = Date.now();
      let guard = 0;
      while (activeState && activeState.status === "running" && nowMs >= activeState.phaseEndsAtMs) {
        handlePhaseCompletion({ isCatchUp: true });
        guard += 1;
        if (guard > 1000) {
          resetActiveState();
          hadParseIssue = true;
          break;
        }
      }
    }

    if (hadParseIssue) {
      showNote("Some stored data looked invalid. You may want to Clear History.", "error");
    }
  }

  function attachEvents() {
    dom.startBtn.addEventListener("click", () => {
      unlockAudioFromGesture();
      start();
    });
    dom.pauseBtn.addEventListener("click", () => {
      unlockAudioFromGesture();
      pauseOrResume();
    });
    dom.resetBtn.addEventListener("click", reset);
    dom.exportBtn.addEventListener("click", exportCsv);
    dom.clearBtn.addEventListener("click", clearHistory);

    dom.presetGroup.addEventListener("change", () => {
      const presetKey = getSelectedPresetKeyFromUI();
      prefs.selectedPresetKey = presetKey;
      persistPrefs();
      const preset = getPreset(presetKey);

      if (activeState && activeState.status === "ready") {
        activeState.presetKey = presetKey;
        activeState.phasePlannedSeconds = phasePlannedSeconds(activeState.phaseType, presetKey);
        persistActiveState();
        renderStatic();
        renderDynamic(Date.now());
        return;
      }

      if (activeState) return;

      dom.timeDisplay.textContent = formatMMSS(preset.workMinutes * 60);
      dom.nextValue.textContent = `${PHASE_LABELS.short_break} (${preset.shortBreakMinutes}:00)`;
    });

    dom.descSaveBtn?.addEventListener("click", () => saveDescriptionFromModal({ useDefault: false }));
    dom.descSkipBtn?.addEventListener("click", () => saveDescriptionFromModal({ useDefault: true }));
    dom.descModalBackdrop?.addEventListener("click", (e) => {
      if (e.target === dom.descModalBackdrop) saveDescriptionFromModal({ useDefault: true });
    });
    dom.descInput?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") saveDescriptionFromModal({ useDefault: false });
      if (e.key === "Escape") saveDescriptionFromModal({ useDefault: true });
    });
  }

  function boot() {
    restoreAndCatchUp();
    attachEvents();
    renderStatic();
    renderDynamic(Date.now());

    if (uiTimerId != null) clearInterval(uiTimerId);
    uiTimerId = window.setInterval(tick, 250);
  }

  boot();
})();
