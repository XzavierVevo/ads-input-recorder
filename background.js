// Input Recorder & Replayer - background service worker.
// Owns storage, a multi-tab recording session, and replay orchestration
// (switching tabs, reading live values, and pasting them across tabs).

const DEFAULT_STATE = { recordings: {}, slots: {} };
const DEFAULT_SETTINGS = { openTabIfMissing: false, debug: true, verboseDebug: true };
const DEFAULT_PRESETS = [
  {
    id: "tiktok-ads",
    label: "TikTok Ads Manager",
    urlPattern: "https://ads.tiktok.com",
    href: "https://ads.tiktok.com/"
  },
  {
    id: "tiktok-business",
    label: "TikTok Business Center",
    urlPattern: "https://business.tiktok.com",
    href: "https://business.tiktok.com/"
  }
];

// How long replay waits for a step's element before acting.
const DEFAULT_TIMEOUT = 10000; // required steps
const OPTIONAL_TIMEOUT = 3000; // optional steps (skipped if not found)

// In-memory session (mirrored to storage so it survives a worker restart).
// session = { active, steps, startTabId, lastTabId }
let mem = null;
let replayCtrl = null; // { active, abort, tabId, recordingName }
let cachedDebug = false; // mirror of settings.debug for cheap access
let cachedVerbose = true; // mirror of settings.verboseDebug
// Per-tab debug log survives full-page navigations (content script is recreated).
const debugBuffers = new Map(); // tabId -> [{ phase, text, ts }]
const DEBUG_BUFFER_MAX = 80;

// Short, human description of a step for the debug overlay.
function formatWait(ms) {
  if (!ms || ms < 1) return "";
  if (ms < 1000) return ` (${ms}ms wait)`;
  return ` (${(ms / 1000).toFixed(1)}s wait)`;
}

function recordedWaitMs(step) {
  if (!step) return 0;
  if (step.type === "wait" || step.type === "waitForElement") {
    return step.ms || step.loadWaitMs || step.pageLoadMs || step.elementWaitMs || 500;
  }
  return step.ms || 0;
}

// Wait to run BEFORE executing this step (not before a navigates click's own pageLoadMs).
function preStepWaitMs(step) {
  if (!step) return 0;
  if (step.afterNavigation) {
    return step.loadWaitMs || step.pageLoadMs || 0;
  }
  return step.elementWaitMs || step.waitsForMs || 0;
}

// Deprecated: composite/section captures are now filtered at record time
// (isCompositeCapture in content.js), so nothing needs skipping here.
function isCompositeDashboardClick() {
  return false;
}

function describeStep(step, extra) {
  const sel = step.selector ? String(step.selector).slice(0, 60) : "";
  switch (step.type) {
    case "switchTab":
      return "go to tab: " + (step.title || step.urlPattern || step.href || "");
    case "waitForElement":
    case "wait": {
      const ms = recordedWaitMs(step) || 500;
      const label = step.text || step.aria || sel || "pause";
      return `timer: ${label}${formatWait(ms)}`;
    }
    case "click": {
      const label = step.text || step.aria || sel || "?";
      const modalTag = step.inModal || step.modalAction ? " [modal]" : "";
      // Show the stable selector the recorder locked onto, so it's clear what
      // replay will target (and that it won't change between runs).
      const selHint = sel ? ` @${sel}` : "";
      if (step.afterNavigation) {
        const waitMs = step.loadWaitMs || step.pageLoadMs || 0;
        return waitMs > 0
          ? `click: ${label}${modalTag}${formatWait(waitMs)}${selHint}`
          : `click: ${label}${modalTag}${selHint}`;
      }
      if (step.navigates && (step.pageLoadMs || step.loadWaitMs)) {
        return `click: ${label} → load${formatWait(step.pageLoadMs || step.loadWaitMs)}${selHint}`;
      }
      const waitMs = step.elementWaitMs || step.waitsForMs || 0;
      return waitMs > 0
        ? `click: ${label}${modalTag}${formatWait(waitMs)}${selHint}`
        : `click: ${label}${modalTag}${selHint}`;
    }
    case "input":
      return "type " + JSON.stringify(step.value) + " into " + sel;
    case "key":
      return "key: " + step.key;
    case "copy":
      return "copy from: " + sel;
    case "paste":
      return "paste into: " + sel;
    case "wait":
      return "wait " + (step.ms || 0) + "ms";
    default:
      return step.type;
  }
}

function shouldShowDebug() {
  return cachedDebug || !!(mem && mem.active) || !!(replayCtrl && replayCtrl.active);
}

async function replayTimerWait(tabId, ms, label) {
  if (!ms || ms < 50) return;
  debugToTab(tabId, "replay", `timer: ${label || "wait"}${formatWait(ms)}`);
  if (tabId) {
    try {
      await chrome.tabs.sendMessage(
        tabId,
        { action: "timerWait", ms, label: label || "waiting" },
        { frameId: 0 }
      );
    } catch (e) {
      /* ignore */
    }
  }
  await abortableSleep(ms);
  if (tabId) {
    try {
      await chrome.tabs.sendMessage(tabId, { action: "clearTimerWait" }, { frameId: 0 });
    } catch (e) {
      /* ignore */
    }
  }
}

async function refreshDebug() {
  const s = await getSettings();
  cachedDebug = !!s.debug;
  cachedVerbose = s.verboseDebug !== false;
}

function formatUrlShort(url) {
  try {
    const u = new URL(url);
    return u.pathname.split("/").filter(Boolean).slice(-2).join("/") || u.pathname;
  } catch (e) {
    return String(url || "").slice(0, 40);
  }
}

function navigationSucceeded(before, after, step) {
  if (!before || !after || before === after) return false;
  if (step && step.url && derivePattern(after) !== derivePattern(step.url)) return true;
  return derivePattern(before) !== derivePattern(after);
}

function pushDebugLine(tabId, phase, text) {
  if (tabId == null) return;
  let buf = debugBuffers.get(tabId);
  if (!buf) {
    buf = [];
    debugBuffers.set(tabId, buf);
  }
  buf.push({ phase, text, ts: Date.now() });
  while (buf.length > DEBUG_BUFFER_MAX) buf.shift();
}

// Send a debug line to the tab's top frame (buffered for navigation survival).
function debugToTab(tabId, phase, step, extra) {
  if (!shouldShowDebug() || tabId == null) return;
  const text = typeof step === "string" ? step : describeStep(step, extra);
  pushDebugLine(tabId, phase, text);
  try {
    chrome.tabs
      .sendMessage(
        tabId,
        { action: "debugLog", phase, text, showPanel: true },
        { frameId: 0 }
      )
      .catch(() => {});
  } catch (e) {
    /* ignore */
  }
}

async function syncDebugPanel(tabId) {
  if (tabId == null || !shouldShowDebug()) return;
  const lines = debugBuffers.get(tabId) || [];
  try {
    await chrome.tabs.sendMessage(
      tabId,
      { action: "syncDebugPanel", lines, showPanel: true },
      { frameId: 0 }
    );
  } catch (e) {
    /* content script not ready yet */
  }
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

async function getState() {
  const data = await chrome.storage.local.get(DEFAULT_STATE);
  return { recordings: data.recordings || {}, slots: data.slots || {} };
}

async function getSettings() {
  const { settings } = await chrome.storage.local.get({ settings: DEFAULT_SETTINGS });
  return { ...DEFAULT_SETTINGS, ...settings };
}

async function getDomainPresets() {
  const { domainPresets } = await chrome.storage.local.get({ domainPresets: null });
  return domainPresets || DEFAULT_PRESETS.slice();
}

async function ensureDefaults() {
  const data = await chrome.storage.local.get(["settings", "domainPresets"]);
  const patch = {};
  if (!data.settings) patch.settings = DEFAULT_SETTINGS;
  if (!data.domainPresets) patch.domainPresets = DEFAULT_PRESETS.slice();
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
}

ensureDefaults();
refreshDebug();

async function loadSession() {
  if (mem) return mem;
  const { session } = await chrome.storage.local.get({ session: null });
  mem = session;
  return mem;
}

async function saveSession() {
  await chrome.storage.local.set({ session: mem });
}

async function saveRecording(name, steps) {
  const state = await getState();
  const id = "rec_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
  state.recordings[id] = { id, name, createdAt: Date.now(), steps };
  await chrome.storage.local.set({ recordings: state.recordings });
  return id;
}

// ---------------------------------------------------------------------------
// Tab + content script helpers
// ---------------------------------------------------------------------------

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function ensureContentScript(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { action: "ping" });
    if (res && res.ok) {
      await syncDebugPanel(tabId);
      return true;
    }
  } catch (e) {
    /* not injected yet */
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content.js"]
    });
    await syncDebugPanel(tabId);
    return true;
  } catch (e) {
    console.warn("Could not inject content script:", e.message);
    return false;
  }
}

// Map a recorded frame URL to the live frameId in the (possibly reloaded) tab.
async function resolveFrameId(tabId, frameUrl) {
  if (!frameUrl) return 0;
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    if (!frames) return 0;
    let f = frames.find((fr) => fr.url === frameUrl);
    if (f) return f.frameId;
    const pat = derivePattern(frameUrl);
    f = frames.find((fr) => fr.url && fr.url.indexOf(pat) !== -1);
    if (f) return f.frameId;
  } catch (e) {
    /* fall back to top frame */
  }
  return 0;
}

// Send a message to a specific frame (or the whole tab when frameId is null).
function sendToFrame(tabId, frameId, message) {
  const opts = frameId != null ? { frameId } : undefined;
  return chrome.tabs.sendMessage(tabId, message, opts);
}

function isConnectionLost(err) {
  const m = String((err && err.message) || err || "");
  return /receiving end|message port|establish connection|No tab with id|message channel closed|asynchronous response/i.test(
    m
  );
}

// A click "expects navigation" only when the recorder observed a URL change
// after it (step.navigates) - generic, no per-site button names.
function clickExpectsNavigation(step) {
  return !!(step && step.type === "click" && step.navigates);
}

function normalizeStepText(text) {
  if (!text) return "";
  const t = String(text).replace(/\s+/g, " ").trim();
  return t.length <= 80 ? t : t.slice(0, 80);
}

// Send a step to the tab, surviving a mid-step navigation: if the content
// script connection drops (page navigated/reloaded), wait for the new page to
// load, re-inject, and retry once — unless a navigates click already succeeded.
async function sendStepResilient(tabId, frameId, message) {
  let urlBefore = "";
  try {
    const t = await chrome.tabs.get(tabId);
    urlBefore = (t && t.url) || "";
  } catch (e) {
    /* ignore */
  }

  try {
    return await sendToFrame(tabId, frameId, message);
  } catch (e) {
    if (!isConnectionLost(e)) throw e;

    const step = message && message.step;
    if (step && clickExpectsNavigation(step)) {
      debugToTab(
        tabId,
        "replay",
        `OK click "${step.text || step.selector || "?"}" (navigation closed channel)`
      );
      return { ok: true, navigated: true, channelClosed: true };
    }

    await waitForTabLoad(tabId);
    let urlAfter = "";
    try {
      const t = await chrome.tabs.get(tabId);
      urlAfter = (t && t.url) || "";
    } catch (e2) {
      /* ignore */
    }

    if (
      step &&
      step.type === "click" &&
      urlBefore &&
      urlAfter &&
      urlBefore !== urlAfter
    ) {
      debugToTab(
        tabId,
        "replay",
        `OK click "${step.text || step.selector || "?"}" navigated ` +
          `(${formatUrlShort(urlBefore)} -> ${formatUrlShort(urlAfter)})`
      );
      return { ok: true, navigated: true };
    }

    if (
      step &&
      step.type === "click" &&
      step.navigates &&
      navigationSucceeded(urlBefore, urlAfter, step)
    ) {
      debugToTab(
        tabId,
        "replay",
        `OK click "${step.text || step.selector || "?"}" navigated ` +
          `(${formatUrlShort(urlBefore)} -> ${formatUrlShort(urlAfter)})`
      );
      return { ok: true, navigated: true };
    }

    await ensureContentScript(tabId);
    const fid =
      step && step.frameId && step.frameId > 0
        ? await resolveFrameId(tabId, step.frameUrl)
        : 0;
    return await sendToFrame(tabId, fid, message);
  }
}

function isWebUrl(url) {
  return !!url && (url.startsWith("http://") || url.startsWith("https://"));
}

function derivePattern(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch (e) {
    return url || "";
  }
}

async function findTabByPattern(pattern, href) {
  const tabs = await chrome.tabs.query({});
  // 1. Exact URL match.
  let t = tabs.find((tab) => tab.url === href);
  if (t) return t;
  // 2. URL contains the pattern (origin + path).
  if (pattern) {
    t = tabs.find((tab) => tab.url && tab.url.indexOf(pattern) !== -1);
    if (t) return t;
  }
  // 3. Fall back to matching the origin only.
  try {
    const origin = new URL(href || pattern).origin;
    t = tabs.find((tab) => tab.url && tab.url.indexOf(origin) !== -1);
    if (t) return t;
  } catch (e) {
    /* ignore */
  }
  return null;
}

function tabMatchesStep(tab, step) {
  if (!tab || !tab.url || !step) return false;
  if (step.href && tab.url === step.href) return true;
  if (step.urlPattern && tab.url.indexOf(step.urlPattern) !== -1) return true;
  try {
    if (step.urlPattern && derivePattern(tab.url) === step.urlPattern) return true;
  } catch (e) {
    /* ignore */
  }
  return false;
}

async function waitForTabLoad(tabId, timeout = 15000) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab && tab.status === "complete") return tab;

  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const listener = (updatedTabId, info) => {
      if (updatedTabId !== tabId || info.status !== "complete") return;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(chrome.tabs.get(tabId));
    };
    chrome.tabs.onUpdated.addListener(listener);

    const poll = () => {
      if (replayCtrl && replayCtrl.abort) {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error("Replay stopped"));
        return;
      }
      if (Date.now() > deadline) {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error("Timed out waiting for tab to load"));
        return;
      }
      setTimeout(poll, 100);
    };
    poll();
  });
}

async function openTabForStep(step) {
  const url = step.href || step.urlPattern;
  if (!isWebUrl(url)) throw new Error("No valid URL to open tab");
  const tab = await chrome.tabs.create({ url, active: true });
  try {
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch (e) {
    /* ignore */
  }
  await waitForTabLoad(tab.id);
  await ensureContentScript(tab.id);
  return tab;
}

function isReplayAborted() {
  return !!(replayCtrl && replayCtrl.abort);
}

function abortableSleep(ms) {
  const interval = 50;
  let remaining = ms || 500;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (isReplayAborted()) {
        reject(new Error("Replay stopped"));
        return;
      }
      remaining -= interval;
      if (remaining <= 0) return resolve();
      setTimeout(tick, interval);
    };
    tick();
  });
}

async function armAbortListener(tabId) {
  if (tabId == null) return;
  try {
    // Broadcast to every frame so Escape aborts even when focus is in an iframe.
    await chrome.tabs.sendMessage(tabId, { action: "armAbortListener" });
  } catch (e) {
    /* ignore */
  }
}

async function disarmAbortListener(tabId) {
  if (tabId == null) return;
  try {
    await chrome.tabs.sendMessage(tabId, { action: "disarmAbortListener" });
  } catch (e) {
    /* ignore */
  }
}

// Tell the content script(s) to cancel any in-flight step wait immediately.
async function cancelInFlightStep(tabId) {
  if (tabId == null) return;
  try {
    await chrome.tabs.sendMessage(tabId, { action: "cancelStep" });
  } catch (e) {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Recording session (multi-tab)
// ---------------------------------------------------------------------------

async function startSession() {
  const tab = await getActiveTab();
  if (!tab || !tab.id) return { ok: false, error: "No active tab" };
  mem = {
    active: true,
    startTabId: tab.id,
    lastTabId: tab.id,
    lastStepTs: Date.now(),
    steps: isWebUrl(tab.url)
      ? [
          {
            type: "switchTab",
            urlPattern: derivePattern(tab.url),
            href: tab.url,
            title: tab.title || ""
          }
        ]
      : []
  };
  await saveSession();
  await ensureContentScript(tab.id);
  await chrome.tabs.sendMessage(tab.id, { action: "startRecording" });
  debugToTab(tab.id, "captured", "Recording started");
  await syncDebugPanel(tab.id);
  return { ok: true };
}

async function setReplayUi(tabId, active) {
  if (tabId == null) return;
  try {
    await chrome.tabs.sendMessage(tabId, { action: "replayUi", active: !!active }, { frameId: 0 });
  } catch (e) {
    /* ignore */
  }
}

async function killRun() {
  if (!replayCtrl || !replayCtrl.active) {
    return { ok: false, error: "No replay in progress" };
  }
  replayCtrl.abort = true;
  const tabId = replayCtrl.tabId;
  await cancelInFlightStep(tabId);
  if (tabId != null) await toast(tabId, "Replay stopped");
  return { ok: true, killed: ["replay"] };
}

async function stopSession(name) {
  const s = await loadSession();
  if (!s) return { ok: false, error: "No session" };
  s.active = false;
  await saveSession();
  // Tell every recorded tab to detach listeners.
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    try {
      await chrome.tabs.sendMessage(t.id, { action: "stopRecording" });
    } catch (e) {
      /* tab without our script - ignore */
    }
  }
  const steps = (s.steps || []).slice();
  mem = null;
  await chrome.storage.local.set({ session: null });
  if (!steps.length) return { ok: true, saved: false, stepCount: 0 };
  const id = await saveRecording(name || `Recording ${new Date().toLocaleString()}`, steps);
  return { ok: true, saved: true, id, stepCount: steps.length };
}

// Record a tab switch + (re)arm recording when the user changes the active tab.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const s = await loadSession();
  if (!s || !s.active) return;
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (e) {
    return;
  }
  if (!isWebUrl(tab.url)) return;
  if (tabId !== s.lastTabId) {
    s.steps.push({
      type: "switchTab",
      urlPattern: derivePattern(tab.url),
      href: tab.url,
      title: tab.title || ""
    });
    s.lastTabId = tabId;
    mem = s;
    await saveSession();
  }
  await ensureContentScript(tabId);
  try {
    await chrome.tabs.sendMessage(tabId, { action: "startRecording" });
  } catch (e) {
    /* ignore */
  }
});

// Re-arm recording after a page within the active recorded tab finishes loading.
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== "complete") return;
  const s = await loadSession();
  const recording = s && s.active;
  if (recording) {
    if (!tab.active || !isWebUrl(tab.url)) return;
    await ensureContentScript(tabId);
    try {
      await chrome.tabs.sendMessage(tabId, { action: "startRecording" });
    } catch (e) {
      /* ignore */
    }
  }
  if (shouldShowDebug() && tab.active && isWebUrl(tab.url)) {
    await ensureContentScript(tabId);
    await syncDebugPanel(tabId);
  }
});

// ---------------------------------------------------------------------------
// Replay orchestration (handles tab switching + cross-tab copy/paste)
// ---------------------------------------------------------------------------

async function toast(tabId, message, isError) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: "toast", message, isError });
  } catch (e) {
    /* ignore */
  }
}

async function toastActiveTab(message, isError) {
  const tab = await getActiveTab();
  if (tab && tab.id) await toast(tab.id, message, isError);
}

async function replaySession(rec) {
  if (replayCtrl && replayCtrl.active) {
    return { ok: false, error: "Replay already in progress" };
  }

  const steps = rec.steps || [];
  const settings = await getSettings();
  const active = await getActiveTab();
  let currentTabId = active ? active.id : null;
  let clip = "";

  replayCtrl = {
    active: true,
    abort: false,
    tabId: currentTabId,
    recordingName: rec.name || "Recording"
  };

  try {
    if (currentTabId != null) await armAbortListener(currentTabId);
    if (currentTabId != null) {
      debugToTab(currentTabId, "replay", "Replay started: " + (rec.name || "Recording"));
      await syncDebugPanel(currentTabId);
      await setReplayUi(currentTabId, true);
    }

    for (let i = 0; i < steps.length; i++) {
      if (isReplayAborted()) {
        if (currentTabId != null) await toast(currentTabId, "Replay stopped");
        return { ok: false, stopped: true, error: "Replay stopped" };
      }

      const step = steps[i];
      const prevStep = i > 0 ? steps[i - 1] : null;

      if (isCompositeDashboardClick(step)) {
        if (currentTabId != null) {
          debugToTab(currentTabId, "replay", "skip dashboard click: " + (step.text || "?"));
        }
        continue;
      }

      const overlayClick =
        step.type === "click" &&
        /loading|spinner|mask|overlay|backdrop|skeleton/i.test(step.selector || "");
      const optional = !!step.optional || overlayClick;
      const stepTimeout = optional ? OPTIONAL_TIMEOUT : DEFAULT_TIMEOUT;

      try {
        // Explicit timer steps (wait + legacy waitForElement recordings).
        if (step.type === "wait" || step.type === "waitForElement") {
          const ms = recordedWaitMs(step) || 500;
          await replayTimerWait(
            currentTabId,
            ms,
            step.text || step.waitKind || "pause"
          );
          continue;
        }

        if (step.type === "switchTab") {
          let t = await findTabByPattern(step.urlPattern, step.href);
          const shouldOpen = step.openIfMissing ?? settings.openTabIfMissing;
          if (!t && shouldOpen) {
            t = await openTabForStep(step);
            await toast(t.id, "Opened tab: " + (step.title || step.urlPattern));
          }
          if (!t) {
            throw new Error("No open tab matching " + (step.urlPattern || step.href));
          }

          const alreadyOnTab = currentTabId === t.id && tabMatchesStep(t, step);
          if (!alreadyOnTab) {
            await chrome.tabs.update(t.id, { active: true });
            try {
              await chrome.windows.update(t.windowId, { focused: true });
            } catch (e) {
              /* ignore */
            }
          }

          currentTabId = t.id;
          replayCtrl.tabId = currentTabId;
          await ensureContentScript(currentTabId);
          await armAbortListener(currentTabId);
          await setReplayUi(currentTabId, true);
          debugToTab(
            currentTabId,
            "replay",
            alreadyOnTab
              ? "already on tab: " + (step.title || step.urlPattern || step.href || "")
              : step
          );
          continue;
        }

        if (currentTabId == null) throw new Error("No target tab");

        // Recorded pause before this action (skip if previous step was already a timer).
        const timerMs = preStepWaitMs(step);
        if (
          timerMs >= 100 &&
          prevStep &&
          prevStep.type !== "wait" &&
          prevStep.type !== "waitForElement"
        ) {
          await replayTimerWait(
            currentTabId,
            timerMs,
            step.afterNavigation ? "page load" : step.text || step.type
          );
        }

        await ensureContentScript(currentTabId);
        debugToTab(currentTabId, "replay", step);

        const frameId =
          step.frameId && step.frameId > 0
            ? await resolveFrameId(currentTabId, step.frameUrl)
            : 0;

        const nextStep = i + 1 < steps.length ? steps[i + 1] : null;
        const execPayload = {
          timeout: stepTimeout,
          verboseDebug: cachedVerbose,
          stepIndex: i + 1,
          stepTotal: steps.length,
          afterPageLoad: !!(
            step.afterNavigation ||
            (prevStep && prevStep.type === "click" && prevStep.navigates)
          ),
          nextStepIsInModal: !!(
            nextStep &&
            nextStep.type === "click" &&
            (nextStep.inModal || nextStep.modalAction)
          )
        };

        let stepResult = null;

        if (step.type === "copy") {
          stepResult = await sendStepResilient(currentTabId, frameId, {
            action: "execStep",
            step: { type: "read", selector: step.selector, frameUrl: step.frameUrl, frameId: step.frameId },
            payload: execPayload
          });
          if (!stepResult || !stepResult.ok) throw new Error((stepResult && stepResult.error) || "copy failed");
          clip = stepResult.value || "";
        } else if (step.type === "paste") {
          stepResult = await sendStepResilient(currentTabId, frameId, {
            action: "execStep",
            step,
            payload: { ...execPayload, value: clip }
          });
          if (!stepResult || !stepResult.ok) throw new Error((stepResult && stepResult.error) || "paste failed");
        } else {
          stepResult = await sendStepResilient(currentTabId, frameId, {
            action: "execStep",
            step,
            payload: execPayload
          });
          if (!stepResult || !stepResult.ok) {
            throw new Error((stepResult && stepResult.error) || step.type + " failed");
          }
        }
      } catch (err) {
        if (isReplayAborted()) {
          if (currentTabId != null) await toast(currentTabId, "Replay stopped");
          return { ok: false, stopped: true, error: "Replay stopped" };
        }
        if (optional) {
          if (currentTabId != null) {
            await toast(currentTabId, `Skipped optional step ${i + 1} (${step.type})`);
          }
          continue;
        }
        const msg = `Step ${i + 1} (${step.type}): ${err.message}`;
        if (currentTabId != null) await toast(currentTabId, "Replay failed: " + msg, true);
        return { ok: false, failedStep: i, error: msg };
      }
      // Brief pause between steps so SPA navigation can begin after navigates clicks.
      const navPause = step.type === "click" && step.navigates ? 300 : 60;
      await new Promise((r) => setTimeout(r, navPause));
    }

    if (currentTabId != null) await toast(currentTabId, "Replay finished");
    return { ok: true };
  } finally {
    const tabId = replayCtrl ? replayCtrl.tabId : currentTabId;
    replayCtrl = null;
    await disarmAbortListener(tabId);
    await setReplayUi(tabId, false);
  }
}

async function playById(recordingId) {
  const state = await getState();
  const rec = state.recordings[recordingId];
  if (!rec) return { ok: false, error: "Recording not found" };
  return replaySession(rec);
}

// ---------------------------------------------------------------------------
// Hotkey commands -> play slot
// ---------------------------------------------------------------------------

chrome.commands.onCommand.addListener(async (command) => {
  if (!command.startsWith("play-slot-")) return;

  if (replayCtrl && replayCtrl.active) {
    await toastActiveTab("Replay already in progress", true);
    return;
  }

  const state = await getState();
  const recId = state.slots[command];
  const slotNum = command.replace("play-slot-", "");

  if (!recId) {
    await toastActiveTab("Hotkey: Slot " + slotNum + " is empty", true);
    return;
  }
  if (!state.recordings[recId]) {
    await toastActiveTab("Hotkey: Recording not found", true);
    return;
  }

  const result = await replaySession(state.recordings[recId]);
  if (result && result.ok === false && result.error === "Replay already in progress") {
    await toastActiveTab("Replay already in progress", true);
  }
});

// ---------------------------------------------------------------------------
// Messages from the popup / content script
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.action) return;

  (async () => {
    switch (msg.action) {
      case "recordStep": {
        const s = await loadSession();
        if (s && s.active) {
          const step = msg.step;
          if (sender && sender.frameId) {
            step.frameId = sender.frameId;
            step.frameUrl = sender.url || "";
          } else {
            step.frameId = 0;
          }

          const now = Date.now();
          if (!s.lastStepTs) s.lastStepTs = now;
          step.gap = Math.max(0, now - s.lastStepTs);
          step.ts = now;
          s.lastStepTs = now;
          step.url = (sender && sender.url) || "";

          const last = s.steps[s.steps.length - 1];
          if (
            step.type === "input" &&
            last &&
            last.type === "input" &&
            last.selector === step.selector
          ) {
            last.value = step.value;
          } else {
            const prevUrl = last && last.url;
            const urlChanged =
              prevUrl &&
              step.url &&
              derivePattern(step.url) !== derivePattern(prevUrl);
            const prevWasClick = last && last.type === "click";
            const waitMs = step.gap;

            if (urlChanged) {
              step.afterNavigation = true;
              step.pageLoadMs = waitMs;
              step.loadWaitMs = waitMs;
              if (prevWasClick) {
                last.navigates = true;
                last.pageLoadMs = waitMs;
                last.expectedPageUrl = step.url;
              }
            } else if (waitMs >= 400 && prevWasClick) {
              step.elementWaitMs = waitMs;
              if (last) last.waitsForMs = waitMs;
            }

            s.steps.push(step);
          }
          mem = s;
          await saveSession();
          if (sender && sender.tab) debugToTab(sender.tab.id, "captured", step);
        }
        sendResponse({ ok: true });
        break;
      }
      case "syncDebugPanel": {
        const tabId = sender && sender.tab && sender.tab.id;
        sendResponse({
          ok: true,
          enabled: shouldShowDebug(),
          verbose: cachedVerbose,
          lines: tabId != null ? debugBuffers.get(tabId) || [] : []
        });
        break;
      }
      case "traceLog": {
        const tabId = sender && sender.tab && sender.tab.id;
        if (tabId != null && shouldShowDebug()) {
          const text = `[${msg.kind || "info"}] ${msg.text || ""}`;
          pushDebugLine(tabId, "trace", text);
        }
        sendResponse({ ok: true });
        break;
      }
      case "abortReplay":
        if (replayCtrl && replayCtrl.active) {
          replayCtrl.abort = true;
          // Interrupt the current step's wait right away (don't wait for it
          // to time out before the between-steps abort check kicks in).
          await cancelInFlightStep(replayCtrl.tabId);
        }
        sendResponse({ ok: true });
        break;
      case "killRun":
        sendResponse(await killRun());
        break;
      case "startSession":
        sendResponse(await startSession());
        break;
      case "stopSession":
        sendResponse(await stopSession(msg.name));
        break;
      case "sessionStatus": {
        const s = await loadSession();
        sendResponse({
          ok: true,
          recording: !!(s && s.active),
          stepCount: s && s.steps ? s.steps.length : 0,
          replaying: !!(replayCtrl && replayCtrl.active),
          replayName: replayCtrl ? replayCtrl.recordingName : ""
        });
        break;
      }
      case "replayStatus":
        sendResponse({
          ok: true,
          replaying: !!(replayCtrl && replayCtrl.active),
          replayName: replayCtrl ? replayCtrl.recordingName : ""
        });
        break;
      case "getSettings":
        sendResponse({ ok: true, settings: await getSettings() });
        break;
      case "setSettings":
        await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS, ...msg.settings } });
        await refreshDebug();
        if (msg.settings && ("debug" in msg.settings || "verboseDebug" in msg.settings)) {
          const tabs = await chrome.tabs.query({});
          for (const t of tabs) {
            if (t.id != null && isWebUrl(t.url)) await syncDebugPanel(t.id);
          }
        }
        sendResponse({ ok: true });
        break;
      case "getDomainPresets":
        sendResponse({ ok: true, domainPresets: await getDomainPresets() });
        break;
      case "setDomainPresets":
        await chrome.storage.local.set({ domainPresets: msg.domainPresets || [] });
        sendResponse({ ok: true });
        break;
      case "ensureContentScript": {
        const ok = await ensureContentScript(msg.tabId);
        sendResponse({ ok });
        break;
      }
      case "playRecording":
        sendResponse(await playById(msg.recordingId));
        break;
      default:
        sendResponse({ ok: false, error: "Unknown action" });
    }
  })();

  return true; // async sendResponse
});
