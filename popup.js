// Input Recorder & Replayer - popup UI logic.

const SLOT_COUNT = 4;
const STORAGE_QUOTA_BYTES = 5 * 1024 * 1024;

const els = {
  status: document.getElementById("status"),
  recordBtn: document.getElementById("recordBtn"),
  killBtn: document.getElementById("killBtn"),
  recordName: document.getElementById("recordName"),
  list: document.getElementById("recordings"),
  empty: document.getElementById("empty"),
  exportBtn: document.getElementById("exportBtn"),
  importBtn: document.getElementById("importBtn"),
  importFile: document.getElementById("importFile"),
  shortcutsLink: document.getElementById("shortcutsLink"),
  storageUsage: document.getElementById("storageUsage"),
  settingsToggle: document.getElementById("settingsToggle"),
  settingsPanel: document.getElementById("settingsPanel"),
  openTabIfMissing: document.getElementById("openTabIfMissing"),
  debugOverlay: document.getElementById("debugOverlay"),
  verboseDebug: document.getElementById("verboseDebug"),
  presetsList: document.getElementById("presetsList"),
  addPresetBtn: document.getElementById("addPresetBtn")
};

let isRecording = false;
let isReplaying = false;
let domainPresets = [];

// --------------------------------------------------------------------------
// Storage helpers
// --------------------------------------------------------------------------

async function getState() {
  const data = await chrome.storage.local.get({ recordings: {}, slots: {} });
  return { recordings: data.recordings || {}, slots: data.slots || {} };
}

async function setRecordings(recordings) {
  await chrome.storage.local.set({ recordings });
}

async function setSlots(slots) {
  await chrome.storage.local.set({ slots });
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

async function refreshStorageUsage() {
  try {
    const bytes = await chrome.storage.local.getBytesInUse(null);
    els.storageUsage.textContent =
      "Storage: " + formatBytes(bytes) + " / " + formatBytes(STORAGE_QUOTA_BYTES);
    els.storageUsage.classList.toggle("storage-warn", bytes > STORAGE_QUOTA_BYTES * 0.8);
  } catch (e) {
    els.storageUsage.textContent = "Storage: unavailable";
  }
}

// --------------------------------------------------------------------------
// Settings + domain presets
// --------------------------------------------------------------------------

async function loadSettings() {
  const res = await chrome.runtime.sendMessage({ action: "getSettings" });
  if (res && res.settings) {
    els.openTabIfMissing.checked = !!res.settings.openTabIfMissing;
    els.debugOverlay.checked = res.settings.debug !== false;
    els.verboseDebug.checked = res.settings.verboseDebug !== false;
  }
}

async function saveSettings() {
  await chrome.runtime.sendMessage({
    action: "setSettings",
    settings: {
      openTabIfMissing: els.openTabIfMissing.checked,
      debug: els.debugOverlay.checked,
      verboseDebug: els.verboseDebug.checked
    }
  });
}

async function loadPresets() {
  const res = await chrome.runtime.sendMessage({ action: "getDomainPresets" });
  domainPresets = (res && res.domainPresets) || [];
  renderPresetsList();
}

async function savePresets() {
  await chrome.runtime.sendMessage({ action: "setDomainPresets", domainPresets });
}

function renderPresetsList() {
  els.presetsList.innerHTML = "";
  for (const preset of domainPresets) {
    const li = document.createElement("li");
    li.className = "preset-row";
    const label = document.createElement("span");
    label.textContent = preset.label + " — " + preset.urlPattern;
    label.title = preset.href || preset.urlPattern;
    const del = makeBtn("x", async () => {
      domainPresets = domainPresets.filter((p) => p.id !== preset.id);
      await savePresets();
      renderPresetsList();
    }, true);
    del.classList.add("step-del");
    li.appendChild(label);
    li.appendChild(del);
    els.presetsList.appendChild(li);
  }
}

async function addPreset() {
  const label = prompt("Preset label:", "My site");
  if (label === null || !label.trim()) return;
  const urlPattern = prompt("URL pattern (substring to match):", "https://");
  if (urlPattern === null || !urlPattern.trim()) return;
  const href = prompt("Full URL to open if tab missing:", urlPattern.trim()) || urlPattern.trim();
  domainPresets.push({
    id: "preset_" + Date.now(),
    label: label.trim(),
    urlPattern: urlPattern.trim(),
    href: href.trim()
  });
  await savePresets();
  renderPresetsList();
}

function makePresetSelect(onSelect) {
  const select = document.createElement("select");
  select.className = "step-preset";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "Apply preset…";
  select.appendChild(none);
  for (const p of domainPresets) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.label;
    select.appendChild(opt);
  }
  select.addEventListener("change", () => {
    if (!select.value) return;
    const preset = domainPresets.find((p) => p.id === select.value);
    if (preset) onSelect(preset);
    select.value = "";
  });
  return select;
}

// --------------------------------------------------------------------------
// Recording controls (session lives in the background, spans tabs)
// --------------------------------------------------------------------------

function updateKillButton() {
  els.killBtn.hidden = !isReplaying;
}

function setRecordingUI(on) {
  isRecording = on;
  if (on) {
    els.recordBtn.textContent = "Stop";
    els.recordBtn.classList.add("recording");
    els.status.textContent = "recording";
    els.status.className = "status recording";
  } else if (isReplaying) {
    els.recordBtn.textContent = "Record";
    els.recordBtn.classList.remove("recording");
  } else {
    els.recordBtn.textContent = "Record";
    els.recordBtn.classList.remove("recording");
    els.status.textContent = "idle";
    els.status.className = "status idle";
  }
  updateKillButton();
}

function setReplayingUI(on, name) {
  isReplaying = on;
  if (on) {
    els.status.textContent = "replaying";
    els.status.className = "status replaying";
    els.status.title = name || "";
  } else if (!isRecording) {
    els.status.textContent = "idle";
    els.status.className = "status idle";
    els.status.title = "";
  }
  updateKillButton();
}

async function killRun() {
  const res = await chrome.runtime.sendMessage({ action: "killRun" });
  await refreshStatus();
  if (res && res.ok === false && res.error) {
    alert(res.error);
  }
}

async function refreshStatus() {
  try {
    const s = await chrome.runtime.sendMessage({ action: "sessionStatus" });
    setRecordingUI(!!(s && s.recording));
    setReplayingUI(!!(s && s.replaying), s && s.replayName);
  } catch (e) {
    setRecordingUI(false);
    setReplayingUI(false);
  }
}

async function toggleRecording() {
  if (!isRecording) {
    const res = await chrome.runtime.sendMessage({ action: "startSession" });
    if (res && res.ok) {
      setRecordingUI(true);
    } else {
      alert("Could not start recording: " + (res && res.error));
    }
  } else {
    const name = els.recordName.value.trim();
    const res = await chrome.runtime.sendMessage({
      action: "stopSession",
      name
    });
    setRecordingUI(false);
    els.recordName.value = "";
    if (res && res.saved) {
      await renderList();
      await refreshStorageUsage();
    } else {
      alert("No steps were recorded.");
    }
  }
}

// --------------------------------------------------------------------------
// Recordings list rendering
// --------------------------------------------------------------------------

function currentSlotForRecording(slots, recId) {
  for (const [slotKey, id] of Object.entries(slots)) {
    if (id === recId) return slotKey;
  }
  return "";
}

function formatStepWait(ms) {
  if (!ms || ms < 1) return "";
  if (ms < 1000) return ` (${ms}ms)`;
  return ` (${(ms / 1000).toFixed(1)}s)`;
}

function stepSummary(step) {
  switch (step.type) {
    case "switchTab":
      return "Go to tab";
    case "wait":
      return "Wait: " + (step.ms || 500) + "ms";
    case "waitForElement":
    case "wait": {
      const ms = step.ms || step.loadWaitMs || step.pageLoadMs || step.elementWaitMs || 500;
      return "Timer: " + (step.text || step.selector || "pause") + formatStepWait(ms);
    }
    case "click": {
      const waitMs = step.loadWaitMs || step.pageLoadMs || step.elementWaitMs || step.waitsForMs || 0;
      return (
        "Click: " +
        (step.text || step.selector || "") +
        (waitMs ? formatStepWait(waitMs) : "")
      );
    }
    case "input":
      return "Type: " + JSON.stringify(step.value);
    case "key":
      return "Key: " + step.key;
    case "copy":
      return "Copy from element" + (step.sample ? ` (e.g. "${step.sample}")` : "");
    case "paste":
      return "Paste into field";
    default:
      return step.type;
  }
}

async function renderList() {
  const { recordings, slots } = await getState();
  const ids = Object.keys(recordings).sort(
    (a, b) => recordings[b].createdAt - recordings[a].createdAt
  );

  els.list.innerHTML = "";
  els.empty.style.display = ids.length ? "none" : "block";

  for (const id of ids) {
    const rec = recordings[id];
    const li = document.createElement("li");
    li.className = "rec";
    li.dataset.recId = id;

    const top = document.createElement("div");
    top.className = "rec-top";

    const nameEl = document.createElement("div");
    nameEl.className = "rec-name";
    nameEl.textContent = rec.name;
    nameEl.title = rec.name;

    const actions = document.createElement("div");
    actions.className = "rec-actions";
    actions.appendChild(makeBtn("Play", () => playRecording(id)));
    actions.appendChild(makeBtn("Steps", () => toggleSteps(id, li)));
    actions.appendChild(makeBtn("Rename", () => renameRecording(id)));
    actions.appendChild(makeBtn("Export", () => exportOne(id)));
    actions.appendChild(makeBtn("Delete", () => deleteRecording(id), true));

    top.appendChild(nameEl);
    top.appendChild(actions);

    const meta = document.createElement("div");
    meta.className = "rec-meta";
    meta.textContent = `${rec.steps.length} steps`;

    const bottom = document.createElement("div");
    bottom.className = "rec-bottom";
    const label = document.createElement("label");
    label.textContent = "Hotkey:";
    const select = document.createElement("select");
    const noneOpt = document.createElement("option");
    noneOpt.value = "";
    noneOpt.textContent = "None";
    select.appendChild(noneOpt);
    for (let i = 1; i <= SLOT_COUNT; i++) {
      const opt = document.createElement("option");
      opt.value = "play-slot-" + i;
      opt.textContent = "Slot " + i;
      select.appendChild(opt);
    }
    select.value = currentSlotForRecording(slots, id);
    select.addEventListener("change", () => assignSlot(id, select.value));

    bottom.appendChild(label);
    bottom.appendChild(select);

    li.appendChild(top);
    li.appendChild(meta);
    li.appendChild(bottom);
    els.list.appendChild(li);
  }
}

function makeBtn(label, onClick, danger) {
  const b = document.createElement("button");
  b.className = "btn icon" + (danger ? " danger" : "");
  b.textContent = label;
  b.title = label;
  b.addEventListener("click", onClick);
  return b;
}

// --------------------------------------------------------------------------
// Step viewer / editor
// --------------------------------------------------------------------------

async function refreshStepsPanel(id, li) {
  const existing = li.querySelector(".steps");
  if (existing) existing.remove();
  await toggleSteps(id, li);
}

function buildOptionalToggle(id, idx, step, row) {
  const optWrap = document.createElement("label");
  optWrap.className = "step-opt";
  optWrap.title = "Optional: skip this step if the element doesn't appear";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = !!step.optional;
  cb.addEventListener("change", async () => {
    const state = await getState();
    if (state.recordings[id]) {
      state.recordings[id].steps[idx].optional = cb.checked;
      await setRecordings(state.recordings);
      row.querySelector(".step-tag").className =
        "step-tag" + (cb.checked ? " step-optional" : "");
    }
  });
  optWrap.appendChild(cb);
  optWrap.appendChild(document.createTextNode("opt"));
  return optWrap;
}

function buildInsertForm(id, li, insertAt) {
  const form = document.createElement("div");
  form.className = "step-insert-row";

  const typeSelect = document.createElement("select");
  const types = ["wait", "switchTab", "click", "input", "key", "copy", "paste"];
  for (const t of types) {
    const opt = document.createElement("option");
    opt.value = t;
    opt.textContent = t;
    typeSelect.appendChild(opt);
  }

  const fields = document.createElement("div");
  fields.className = "step-insert-fields";

  function rebuildFields() {
    fields.innerHTML = "";
    const type = typeSelect.value;
    if (type === "wait") {
      const ms = document.createElement("input");
      ms.type = "number";
      ms.placeholder = "ms";
      ms.value = "1000";
      ms.dataset.field = "ms";
      fields.appendChild(ms);
    } else if (type === "switchTab") {
      fields.appendChild(makePresetSelect((preset) => {
        fields.querySelector('[data-field="urlPattern"]').value = preset.urlPattern;
        fields.querySelector('[data-field="href"]').value = preset.href;
      }));
      const urlPattern = document.createElement("input");
      urlPattern.type = "text";
      urlPattern.placeholder = "URL pattern";
      urlPattern.dataset.field = "urlPattern";
      fields.appendChild(urlPattern);
      const href = document.createElement("input");
      href.type = "text";
      href.placeholder = "Full href";
      href.dataset.field = "href";
      fields.appendChild(href);
    } else if (type === "click") {
      const sel = document.createElement("input");
      sel.type = "text";
      sel.placeholder = "selector";
      sel.dataset.field = "selector";
      fields.appendChild(sel);
      const text = document.createElement("input");
      text.type = "text";
      text.placeholder = "text (optional)";
      text.dataset.field = "text";
      fields.appendChild(text);
    } else if (type === "input") {
      const sel = document.createElement("input");
      sel.type = "text";
      sel.placeholder = "selector";
      sel.dataset.field = "selector";
      fields.appendChild(sel);
      const val = document.createElement("input");
      val.type = "text";
      val.placeholder = "value";
      val.dataset.field = "value";
      fields.appendChild(val);
      const inputType = document.createElement("input");
      inputType.type = "text";
      inputType.placeholder = "inputType (text)";
      inputType.value = "text";
      inputType.dataset.field = "inputType";
      fields.appendChild(inputType);
    } else if (type === "key") {
      const key = document.createElement("input");
      key.type = "text";
      key.placeholder = "key (Enter)";
      key.dataset.field = "key";
      fields.appendChild(key);
      const sel = document.createElement("input");
      sel.type = "text";
      sel.placeholder = "selector (optional)";
      sel.dataset.field = "selector";
      fields.appendChild(sel);
    } else if (type === "copy" || type === "paste") {
      const sel = document.createElement("input");
      sel.type = "text";
      sel.placeholder = "selector";
      sel.dataset.field = "selector";
      fields.appendChild(sel);
    }
  }

  typeSelect.addEventListener("change", rebuildFields);
  rebuildFields();

  const actions = document.createElement("div");
  actions.className = "step-insert-actions";
  const confirm = makeBtn("Add", async () => {
    const type = typeSelect.value;
    const step = { type };
    for (const input of fields.querySelectorAll("[data-field]")) {
      const key = input.dataset.field;
      let val = input.value.trim();
      if (key === "ms") val = parseInt(val, 10) || 500;
      else if (key === "value" && (type === "input") && (val === "true" || val === "false")) {
        val = val === "true";
      }
      if (val !== "" && val != null) step[key] = val;
    }
    const state = await getState();
    if (!state.recordings[id]) return;
    state.recordings[id].steps.splice(insertAt, 0, step);
    await setRecordings(state.recordings);
    await refreshStepsPanel(id, li);
    await refreshStorageUsage();
  });
  const cancel = makeBtn("Cancel", () => form.remove());
  actions.appendChild(confirm);
  actions.appendChild(cancel);

  form.appendChild(typeSelect);
  form.appendChild(fields);
  form.appendChild(actions);
  return form;
}

async function toggleSteps(id, li) {
  const existing = li.querySelector(".steps");
  if (existing) {
    existing.remove();
    return;
  }
  const { recordings } = await getState();
  const rec = recordings[id];
  if (!rec) return;

  const box = document.createElement("div");
  box.className = "steps";

  rec.steps.forEach((step, idx) => {
    const row = document.createElement("div");
    row.className = "step-row";

    const insertAfter = makeBtn("+", () => {
      if (row.nextElementSibling && row.nextElementSibling.classList.contains("step-insert-row")) {
        return;
      }
      row.after(buildInsertForm(id, li, idx + 1));
    });
    insertAfter.className = "btn icon step-insert-after";
    insertAfter.title = "Insert step after";
    row.appendChild(insertAfter);

    const tag = document.createElement("span");
    tag.className = "step-tag" + (step.optional ? " step-optional" : "");
    tag.textContent =
      idx + 1 + ". " + (step.optional ? "[opt] " : "") + stepSummary(step);
    row.appendChild(tag);

    if (step.type === "switchTab") {
      row.appendChild(
        makePresetSelect((preset) => {
          step.urlPattern = preset.urlPattern;
          step.href = preset.href;
          const urlInput = row.querySelector(".step-url");
          if (urlInput) urlInput.value = preset.urlPattern;
          getState().then((state) => {
            if (state.recordings[id]) {
              state.recordings[id].steps[idx].urlPattern = preset.urlPattern;
              state.recordings[id].steps[idx].href = preset.href;
              setRecordings(state.recordings);
            }
          });
        })
      );
      const input = document.createElement("input");
      input.type = "text";
      input.className = "step-url";
      input.value = step.urlPattern || step.href || "";
      input.title = "URL substring used to find this tab on replay";
      input.addEventListener("change", async () => {
        const state = await getState();
        if (state.recordings[id]) {
          state.recordings[id].steps[idx].urlPattern = input.value.trim();
          await setRecordings(state.recordings);
        }
      });
      row.appendChild(input);
    } else if (step.type === "input") {
      if (step.inputType === "checkbox" || step.inputType === "radio") {
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = !!step.value;
        cb.title = "Checked state";
        cb.addEventListener("change", async () => {
          const state = await getState();
          if (state.recordings[id]) {
            state.recordings[id].steps[idx].value = cb.checked;
            await setRecordings(state.recordings);
            tag.textContent =
              idx + 1 + ". " + (step.optional ? "[opt] " : "") + stepSummary(state.recordings[id].steps[idx]);
          }
        });
        row.appendChild(cb);
      } else {
        const input = document.createElement("input");
        input.type = "text";
        input.className = "step-value";
        input.value = step.value != null ? String(step.value) : "";
        input.title = "Value to type on replay";
        input.addEventListener("change", async () => {
          const state = await getState();
          if (state.recordings[id]) {
            state.recordings[id].steps[idx].value = input.value;
            await setRecordings(state.recordings);
            tag.textContent =
              idx + 1 + ". " + (step.optional ? "[opt] " : "") + stepSummary(state.recordings[id].steps[idx]);
          }
        });
        row.appendChild(input);
      }
      row.appendChild(buildOptionalToggle(id, idx, step, row));
    } else if (step.type === "key") {
      const input = document.createElement("input");
      input.type = "text";
      input.className = "step-key";
      input.value = step.key || "";
      input.title = "Key to press";
      input.addEventListener("change", async () => {
        const state = await getState();
        if (state.recordings[id]) {
          state.recordings[id].steps[idx].key = input.value.trim();
          await setRecordings(state.recordings);
          tag.textContent =
            idx + 1 + ". " + (step.optional ? "[opt] " : "") + stepSummary(state.recordings[id].steps[idx]);
        }
      });
      row.appendChild(input);
      row.appendChild(buildOptionalToggle(id, idx, step, row));
    } else if (step.type === "wait") {
      const input = document.createElement("input");
      input.type = "number";
      input.className = "step-value";
      input.value = step.ms || 500;
      input.title = "Wait duration in ms";
      input.addEventListener("change", async () => {
        const state = await getState();
        if (state.recordings[id]) {
          state.recordings[id].steps[idx].ms = parseInt(input.value, 10) || 500;
          await setRecordings(state.recordings);
          tag.textContent =
            idx + 1 + ". " + stepSummary(state.recordings[id].steps[idx]);
        }
      });
      row.appendChild(input);
    } else if (step.type !== "switchTab") {
      row.appendChild(buildOptionalToggle(id, idx, step, row));
    }

    const del = document.createElement("button");
    del.className = "btn icon danger step-del";
    del.textContent = "x";
    del.title = "Delete step";
    del.addEventListener("click", async () => {
      const state = await getState();
      if (state.recordings[id]) {
        state.recordings[id].steps.splice(idx, 1);
        await setRecordings(state.recordings);
        await refreshStepsPanel(id, li);
        const meta = li.querySelector(".rec-meta");
        if (meta) meta.textContent = state.recordings[id].steps.length + " steps";
        await refreshStorageUsage();
      }
    });
    row.appendChild(del);

    box.appendChild(row);
  });

  const insertBottom = makeBtn("+ Insert step", () => {
    if (box.querySelector(".step-insert-row")) return;
    box.appendChild(buildInsertForm(id, li, rec.steps.length));
  });
  insertBottom.className = "btn small step-insert-btn";
  box.appendChild(insertBottom);

  li.appendChild(box);
}

// --------------------------------------------------------------------------
// Recording actions
// --------------------------------------------------------------------------

async function playRecording(id) {
  const res = await chrome.runtime.sendMessage({
    action: "playRecording",
    recordingId: id
  });
  await refreshStatus();
  if (res && res.ok === false) {
    if (res.stopped) return;
    alert("Replay failed: " + (res.error || "unknown error"));
  }
}

async function renameRecording(id) {
  const { recordings } = await getState();
  const rec = recordings[id];
  if (!rec) return;
  const name = prompt("Rename recording:", rec.name);
  if (name === null) return;
  rec.name = name.trim() || rec.name;
  await setRecordings(recordings);
  await renderList();
}

async function deleteRecording(id) {
  if (!confirm("Delete this recording?")) return;
  const { recordings, slots } = await getState();
  delete recordings[id];
  for (const slotKey of Object.keys(slots)) {
    if (slots[slotKey] === id) delete slots[slotKey];
  }
  await setRecordings(recordings);
  await setSlots(slots);
  await renderList();
  await refreshStorageUsage();
}

async function assignSlot(recId, slotKey) {
  const { slots } = await getState();
  for (const key of Object.keys(slots)) {
    if (slots[key] === recId) delete slots[key];
  }
  if (slotKey) slots[slotKey] = recId;
  await setSlots(slots);
  await renderList();
}

// --------------------------------------------------------------------------
// Import / export
// --------------------------------------------------------------------------

function downloadJson(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function exportAll() {
  const { recordings, slots } = await getState();
  const settingsRes = await chrome.runtime.sendMessage({ action: "getSettings" });
  const presetsRes = await chrome.runtime.sendMessage({ action: "getDomainPresets" });
  downloadJson("input-recordings.json", {
    recordings,
    slots,
    settings: settingsRes && settingsRes.settings,
    domainPresets: presetsRes && presetsRes.domainPresets
  });
}

async function exportOne(id) {
  const { recordings } = await getState();
  const rec = recordings[id];
  if (!rec) return;
  const safe = rec.name.replace(/[^\w-]+/g, "_").slice(0, 40);
  downloadJson(`recording-${safe}.json`, { recordings: { [id]: rec }, slots: {} });
}

async function importFromFile(file) {
  const text = await file.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    alert("Invalid JSON file.");
    return;
  }
  const incoming = data.recordings || {};
  if (!Object.keys(incoming).length) {
    alert("No recordings found in that file.");
    return;
  }
  const { recordings, slots } = await getState();
  for (const [id, rec] of Object.entries(incoming)) {
    recordings[id] = rec;
  }
  if (data.slots) Object.assign(slots, data.slots);
  await setRecordings(recordings);
  await setSlots(slots);
  if (data.settings) {
    await chrome.runtime.sendMessage({ action: "setSettings", settings: data.settings });
    await loadSettings();
  }
  if (data.domainPresets) {
    domainPresets = data.domainPresets;
    await savePresets();
    renderPresetsList();
  }
  await renderList();
  await refreshStorageUsage();
  alert(`Imported ${Object.keys(incoming).length} recording(s).`);
}

// --------------------------------------------------------------------------
// Wire up
// --------------------------------------------------------------------------

els.recordBtn.addEventListener("click", toggleRecording);
els.killBtn.addEventListener("click", killRun);
els.exportBtn.addEventListener("click", exportAll);
els.importBtn.addEventListener("click", () => els.importFile.click());
els.importFile.addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) importFromFile(file);
  e.target.value = "";
});
els.shortcutsLink.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});
els.settingsToggle.addEventListener("click", () => {
  const hidden = els.settingsPanel.hasAttribute("hidden");
  if (hidden) els.settingsPanel.removeAttribute("hidden");
  else els.settingsPanel.setAttribute("hidden", "");
});
els.openTabIfMissing.addEventListener("change", saveSettings);
els.debugOverlay.addEventListener("change", saveSettings);
els.verboseDebug.addEventListener("change", saveSettings);
els.addPresetBtn.addEventListener("click", addPreset);

(async function init() {
  await loadSettings();
  await loadPresets();
  await renderList();
  await refreshStatus();
  await refreshStorageUsage();
  setInterval(refreshStatus, 1500);
})();
