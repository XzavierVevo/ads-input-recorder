# Input Recorder & Replayer

A personal Manifest V3 Chromium extension (built for AdsPower SunBrowser, the Chrome variant) that records your mouse clicks and keyboard input on a page, saves them as JSON, and replays them. Recorded clicks are located by robust DOM selectors, and every replay step uses a **smart wait** so it fires the instant its target element is ready (and patiently waits when something is still loading).

## What it does

- Record clicks, form input (text, checkboxes, radios, selects), and standalone keys (Enter, Tab, Escape, arrows, Backspace, Delete).
- Record text input via live `input` events (debounced) so fast typing is captured reliably.
- Replay a recording step by step. Before each step it waits up to 10 seconds for the target element to exist and be visible/enabled, then acts immediately. If an element never appears, it stops and tells you which step failed.
- React-friendly input replay: values are set in a way that React-controlled fields recognize.
- Custom dropdowns (non-native `<select>`) are handled by matching the option's visible text and ARIA role, so it picks the right option even when class names are auto-generated.
- Multi-tab workflows: switch tabs while recording and it captures the switch (matched on replay by a URL substring you can edit).
- Cross-tab copy/paste of values that change every run: select text and Ctrl+C on one tab, Ctrl+V into a field on another. On replay it reads the source element's LIVE value and pastes the current value (not the value from recording time).
- Save unlimited named recordings in the extension's local storage.
- View/edit a recording's steps (edit tab-switch URL patterns, input values, wait durations, delete steps, insert steps manually).
- Export/import all recordings to a `.json` file for backup (includes settings and domain presets).
- Assign any recording to one of 4 hotkey "slots" and trigger it with a keyboard shortcut even when the popup is closed. (Chromium caps extensions at 4 keyboard commands.)
- Press **Escape** during replay to stop.
- Optional global setting to **open tabs automatically** when a switch-tab step can't find a matching open tab.
- Domain presets (TikTok Ads Manager, TikTok Business Center, plus your own) for quick tab-switch URL setup.
- Storage usage indicator in the popup footer.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | Extension config, permissions, and hotkey command slots. |
| `background.js` | Service worker: storage, hotkey routing, content-script injection. |
| `content.js` | Runs on the page: recording, selector generation, replay engine. |
| `popup.html` / `popup.css` / `popup.js` | The extension UI. |

## Install in AdsPower SunBrowser

1. Open the browser profile you want to use.
2. Go to the extensions page (`chrome://extensions`).
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select this folder (the one containing `manifest.json`).
5. The extension icon appears in the toolbar. Pin it for easy access.

> Note: a browser extension cannot rewrite its own bundled files at runtime, so recordings are stored in the extension's local storage. Use **Export** to save them to a `.json` file and **Import** to restore them.

## How to use

### Record

1. Open the page you want to automate.
2. Click the extension icon, optionally type a name, and click **Record**.
3. Perform your clicks and typing on the page.
4. Click the icon again and press **Stop**. The recording is saved automatically.

### Replay

- From the popup, click **Play** on any recording. It runs starting from the first tab the recording was made on (it will switch to the matching tab automatically).
- Or assign the recording to a hotkey slot (below) and press its key.
- Press **Escape** at any time during replay to stop.

### Cross-tab copy/paste (values that change every time)

1. Start recording on your form tab.
2. Switch to the other tab (this switch is recorded). Open that tab beforehand so it exists at replay time, or enable **Open tab if missing** in Settings.
3. Select the text you need and press **Ctrl+C**. The extension records WHICH element you copied from, not the value.
4. Switch back to your form tab (recorded) and **Ctrl+V** into the destination field.
5. Stop recording.

On replay, the extension switches to the matching tab, reads that element's current value, switches back, and pastes the live value into the field. If the tab is identified incorrectly, open the recording's **Steps** and edit the "Go to tab" URL substring, or apply a domain preset.

Notes:
- By default, source/destination tabs must already be open when you replay. Enable **Open tab if missing** in Settings to create tabs automatically.
- "Copy" grabs the full text of the element your selection was in (select an element that contains exactly the value you need).

### Settings

Open **Settings** in the popup:

- **Open tab if missing during replay** — when a switch-tab step can't find a matching open tab, open the recorded URL in a new tab and continue.
- **Domain presets** — pre-configured URL patterns (TikTok Ads Manager, TikTok Business Center). Use "Apply preset…" on switch-tab steps or when inserting steps. Add your own presets with **Add**.

### Optional steps (elements that only sometimes appear)

TikTok sometimes shows extra popups/elements and sometimes doesn't. To stop replay from getting stuck waiting for something that isn't there:

1. Open a recording's **Steps**.
2. Tick the **opt** checkbox next to any step that might not appear every run.

Optional steps wait only briefly (3 seconds) for their element. If it shows up, the step runs; if not, replay **skips it and continues** instead of failing. Required (non-optional) steps still wait up to 10 seconds and stop replay if they fail.

### Manual steps

In the **Steps** editor you can:

- Edit input values, key names, wait durations, and tab URL patterns inline.
- Insert new steps (+ between rows, or **+ Insert step** at the bottom): wait, switch tab, click, input, key, copy, paste.
- Delete steps with **x**.

### Hotkeys

1. In the popup, set a recording's **Hotkey** dropdown to a slot (Slot 1-4).
2. Open `chrome://extensions/shortcuts` (there's a link in the popup footer).
3. Find "Input Recorder & Replayer" and assign a key combo to the matching slot (e.g. "Play recording in slot 1"). Slots 1-4 have suggested defaults (Alt+Shift+1..4) you can change.
4. Press the key on any page to replay that slot's recording. Empty slots show a toast on the active tab.

## How replay timing works (smart waits)

There are no hardcoded delays except optional **wait** steps you insert manually. Before each action step, the replay engine polls (every ~100 ms, up to 10 s) for the step's target element to be present and visible. Steps whose elements are already on screen fire instantly; steps whose elements are still loading (e.g. a popup that takes a moment) wait exactly as long as needed and no longer. This is the same approach used by tools like Playwright and Selenium.

## Limitations

- Selector-based, not pixel-coordinate based, so it survives layout shifts but depends on the page structure staying broadly similar.
- Cross-tab replay matches an open tab by URL substring, or opens one if the global setting is enabled.
- The recorder now runs inside iframes too (so embedded card forms, paste targets, etc. can be recorded/replayed). However, some PCI payment iframes reject programmatically-set values (they require real keystrokes), so card number/CVV fields may still not accept automated input - test your specific form.
- If two clickable elements share identical text, the click falls back to DOM order.
- For your personal use only; no syncing or sharing built in.

## Important: re-record after upgrading

This version records which iframe each step came from. Recordings made before this version won't have that info (their iframe steps are simply missing). After loading this build, re-record any workflow that touches embedded fields (like the card form) so the in-iframe steps get captured.
