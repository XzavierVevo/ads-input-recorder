// Input Recorder & Replayer - content script.
// Captures user input (and copy/paste) and forwards each step to the background
// session. Also exposes per-step "execute" primitives used by the background
// replay orchestrator (timer-based waits only; no DOM polling).

(() => {
  if (window.__inputRecorderInjected) return;
  window.__inputRecorderInjected = true;

  const STANDALONE_KEYS = new Set([
    "Enter",
    "Tab",
    "Escape",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "Backspace",
    "Delete"
  ]);

  let recording = false;
  const pendingInputTimers = new Map();
  const INPUT_DEBOUNCE_MS = 250;
  const CLICK_LABEL_MAX = 80;
  let abortKeyHandler = null;
  let stepCanceled = false; // set when replay is aborted mid-step
  let verboseTrace = true;
  let waitBannerEl = null;
  let waitBannerDetail = null;

  function trace(kind, text) {
    if (!verboseTrace && kind !== "fail") return;
    if (window.top !== window.self) return;
    ensureDebugPanel();
    debugLog("trace", `[${kind}] ${text}`, {
      color:
        kind === "fail"
          ? "#ff6b6b"
          : kind === "ok"
            ? "#5fd38b"
            : kind === "wait"
              ? "#ffb347"
              : "#aaa"
    });
    try {
      chrome.runtime.sendMessage({ action: "traceLog", kind, text });
    } catch (e) {
      /* ignore */
    }
  }

  function setWaitStatus(label, detail) {
    if (window.top !== window.self) return;
    if (!waitBannerEl) {
      waitBannerEl = document.createElement("div");
      waitBannerEl.setAttribute("data-ire-overlay", "1");
      waitBannerEl.style.cssText =
        "position:fixed;z-index:2147483646;top:12px;left:50%;transform:translateX(-50%);" +
        "padding:8px 16px;border-radius:8px;font:13px/1.35 system-ui,sans-serif;" +
        "color:#fff;box-shadow:0 4px 18px rgba(0,0,0,.35);pointer-events:none;" +
        "max-width:90vw;text-align:center;";
      waitBannerDetail = document.createElement("div");
      waitBannerDetail.style.cssText =
        "font-size:11px;opacity:.85;margin-top:3px;font-weight:400;";
      waitBannerEl.appendChild(document.createElement("span"));
      waitBannerEl.appendChild(waitBannerDetail);
      document.documentElement.appendChild(waitBannerEl);
    }
    waitBannerEl.style.background = detail && /timeout|fail|no match/i.test(detail) ? "#c0392b" : "#8e44ad";
    waitBannerEl.firstChild.textContent = "Waiting for: " + (label || "?");
    waitBannerDetail.textContent = detail || "";
    waitBannerDetail.style.display = detail ? "block" : "none";
  }

  function clearWaitStatus() {
    if (waitBannerEl && waitBannerEl.parentNode) {
      waitBannerEl.parentNode.removeChild(waitBannerEl);
      waitBannerEl = null;
      waitBannerDetail = null;
    }
  }

  function textMatches(want, got) {
    if (!want || !got) return false;
    if (want === got) return true;
    if (got.startsWith(want) || want.startsWith(got)) return true;
    const minLen = Math.min(want.length, got.length, 40);
    if (minLen >= 20 && want.slice(0, minLen) === got.slice(0, minLen)) return true;
    return false;
  }

  function normalizeStepText(text) {
    if (!text) return "";
    const t = text.replace(/\s+/g, " ").trim();
    return t.length <= CLICK_LABEL_MAX ? t : t.slice(0, CLICK_LABEL_MAX);
  }

  function isOversizedTarget(el, labelLen) {
    if (!el) return true;
    const rect = el.getBoundingClientRect();
    const huge =
      rect.width > window.innerWidth * 0.45 &&
      rect.height > window.innerHeight * 0.35;
    const textLen = fullText(el).length;
    const limit = Math.max((labelLen || 40) * 3, 120);
    return huge || textLen > limit;
  }

  // A click target whose own text is far larger than its label is almost always
  // a wrapper/section, not the intended control. Generic, no site-specific text.
  function isCompositeCapture(el, label) {
    if (!el || !label) return false;
    const raw = fullText(el).replace(/\s+/g, " ").trim();
    return raw.length > label.length + 40;
  }

  function isNativeClickable(el) {
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === "button" || tag === "a") return true;
    if (tag.startsWith("ks-")) return true;
    const role = getRole(el);
    return role === "button" || role === "link" || role === "menuitem";
  }

  function isInsideModal(el) {
    let node = el;
    while (node) {
      if (node.closest) {
        const hit = node.closest('ks-modal, [role="dialog"], [role="alertdialog"]');
        if (hit) return true;
      }
      // Climb out of a shadow root to its host and keep looking.
      const root = node.getRootNode && node.getRootNode();
      node = root && root.host ? root.host : null;
    }
    return false;
  }

  function queryAllDeep(root, selector) {
    const out = [];
    function walk(node) {
      if (!node) return;
      if (node.querySelectorAll) {
        try {
          node.querySelectorAll(selector).forEach((el) => out.push(el));
        } catch (e) {
          /* ignore */
        }
      }
      if (node.shadowRoot) walk(node.shadowRoot);
      if (node.children) {
        for (const ch of node.children) walk(ch);
      }
    }
    walk(root || document.body);
    return out;
  }

  function findLabeledClickable(textRe, opts) {
    if (!document.body || !textRe) return null;
    const allowModal = !!(opts && opts.allowModal);

    function consider(el, best, bestScore) {
      if (!isVisible(el)) return { best, bestScore };
      if (!allowModal && isInsideModal(el)) return { best, bestScore };
      const t = fullText(el).replace(/\s+/g, " ").trim();
      if (!textRe.test(t)) return { best, bestScore };
      if (isOversizedTarget(el, Math.min(t.length, 40))) return { best, bestScore };
      const native = isNativeClickable(el);
      const score = t.length + (native ? 0 : 200);
      if (score < bestScore) return { best: el, bestScore: score };
      return { best, bestScore };
    }

    function scanNodes(nodes) {
      let best = null;
      let bestScore = Infinity;
      for (const el of nodes) {
        const next = consider(el, best, bestScore);
        best = next.best;
        bestScore = next.bestScore;
      }
      return best;
    }

    const native = scanNodes(
      queryAllDeep(document.body, "button, a, [role='button'], [role='link'], ks-button")
    ) || scanNodes(document.body.querySelectorAll("span, div, p, li, label"));
    if (!native) return null;
    return isNativeClickable(native) ? native : tightenToClickable(native, fullText(native));
  }

  function labelToClickRegex(label) {
    if (!label) return null;
    const escaped = String(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^${escaped}$`, "i");
  }

  function findByStepLabel(step) {
    const label = normalizeStepText(step && step.text ? step.text : "");
    if (!label || label.length > 80) return null;
    const opts = { allowModal: stepInModal(step) };
    return findLabeledClickable(labelToClickRegex(label), opts);
  }

  function tightenToClickable(el, wantText) {
    if (!el) return el;
    const want = wantText ? normalizeStepText(String(wantText)) : "";
    let best = isNativeClickable(el) ? el : null;
    let bestScore = best
      ? fullText(best).length - (isNativeClickable(best) ? 1000 : 0)
      : Infinity;

    const nodes = el.querySelectorAll(
      "button, a, [role='button'], [role='link'], ks-button, span, div"
    );
    for (const node of nodes) {
      if (!isVisible(node)) continue;
      const t = fullText(node).replace(/\s+/g, " ").trim();
      if (want && !textMatches(want, t) && !t.includes(want)) continue;
      const native = isNativeClickable(node);
      const score = t.length - (native ? 1000 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = node;
      }
    }

    if (best) return best;
    const parent =
      el.closest &&
      el.closest('button, a, [role="button"], [role="link"], ks-button');
    return parent && isVisible(parent) ? parent : el;
  }

  function finalizeClickTarget(el, step) {
    if (!el) return el;
    // Tighten a wrapper to its inner clickable, but do NOT re-resolve by text
    // label here: that would override a faithful selector/scored match with a
    // same-text node (e.g. a toggle's separate label), which breaks toggles.
    const label = normalizeStepText(step.text || "");
    return tightenToClickable(el, label || step.text);
  }

  function cssEscape(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  // Escape a value for use INSIDE a quoted attribute selector: [a="value"].
  function attrVal(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  // Heuristic: does a token look like an auto-generated random id (e.g. "ctk7NX")?
  function looksRandom(token) {
    if (!/^[A-Za-z0-9]{5,12}$/.test(token)) return false;
    const hasUpper = /[A-Z]/.test(token);
    const hasLower = /[a-z]/.test(token);
    const hasDigit = /[0-9]/.test(token);
    return (hasUpper && hasLower) || (hasDigit && (hasUpper || hasLower));
  }

  // If an attribute value ends with a random token ("...-ctk7NX"), return the
  // stable prefix (including the trailing dash); otherwise null.
  function randomSuffixPrefix(val) {
    const i = val.lastIndexOf("-");
    if (i > 0 && looksRandom(val.slice(i + 1))) return val.slice(0, i + 1);
    return null;
  }

  // Is this an auto-generated custom-element tag (random suffix)?
  // TikTok's design-system tags carry a volatile per-instance suffix
  // (ks-button-1-1-1g, ks-text-nw0pz335, ks-icon-search-8myphpu4), so any
  // ks-* tag is treated as volatile - selectors use its stable class/attrs.
  function isRandomTag(tag) {
    if (/^ks-/.test(tag)) return true;
    const parts = tag.split("-");
    return parts.length >= 2 && looksRandom(parts[parts.length - 1]);
  }

  // TikTok class names worth keying on: PascalCase design-system (KsButton) or
  // BEM/semantic (notification-category-chip, got-btn, advertiser_name). Skips
  // utility/hashed/volatile classes (tb-*, css-*, Tailwind arbitrary [..], the
  // generic "hydrated"/"ks-icon" markers, and random hash tokens).
  function isStableClass(cls) {
    if (!cls || cls.length < 3 || cls.length > 40) return false;
    if (cls.indexOf("[") !== -1 || cls.indexOf("]") !== -1) return false;
    if (/^(tb-|css-|sc-|jsx-|chakra-|emotion-)/.test(cls)) return false;
    if (cls === "hydrated" || cls === "ks-icon" || cls === "KsIcon") return false;
    if (looksRandom(cls)) return false;
    return (
      /[A-Z]/.test(cls) ||
      cls.indexOf("-") !== -1 ||
      cls.indexOf("_") !== -1 ||
      /^[a-z]{3,}$/.test(cls)
    );
  }

  function stableClassSelector(el, tag) {
    if (!el.classList || !el.classList.length) return null;
    const stable = Array.from(el.classList).filter(isStableClass);
    if (!stable.length) return null;
    return (tag || "") + stable.map((c) => "." + cssEscape(c)).join("");
  }

  // TikTok's most reliable hook: semantic analytics attributes that survive
  // reloads/builds. data-cta_name names the action (e.g. "notification_tab_all").
  // Ordered most- to least- uniquely-identifying. data-testid usually names a
  // single control (campaign_objective_updateObjectiveType5); data-tea names an
  // action shared by siblings (every objective shares create_campaign_objective_click),
  // so it comes after and is only used when it resolves uniquely (else scoped).
  const TIKTOK_STABLE_ATTRS = [
    "data-testid",
    "data-e2e",
    "data-btm",
    "data-cta_name",
    "data-tea",
    "data-report-click",
    "data-expose_placement"
  ];

  // Rewrite a selector so volatile attribute values match by stable prefix.
  // Lets recordings made with exact (random) ids still match after a reload.
  function stabilizeSelector(selector) {
    if (!selector) return selector;
    return selector.replace(/\[([\w-]+)="([^"]*)"\]/g, (m, attr, val) => {
      const prefix = randomSuffixPrefix(val);
      return prefix ? `[${attr}^="${attrVal(prefix)}"]` : m;
    });
  }

  // Extract a leading stable "#id" anchor from a selector path (e.g.
  // "#campaign-budget-optimization > div ..." -> "campaign-budget-optimization").
  function leadingStableId(selector) {
    const m = selector && selector.match(/^#([\w-]+)/);
    if (m && !looksRandom(m[1])) return m[1];
    return null;
  }

  // A stable anchor selector for an element (used to scope ambiguous selectors).
  function stableAnchorFor(node) {
    if (node.id && !looksRandom(node.id) && isUnique(`#${cssEscape(node.id)}`)) {
      return `#${cssEscape(node.id)}`;
    }
    for (const attr of TIKTOK_STABLE_ATTRS) {
      const val = node.getAttribute && node.getAttribute(attr);
      if (!val) continue;
      const prefix = randomSuffixPrefix(val);
      const sel = prefix
        ? `[${attr}^="${attrVal(prefix)}"]`
        : `[${attr}="${attrVal(val)}"]`;
      if (isUnique(sel)) return sel;
    }
    const cls = stableClassSelector(node, "");
    if (cls && isUnique(cls)) return cls;
    return null;
  }

  // When a local selector matches multiple elements, scope it under the nearest
  // stable ancestor to make it unique (e.g. the CBO toggle vs the split-test
  // toggle, which share "switch-container-index-" but live in different boxes).
  function scopeUnderStableAncestor(el, localSel) {
    if (!localSel) return null;
    let node = el.parentElement;
    let hops = 0;
    while (node && node !== document.documentElement && hops < 10) {
      const anchor = stableAnchorFor(node);
      if (anchor) {
        const scoped = `${anchor} ${localSel}`;
        if (isUnique(scoped)) return scoped;
      }
      node = node.parentElement;
      hops++;
    }
    return null;
  }

  function isUnique(selector) {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch (e) {
      return false;
    }
  }

  function nthOfTypeIndex(el) {
    let i = 1;
    let sib = el.previousElementSibling;
    while (sib) {
      if (sib.tagName === el.tagName) i++;
      sib = sib.previousElementSibling;
    }
    return i;
  }

  // Build a reasonably unique CSS selector for an element.
  function buildSelector(el) {
    if (!(el instanceof Element)) return null;

    if (el.id && !looksRandom(el.id) && isUnique(`#${cssEscape(el.id)}`)) {
      return `#${cssEscape(el.id)}`;
    }

    const tagName = el.tagName.toLowerCase();
    // Drop the tag from attribute selectors if it's an auto-generated element.
    const tag = isRandomTag(tagName) ? "" : tagName;

    // TikTok stable semantic attributes first (data-cta_name, data-testid, ...).
    // These name the action and survive reloads, unlike ks-* tags / hashed
    // classes. Try the element itself, then a clickable ancestor that carries
    // the hook (the analytics attr often sits on the wrapper).
    for (const attr of TIKTOK_STABLE_ATTRS) {
      let host = el;
      let hops = 0;
      while (host && host !== document.body && hops < 4) {
        const val = host.getAttribute && host.getAttribute(attr);
        if (val) {
          const prefix = randomSuffixPrefix(val);
          const sel = prefix
            ? `[${attr}^="${attrVal(prefix)}"]`
            : `[${attr}="${attrVal(val)}"]`;
          if (isUnique(sel)) return sel;
          const scoped = scopeUnderStableAncestor(host, sel);
          if (scoped) return scoped;
          break;
        }
        host = host.parentElement;
        hops++;
      }
    }

    const dataAttrs = ["data-id", "data-qa", "name"];
    for (const attr of dataAttrs) {
      const val = el.getAttribute && el.getAttribute(attr);
      if (!val) continue;
      const prefix = randomSuffixPrefix(val);
      if (prefix) {
        // Volatile suffix: match by stable prefix, disambiguated if needed.
        const base = `${tag}[${attr}^="${attrVal(prefix)}"]`;
        if (isUnique(base)) return base;
        const aria = el.getAttribute("aria-label");
        if (aria) {
          const asel = `${base}[aria-label="${attrVal(aria)}"]`;
          if (isUnique(asel)) return asel;
        }
        const type = el.getAttribute("type");
        if (type) {
          const tsel = `${base}[type="${attrVal(type)}"]`;
          if (isUnique(tsel)) return tsel;
        }
        // Ambiguous (e.g. several toggles): scope under a stable ancestor.
        const scoped = scopeUnderStableAncestor(el, base);
        if (scoped) return scoped;
        return base; // best effort; resolver picks the visible/best match
      }
      const sel = `${tag}[${attr}="${attrVal(val)}"]`;
      if (isUnique(sel)) return sel;
      const scopedExact = scopeUnderStableAncestor(el, sel);
      if (scopedExact) return scopedExact;
    }

    // Role-based local selector, scoped under a stable ancestor when needed
    // (helps toggles/switches whose only stable hook is role + a container).
    const role = el.getAttribute && el.getAttribute("role");
    if (role) {
      const roleSel = `${tag}[role="${attrVal(role)}"]`;
      if (isUnique(roleSel)) return roleSel;
      const scopedRole = scopeUnderStableAncestor(el, roleSel);
      if (scopedRole) return scopedRole;
    }

    // Scope under a stable parent id (e.g. #fieldRenderer-objectiveType).
    const labelText = fullText(el);
    let parent = el.parentElement;
    let parentHops = 0;
    while (parent && parent !== document.documentElement && parentHops < 8) {
      if (parent.id && !looksRandom(parent.id)) {
        const anchor = `#${cssEscape(parent.id)}`;
        if (role) {
          const scoped = `${anchor} [role="${attrVal(role)}"]`;
          if (isUnique(scoped)) return scoped;
        }
        const btnScoped = `${anchor} button, ${anchor} [role="button"]`;
        if (labelText && isUnique(btnScoped)) return btnScoped;
      }
      parent = parent.parentElement;
      parentHops++;
    }

    const classSel = stableClassSelector(el, tag);
    if (classSel) {
      if (isUnique(classSel)) return classSel;
      const scopedClass = scopeUnderStableAncestor(el, classSel);
      if (scopedClass) return scopedClass;
    }

    const path = [];
    let node = el;
    while (
      node &&
      node.nodeType === Node.ELEMENT_NODE &&
      node !== document.documentElement
    ) {
      let seg = node.tagName.toLowerCase();
      if (node.id && isUnique(`#${cssEscape(node.id)}`)) {
        path.unshift(`#${cssEscape(node.id)}`);
        break;
      }
      seg += `:nth-of-type(${nthOfTypeIndex(node)})`;
      path.unshift(seg);
      node = node.parentElement;
    }
    return path.join(" > ");
  }

  // Full trimmed text, used for exact-match locating of clickable targets.
  function fullText(el) {
    if (!el) return "";
    let t = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    // Shadow hosts report empty text; fall back to their shadow content.
    if (!t && el.shadowRoot) {
      t = (el.shadowRoot.textContent || "").replace(/\s+/g, " ").trim();
    }
    return t;
  }

  // Text belonging directly to this node (not deep nested page content).
  function directText(el) {
    if (!el) return "";
    const parts = [];
    for (const ch of el.childNodes) {
      if (ch.nodeType === Node.TEXT_NODE) {
        const t = ch.textContent.replace(/\s+/g, " ").trim();
        if (t) parts.push(t);
      } else if (ch.nodeType === Node.ELEMENT_NODE) {
        const tag = ch.tagName.toLowerCase();
        if (tag === "script" || tag === "style") continue;
        const t = (ch.innerText || ch.textContent || "").replace(/\s+/g, " ").trim();
        if (t && t.length <= CLICK_LABEL_MAX) parts.push(t);
      }
    }
    const joined = parts.join(" ").trim();
    return joined.length <= CLICK_LABEL_MAX ? joined : "";
  }

  function clickLabel(el) {
    const aria = ariaAnchor(el);
    if (aria && aria.length <= CLICK_LABEL_MAX) return aria;
    const direct = directText(el);
    if (direct) return direct;
    const ft = fullText(el);
    if (ft.length <= CLICK_LABEL_MAX) return ft;
    return normalizeStepText(ft);
  }

  // Walk up the ancestor chain, crossing shadow-DOM boundaries (parentElement
  // stops at a shadow root; composedPath / getRootNode().host continue upward).
  function ancestorChain(el, path) {
    const chain = [];
    if (path && path.length) {
      for (const n of path) {
        if (n instanceof Element) chain.push(n);
        if (n === document.body) break;
      }
      if (chain.length) return chain;
    }
    let node = el;
    while (node && node !== document.body) {
      chain.push(node);
      let parent = node.parentElement;
      if (!parent) {
        const root = node.getRootNode && node.getRootNode();
        if (root && root.host) parent = root.host; // cross shadow boundary
      }
      node = parent;
    }
    return chain;
  }

  function refineRecordTarget(el, e, path) {
    if (!(el instanceof Element)) return el;
    // Only trust elementFromPoint when there's no composed path; it cannot
    // pierce shadow DOM and would return the shadow host instead of the button.
    if (
      (!path || !path.length) &&
      e &&
      typeof e.clientX === "number" &&
      typeof e.clientY === "number"
    ) {
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      if (hit instanceof Element && !isOwnUI(hit)) el = hit;
    }

    let best = el;
    let bestLen = clickLabel(el).length || 9999;
    for (const node of ancestorChain(el, path)) {
      if (node === document.body || node === document.documentElement) break;
      const label = clickLabel(node);
      if (
        label &&
        label.length <= CLICK_LABEL_MAX &&
        label.length < bestLen &&
        !isOversizedTarget(node, label.length)
      ) {
        best = node;
        bestLen = label.length;
      }
      if (node.matches && node.matches(CLICKABLE)) {
        const lbl = clickLabel(node);
        if (lbl && lbl.length <= CLICK_LABEL_MAX && lbl.length <= bestLen) {
          best = node;
          bestLen = lbl.length;
        }
      }
    }
    return best;
  }

  // Read the live value/text of an element (inputs use .value, others use text).
  function readValue(el) {
    if (!el) return "";
    const tag = el.tagName ? el.tagName.toLowerCase() : "";
    if (tag === "input" || tag === "textarea" || tag === "select") {
      return el.value != null ? String(el.value) : "";
    }
    return fullText(el);
  }

  // ---------------------------------------------------------------------------
  // Recording - each captured step is forwarded to the background session.
  // ---------------------------------------------------------------------------

  function send(step) {
    try {
      chrome.runtime.sendMessage({ action: "recordStep", step });
    } catch (e) {
      /* background may be momentarily unavailable; ignore */
    }
  }

  const CLICKABLE =
    'a,button,[role="button"],[role="option"],[role="menuitem"],' +
    '[role="tab"],[role="link"],[role="checkbox"],[role="radio"],' +
    '[role="switch"],input,select,textarea,label,summary';

  // Toggle/checkbox/radio controls - used to recover a click when the recorded
  // path no longer matches but its stable id container is still present.
  const CONTROL_SELECTOR =
    '[role="switch"],[role="checkbox"],[role="radio"],' +
    'input[type="checkbox"],input[type="radio"],button,[role="button"]';
  const TOGGLE_ROLES = new Set(["switch", "checkbox", "radio"]);

  function ariaAnchor(el) {
    if (!el || !el.getAttribute) return "";
    return (
      el.getAttribute("aria-label") ||
      el.getAttribute("title") ||
      el.getAttribute("placeholder") ||
      el.getAttribute("alt") ||
      ""
    ).trim();
  }

  // Ignore events on the extension's own overlay UI (debug panel / toast) so we
  // never record clicks/keys aimed at our own widgets.
  function isOwnUI(el) {
    return !!(el && el.closest && el.closest("[data-ire-overlay]"));
  }

  // Loading spinners / masks / skeletons
  const LOADING_RE = /loading|spinner|mask|overlay|backdrop|skeleton/i;
  function isLoadingOverlay(el) {
    if (!el || !el.getAttribute) return false;
    if (isInsideModal(el)) return false;
    const id = el.id || "";
    const cls = el.getAttribute("class") || "";
    return LOADING_RE.test(id) || LOADING_RE.test(cls);
  }

  // A bistable on/off control (NOT a radio, which can't be un-toggled).
  // These must be clicked exactly once or they flip back to where they were.
  function isBistableToggle(el) {
    const role = el.getAttribute && el.getAttribute("role");
    if (role === "switch" || role === "checkbox") return true;
    if (el.tagName === "INPUT" && el.type === "checkbox") return true;
    return false;
  }

  // Read the on/off state of a toggle (aria-checked, .checked, inner input...).
  function readChecked(el) {
    if (!el) return null;
    const ac = el.getAttribute && el.getAttribute("aria-checked");
    if (ac === "true") return true;
    if (ac === "false") return false;
    if (typeof el.checked === "boolean") return el.checked;
    const inp =
      el.querySelector &&
      el.querySelector('input[type="checkbox"],input[type="radio"]');
    if (inp) return !!inp.checked;
    const ap = el.getAttribute && el.getAttribute("aria-pressed");
    if (ap === "true") return true;
    if (ap === "false") return false;
    return null;
  }

  // Is any element in the (shadow-piercing) event path a modal/dialog host?
  function pathModalHost(path) {
    if (!path) return null;
    for (const n of path) {
      if (!(n instanceof Element)) continue;
      if (n === document.body || n === document.documentElement) break;
      const tag = n.tagName ? n.tagName.toLowerCase() : "";
      const role = (n.getAttribute && n.getAttribute("role")) || "";
      const cls = (n.getAttribute && n.getAttribute("class")) || "";
      if (
        tag === "ks-modal" ||
        role === "dialog" ||
        role === "alertdialog" ||
        /\bmodal\b|\bdialog\b/i.test(cls)
      ) {
        return n;
      }
    }
    return null;
  }

  function onClick(e) {
    // composedPath() pierces shadow DOM: e.target is retargeted to the shadow
    // host (and loses its inner text), so the real button must come from here.
    const path = (e.composedPath && e.composedPath()) || [];
    const rawTarget =
      path.find((n) => n instanceof Element && !isOwnUI(n)) || e.target;
    let el = refineRecordTarget(rawTarget, e, path);
    if (!(el instanceof Element) || isOwnUI(el)) return;

    const inModal = isInsideModal(el) || !!pathModalHost(path);
    if (isLoadingOverlay(el) && !clickLabel(el)) return;
    if (!clickLabel(el) && el.closest) {
      const clickable = el.closest(CLICKABLE);
      if (clickable) el = refineRecordTarget(clickable, e);
    }
    let label = clickLabel(el);
    // A wrapper/section captured instead of the real control: drill into a
    // single clickable descendant if there is one, else skip the noise.
    if (isCompositeCapture(el, label)) {
      const inner = tightenToClickable(el, label);
      if (inner && inner !== el && !isCompositeCapture(inner, clickLabel(inner))) {
        el = inner;
        label = clickLabel(el);
      } else {
        return;
      }
    }
    if (!label || isOversizedTarget(el, label.length)) return;
    const step = {
      type: "click",
      selector: buildSelector(el),
      text: label,
      aria: ariaAnchor(el),
      tag: el.tagName.toLowerCase(),
      role: (el.getAttribute && el.getAttribute("role")) || ""
    };
    // Generic: remember the click happened inside a dialog so replay can scope
    // resolution to (and wait for) the dialog - no per-site phrase matching.
    if (inModal) step.inModal = true;
    if (el.tagName.toLowerCase() === "a") {
      const href = anchorHref(el);
      if (href && !href.startsWith("javascript:")) {
        step.navigates = true;
        step.url = href;
        if (anchorOpensNewTab(el)) step.opensNewTab = true;
      }
    }
    // For on/off toggles, record the resulting state so replay is idempotent
    // (it only clicks when the toggle isn't already where it should be).
    if (isBistableToggle(el)) {
      const ref = el;
      setTimeout(() => {
        send({ ...step, toggle: true, targetChecked: readChecked(ref) });
      }, 0);
      return;
    }
    send(step);
  }

  function sendInputStep(el) {
    const tag = el.tagName.toLowerCase();
    let value;
    if (el.type === "checkbox" || el.type === "radio") {
      value = el.checked;
    } else {
      value = el.value;
    }
    send({
      type: "input",
      selector: buildSelector(el),
      inputType: el.type || tag,
      value: value
    });
  }

  function flushInputStep(el) {
    const key = buildSelector(el) || el;
    const timer = pendingInputTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      pendingInputTimers.delete(key);
    }
    sendInputStep(el);
  }

  function scheduleInputStep(el) {
    const key = buildSelector(el) || el;
    const existing = pendingInputTimers.get(key);
    if (existing) clearTimeout(existing);
    pendingInputTimers.set(
      key,
      setTimeout(() => {
        pendingInputTimers.delete(key);
        sendInputStep(el);
      }, INPUT_DEBOUNCE_MS)
    );
  }

  function onInput(e) {
    const el = e.target;
    if (!(el instanceof Element) || isOwnUI(el)) return;
    const tag = el.tagName.toLowerCase();
    if (tag !== "input" && tag !== "textarea") return;
    if (el.type === "checkbox" || el.type === "radio") return;
    scheduleInputStep(el);
  }

  function onChange(e) {
    const el = e.target;
    if (!(el instanceof Element) || isOwnUI(el)) return;
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") {
      if (el.type === "checkbox" || el.type === "radio" || tag === "select") {
        sendInputStep(el);
      } else {
        flushInputStep(el);
      }
    }
  }

  function onKeydown(e) {
    if (!STANDALONE_KEYS.has(e.key)) return;
    const el = e.target;
    if (isOwnUI(el)) return;
    send({
      type: "key",
      selector: el instanceof Element ? buildSelector(el) : null,
      key: e.key,
      ctrl: e.ctrlKey,
      shift: e.shiftKey,
      alt: e.altKey,
      meta: e.metaKey
    });
  }

  // Copy: record WHICH element the selection came from, not its current value.
  // On replay we read that element's live value (it changes each run).
  function onCopy() {
    let el = null;
    const active = document.activeElement;
    if (
      active &&
      (active.tagName === "INPUT" || active.tagName === "TEXTAREA") &&
      active.selectionStart !== active.selectionEnd
    ) {
      el = active;
    } else {
      const sel = window.getSelection && window.getSelection();
      if (sel && sel.anchorNode) {
        const n = sel.anchorNode;
        el = n.nodeType === Node.TEXT_NODE ? n.parentElement : n;
      }
    }
    if (!(el instanceof Element) || isOwnUI(el)) return;
    send({
      type: "copy",
      selector: buildSelector(el),
      sample: readValue(el).slice(0, 120)
    });
    showToast("Copy source captured");
  }

  function onPaste(e) {
    const el = e.target;
    if (!(el instanceof Element) || isOwnUI(el)) return;
    send({ type: "paste", selector: buildSelector(el) });
    showToast("Paste target captured");
  }

  function startRecording() {
    if (recording) return;
    recording = true;
    document.addEventListener("click", onClick, true);
    document.addEventListener("input", onInput, true);
    document.addEventListener("change", onChange, true);
    document.addEventListener("keydown", onKeydown, true);
    document.addEventListener("copy", onCopy, true);
    document.addEventListener("paste", onPaste, true);
    showToast("Recording on this tab");
  }

  function stopRecording() {
    if (!recording) return;
    recording = false;
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("input", onInput, true);
    document.removeEventListener("change", onChange, true);
    document.removeEventListener("keydown", onKeydown, true);
    document.removeEventListener("copy", onCopy, true);
    document.removeEventListener("paste", onPaste, true);
    for (const timer of pendingInputTimers.values()) clearTimeout(timer);
    pendingInputTimers.clear();
    showToast("Recording stopped");
  }

  function armAbortListener() {
    // Arm in every frame so Escape aborts even when focus is inside an iframe.
    if (abortKeyHandler) return;
    abortKeyHandler = (e) => {
      if (e.key === "Escape") {
        try {
          chrome.runtime.sendMessage({ action: "abortReplay" });
        } catch (err) {
          /* ignore */
        }
      }
    };
    document.addEventListener("keydown", abortKeyHandler, true);
  }

  function disarmAbortListener() {
    if (!abortKeyHandler) return;
    document.removeEventListener("keydown", abortKeyHandler, true);
    abortKeyHandler = null;
  }

  // ---------------------------------------------------------------------------
  // Element resolution + smart waits (used during replay)
  // ---------------------------------------------------------------------------

  function isVisible(el) {
    if (!el) return false;
    if (el.disabled) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") {
      return false;
    }
    if (
      el.offsetParent === null &&
      style.position !== "fixed" &&
      style.position !== "sticky"
    ) {
      return false;
    }
    return true;
  }

  // Modal body clicks often need the confirm/primary button instead.
  function findTopmostModal() {
    const selectors = [
      "ks-modal",
      '[role="dialog"]',
      '[role="alertdialog"]',
      '[class*="modal"]',
      '[class*="Modal"]',
      '[class*="dialog"]',
      '[class*="Dialog"]'
    ];
    let best = null;
    let bestArea = 0;
    for (const sel of selectors) {
      const nodes = queryAllDeep(document.body, sel);
      for (const el of nodes) {
        if (!isVisible(el)) continue;
        const r = el.getBoundingClientRect();
        const area = r.width * r.height;
        if (area > bestArea && r.width > 200 && r.height > 80) {
          bestArea = area;
          best = el;
        }
      }
    }
    if (best) return best;
    const confirm = findLabeledClickable(/^confirm$/i, { allowModal: true });
    if (confirm) {
      return (
        confirm.closest('ks-modal, [role="dialog"], [role="alertdialog"]') || confirm
      );
    }
    return null;
  }

  // Generic: was this step performed inside a dialog? Recorded as step.inModal;
  // modalAction is kept only so pre-existing recordings still resolve in-dialog.
  function stepInModal(step) {
    return !!(step && (step.inModal || step.modalAction));
  }

  // Does this step look like "press the dialog's main action button"? Covers
  // common action words and TikTok's confirm-btn slot / primary-button classes.
  const PRIMARY_ACTION_RE =
    /^(confirm|ok|continue|got it|next|save|submit|done|apply|agree|proceed|yes|create|publish|finish|update)$/i;
  function looksLikePrimaryAction(step) {
    const t = normalizeStepText(step.text || "").trim();
    if (PRIMARY_ACTION_RE.test(t)) return true;
    const sel = step.selector || "";
    return /confirm-btn|--primary|primary-btn|footer__primary|footer__confirm/i.test(sel);
  }

  const MODAL_CANCEL_RE = /^(cancel|close|dismiss|back|not now|no|skip)$/i;

  // Find a dialog's action button robustly across TikTok's modal systems
  // (ks-modal confirm-btn slot, vi-dialog .vi-button--primary, etc.). Scores
  // visible clickables in the dialog by text/primary-ness and demotes
  // cancel/secondary controls and icons.
  // Climb from a (possibly zero-box) node to the nearest visible clickable host.
  function visibleClickableHost(node, scope) {
    let n = node;
    let hops = 0;
    while (n && n !== scope && hops < 6) {
      if (
        isVisible(n) &&
        (n.matches &&
          n.matches('button, ks-button, [role="button"], a, [class*="btn"], [class*="button"]'))
      ) {
        return n;
      }
      n = n.parentElement;
      hops++;
    }
    // Fall back to the first visible ancestor with a real box.
    n = node;
    hops = 0;
    while (n && n !== scope && hops < 6) {
      if (isVisible(n)) return n;
      n = n.parentElement;
      hops++;
    }
    return null;
  }

  function findModalActionButton(scope, wantText) {
    if (!scope) return null;
    const want = normalizeStepText(wantText || "").trim();

    // Gold hook: TikTok marks the dialog's confirm control with a confirm-btn
    // slot/name. The slot itself is zero-box, so resolve to its visible host.
    const named = queryAllDeep(scope, '[name="confirm-btn"], [slot="confirm-btn"]');
    for (const n of named) {
      const host = visibleClickableHost(n, scope);
      if (host) return tightenToClickable(host, want);
    }

    const clickables = queryAllDeep(
      scope,
      'button, ks-button, [role="button"], a, [class*="button"], [class*="btn"], [name="confirm-btn"], [slot="confirm-btn"]'
    ).filter((b) => isVisible(b) && !isHelpOrExternalAnchor(b));
    if (!clickables.length) return null;

    const scoreOf = (b) => {
      const t = fullText(b).replace(/\s+/g, " ").trim();
      const cls =
        b.getAttribute && typeof b.getAttribute("class") === "string"
          ? b.getAttribute("class")
          : "";
      let s = 0;
      if (want && t === want) s += 6;
      else if (want && t.toLowerCase().includes(want.toLowerCase())) s += 3;
      if (
        (b.getAttribute && b.getAttribute("name") === "confirm-btn") ||
        (b.getAttribute && b.getAttribute("slot") === "confirm-btn")
      ) {
        s += 8;
      }
      if (/--primary|primary-btn|footer__primary|footer__confirm|confirm-btn/i.test(cls)) s += 6;
      if (MODAL_CANCEL_RE.test(t)) s -= 10;
      if (/__other|secondary|cancel|close|dismiss/i.test(cls)) s -= 6;
      if (isNativeClickable(b)) s += 3;
      s -= Math.min(fullText(b).length, 60) / 30;
      return s;
    };

    let best = null;
    let bestScore = -Infinity;
    for (const b of clickables) {
      const s = scoreOf(b);
      if (s > bestScore) {
        bestScore = s;
        best = b;
      }
    }
    if (!best || bestScore <= 0) return null;
    return tightenToClickable(best, want);
  }

  function queryVisible(selector) {
    if (!selector) return null;
    try {
      return Array.from(document.querySelectorAll(selector)).find(isVisible) || null;
    } catch (e) {
      return null;
    }
  }

  function firstVisibleMatch(selector) {
    let el = queryVisible(selector);
    if (el) return el;
    // Retry with volatile ids relaxed to stable prefixes (old recordings).
    const stable = stabilizeSelector(selector);
    if (stable !== selector) el = queryVisible(stable);
    return el;
  }

  // Return the recorded element when its selector still resolves to exactly one
  // visible element (faithful to what was clicked; works for any site/control).
  function uniqueVisibleSelectorMatch(selector) {
    if (!selector) return null;
    const collect = (sel) => {
      try {
        return Array.from(document.querySelectorAll(sel)).filter(isVisible);
      } catch (e) {
        return [];
      }
    };
    let m = collect(selector);
    if (m.length === 1) return m[0];
    const stable = stabilizeSelector(selector);
    if (stable !== selector) {
      m = collect(stable);
      if (m.length === 1) return m[0];
    }
    return null;
  }

  const OPTION_ROLES = new Set([
    "option",
    "menuitem",
    "menuitemradio",
    "menuitemcheckbox",
    "treeitem",
    "listitem"
  ]);
  const MENU_CONTAINER =
    '[role="listbox"],[role="menu"],[role="tree"],[role="grid"]';

  function getRole(el) {
    return (el.getAttribute && el.getAttribute("role")) || "";
  }

  // Locate the element to click. Generic priority, no per-site phrases:
  //   1. recorded selector (unique visible match)        - faithful to record
  //   2. role + accessible name within scope             - ARIA-style locator
  //   3. visible text / aria within scope                - human-visible label
  //   4. stable-ancestor fallback                        - structural rescue
  // Scope is the open dialog when the step was recorded inside one, else the
  // whole document.
  function resolveClickTarget(step) {
    const root = stepInModal(step) ? findTopmostModal() : null;

    if (stepInModal(step) && root) {
      // Prefer the exact recorded control when its selector still hits a
      // visible element in the dialog (e.g. a toggle inside a settings modal).
      if (step.selector) {
        const exact = uniqueVisibleSelectorMatch(step.selector);
        if (
          exact &&
          scopeContains(root, exact) &&
          isVisible(exact) &&
          !isHelpOrExternalAnchor(exact)
        ) {
          return finalizeClickTarget(exact, step);
        }
      }
      // Otherwise, if this is the dialog's action button, find it robustly.
      // (The recorded target is often a <slot>/invisible node, so a plain
      // visible-selector match fails and text matching is ambiguous.)
      if (looksLikePrimaryAction(step)) {
        const btn = findModalActionButton(root, step.text);
        if (btn) return btn;
      }
    }

    return resolveClickTargetInner(step, root || document);
  }

  function scopeContains(root, el) {
    if (!root || root === document) return true;
    return root === el || (root.contains && root.contains(el));
  }

  function resolveClickTargetInner(step, root) {
    const scope = root || document;
    const scoped = (el) => el && isVisible(el) && scopeContains(scope, el);
    const wantText = normalizeStepText(
      step.text ? step.text.replace(/\s+/g, " ").trim() : ""
    );
    const wantAria = step.aria ? step.aria.trim() : "";
    const wantRole = step.role || "";

    // 1. The exact element recorded, when its selector still resolves uniquely
    // and visibly within scope. Faithful to what the user actually clicked
    // (e.g. a toggle whose visible text lives in a separate node).
    if (step.selector) {
      const exact = uniqueVisibleSelectorMatch(step.selector);
      if (exact && scoped(exact) && !isHelpOrExternalAnchor(exact)) {
        return finalizeClickTarget(exact, step);
      }
    }

    const candidates = new Set();
    const addBySelector = (sel) => {
      if (!sel) return;
      try {
        (scope.querySelectorAll ? scope : document)
          .querySelectorAll(sel)
          .forEach((e) => candidates.add(e));
      } catch (e) {
        /* invalid/stale selector */
      }
    };

    if (step.selector) {
      addBySelector(step.selector);
      const stable = stabilizeSelector(step.selector);
      if (stable !== step.selector) addBySelector(stable);
    }

    // Text / accessible-name candidates within scope.
    const scanRoot = scope.querySelectorAll ? scope : document.body;
    if ((wantText || wantAria) && scanRoot) {
      const scan = scanRoot.querySelectorAll(
        "button, a, [role], ks-button, input, select, textarea, label, li, span, div, p, td, th, summary"
      );
      for (const e of scan) {
        const t = fullText(e);
        if (wantText && (textMatches(wantText, t) || textMatches(wantText, step.text || ""))) {
          candidates.add(e);
        } else if (wantText && wantText.length >= 4 && t.includes(wantText) && t.length <= wantText.length + 20) {
          candidates.add(e);
        } else if (wantAria && ariaAnchor(e) === wantAria) {
          candidates.add(e);
        }
      }
    }

    // Icon/blank targets: match by aria/title/placeholder/alt.
    if (!wantText && wantAria) {
      const v = attrVal(wantAria);
      addBySelector(
        `[aria-label="${v}"],[title="${v}"],[placeholder="${v}"],[alt="${v}"]`
      );
    }

    let list = Array.from(candidates).filter(scoped);
    if (wantText) {
      list = list.filter((e) => !isOversizedTarget(e, wantText.length));
    }

    // Structural rescue: recorded path is gone, but a stable ancestor id from
    // the selector still exists - look for a real control inside it. General
    // (any stable id), used for toggles/switches whose markup was rebuilt.
    if (!list.length && step.selector) {
      const idAnchor = leadingStableId(step.selector);
      const container = idAnchor && document.getElementById(idAnchor);
      if (container && scopeContains(scope, container)) {
        const controls = Array.from(
          container.querySelectorAll(CONTROL_SELECTOR)
        ).filter(isVisible);
        const toggles = controls.filter((e) => {
          const r = getRole(e);
          return (
            TOGGLE_ROLES.has(r) ||
            (e.tagName === "INPUT" &&
              (e.type === "checkbox" || e.type === "radio"))
          );
        });
        (toggles.length ? toggles : controls).forEach((e) => candidates.add(e));
        list = Array.from(candidates).filter(scoped);
      }
    }

    if (!list.length) return null;
    if (list.length === 1) return finalizeClickTarget(list[0], step);

    // Determinism: if the recorded element was interactive, narrow to candidates
    // of the same kind. This removes the "an <a> one run, a <button> the next"
    // ambiguity (the recorded tag is the tiebreaker), and keeps text matches
    // from landing on a non-interactive wrapper that merely contains the words.
    const recordedInteractive =
      (step.tag && /^(a|button|input|select|textarea|summary)$/.test(step.tag)) ||
      (step.tag && step.tag.indexOf("-") !== -1) ||
      (wantRole && /^(button|link|menuitem|menuitemradio|menuitemcheckbox|option|switch|checkbox|radio|tab)$/.test(wantRole));
    if (recordedInteractive) {
      const sameTag = step.tag
        ? list.filter((e) => e.tagName.toLowerCase() === step.tag)
        : [];
      if (sameTag.length) {
        list = sameTag;
      } else {
        const interactive = list.filter((e) => isNativeClickable(e));
        if (interactive.length) list = interactive;
      }
    }
    if (list.length === 1) return finalizeClickTarget(list[0], step);

    const scored = list.map((el, idx) => {
      let s = 0;
      if (step.selector) {
        try {
          if (el.matches(step.selector)) s += 12;
          else {
            const stable = stabilizeSelector(step.selector);
            if (stable !== step.selector && el.matches(stable)) s += 10;
          }
        } catch (e) {
          /* ignore */
        }
      }
      const role = getRole(el);
      const tag = el.tagName.toLowerCase();
      // Role + accessible name is the strongest semantic signal after selector.
      if (wantText && fullText(el) === wantText) s += 5;
      if (wantAria && ariaAnchor(el) === wantAria) s += 4;
      if (wantRole && role === wantRole) s += 4;
      if (step.tag && tag === step.tag) s += 6;
      if (isNativeClickable(el)) s += 8;
      else if (tag === "div" || tag === "span") s -= 3;
      if (isHelpOrExternalAnchor(el)) s -= 20;
      if (OPTION_ROLES.has(role) || el.closest(MENU_CONTAINER)) s += 4;
      if (TOGGLE_ROLES.has(role)) s += 1;
      const textLen = fullText(el).length;
      s += Math.max(0, 50 - textLen);
      return { el, s, idx, children: el.querySelectorAll("*").length };
    });

    scored.sort(
      (a, b) => b.s - a.s || b.idx - a.idx || a.children - b.children
    );
    return finalizeClickTarget(scored[0].el, step);
  }

  // ---------------------------------------------------------------------------
  // Action execution
  // ---------------------------------------------------------------------------

  function setNativeValue(el, value) {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) {
      setter.set.call(el, value);
    } else {
      el.value = value;
    }
  }

  function setReactFriendlyValue(el, value) {
    el.focus();
    const tracker = el._valueTracker;
    if (tracker) tracker.setValue("");
    setNativeValue(el, value);
    el.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        inputType: "insertFromPaste",
        data: value
      })
    );
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function applyInput(el, step) {
    if (step.inputType === "checkbox" || step.inputType === "radio") {
      el.focus();
      el.checked = !!step.value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    if (el.tagName.toLowerCase() === "select") {
      el.focus();
      el.value = step.value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    setReactFriendlyValue(el, step.value);
  }

  function pasteValue(el, value) {
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea") {
      setReactFriendlyValue(el, value);
    } else if (el.isContentEditable) {
      el.focus();
      el.textContent = value;
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    } else {
      el.textContent = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  function dispatchKey(el, step) {
    const target = el || document.activeElement || document.body;
    const init = {
      key: step.key,
      bubbles: true,
      cancelable: true,
      ctrlKey: step.ctrl,
      shiftKey: step.shift,
      altKey: step.alt,
      metaKey: step.meta
    };
    target.dispatchEvent(new KeyboardEvent("keydown", init));
    target.dispatchEvent(new KeyboardEvent("keyup", init));
  }

  // Some components (custom radios, switches/toggles) react to pointer/mouse
  // events, not a bare click(). Fire a full, realistic event sequence so those
  // selections actually register on replay.
  function isAnchor(el) {
    return !!(el && el.tagName && el.tagName.toLowerCase() === "a");
  }

  function anchorHref(el) {
    if (!isAnchor(el)) return "";
    try {
      return el.href || "";
    } catch (e) {
      return "";
    }
  }

  function anchorOpensNewTab(el) {
    if (!isAnchor(el)) return false;
    const target = (el.getAttribute("target") || "").toLowerCase();
    return target === "_blank" || target === "_new";
  }

  // Help/support/docs links (often target="_blank"). These are almost never the
  // intended automation target in an ad-creation flow, so the resolver should
  // avoid them when a real control is also a candidate.
  function isHelpOrExternalAnchor(el) {
    if (!isAnchor(el)) return false;
    if (anchorOpensNewTab(el)) return true;
    const href = anchorHref(el);
    if (!href) return false;
    if (/\/help|\/support|\/docs|business-help|helpcenter|help\.|support\./i.test(href)) {
      return true;
    }
    try {
      if (new URL(href).origin !== window.location.origin) return true;
    } catch (e) {
      /* ignore */
    }
    return false;
  }

  function dispatchPointerSequence(el, includeNativeClick) {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: 1
    };
    const pointer = (type, buttons) => {
      if (typeof PointerEvent !== "function") return;
      el.dispatchEvent(
        new PointerEvent(type, {
          ...base,
          buttons,
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true
        })
      );
    };
    const mouse = (type, buttons) => {
      el.dispatchEvent(new MouseEvent(type, { ...base, buttons }));
    };

    pointer("pointerover", 1);
    pointer("pointerenter", 1);
    mouse("mouseover", 1);
    mouse("mousemove", 1);
    pointer("pointerdown", 1);
    mouse("mousedown", 1);
    if (typeof el.focus === "function") {
      try {
        el.focus({ preventScroll: true });
      } catch (e) {
        /* ignore */
      }
    }
    pointer("pointerup", 0);
    mouse("mouseup", 0);
    if (includeNativeClick) {
      if (typeof el.click === "function") el.click();
      else mouse("click", 0);
    }
  }

  function realisticClick(el) {
    dispatchPointerSequence(el, true);
  }

  // Click while neutralizing target="_blank": temporarily force the anchor to
  // navigate in THIS tab, then let the element's own pointer/click handlers run
  // (so SPA logic — e.g. a modal Confirm — still fires). This avoids both the
  // "spawns a new tab" problem and the "hard navigate bypasses JS handlers"
  // problem of window.location.assign.
  function performClick(el) {
    if (typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "center", inline: "center" });
    }
    const rect = el.getBoundingClientRect();
    const x = Math.min(Math.max(rect.left + rect.width / 2, 0), window.innerWidth - 1);
    const y = Math.min(Math.max(rect.top + rect.height / 2, 0), window.innerHeight - 1);
    const hit = document.elementFromPoint(x, y);
    const target = hit && (hit === el || el.contains(hit)) ? hit : el;

    let restoreTarget = null;
    if (isAnchor(target) && anchorOpensNewTab(target)) {
      const prev = target.getAttribute("target");
      target.setAttribute("target", "_self");
      restoreTarget = () => {
        if (prev === null) target.removeAttribute("target");
        else target.setAttribute("target", prev);
      };
      trace("info", "anchor target=_blank → _self for this click");
    }

    realisticClick(target);
    if (restoreTarget) setTimeout(restoreTarget, 0);
    return { navigated: false };
  }

  // Compact, information-dense identity of an element for the debug log, using
  // the hooks that actually identify TikTok controls (text, data-*, name, aria,
  // role, stable classes). Reads shadow/slotted text too.
  function describeEl(el) {
    if (!el || !el.tagName) return "?";
    const tag = el.tagName.toLowerCase();
    const parts = [tag];
    const txt = fullText(el).slice(0, 40);
    if (txt) parts.push(`"${txt}"`);
    const attrs = [
      "data-testid",
      "data-tea",
      "data-btm",
      "data-cta_name",
      "name",
      "aria-label",
      "role"
    ];
    for (const a of attrs) {
      const v = el.getAttribute && el.getAttribute(a);
      if (v) parts.push(`${a}=${v}`);
    }
    if (el.className && typeof el.className === "string") {
      const stable = el.className.split(/\s+/).filter(isStableClass);
      if (stable.length) parts.push("." + stable.slice(0, 2).join("."));
    }
    return parts.join(" ");
  }

  async function findClickTargetWithRetry(step, payload) {
    const afterPageLoad = payload && payload.afterPageLoad;
    const inModal = stepInModal(step);
    // Poll for the target to appear: a dialog can take a moment to mount, and a
    // page can still be settling right after a navigation.
    const maxMs = inModal ? 6000 : afterPageLoad ? 4000 : 0;
    const deadline = Date.now() + maxMs;
    const shouldRetry = afterPageLoad || inModal;
    let lastErr = null;

    do {
      try {
        // While time remains, require the dialog scope for in-modal steps so we
        // don't fall back to a stray page element before the dialog mounts.
        const el = findClickTarget(step, inModal && Date.now() < deadline);
        trace(
          "info",
          `found ${describeEl(el)}${isNativeClickable(el) ? "" : " (wrapper→control)"} — clicking`
        );
        return el;
      } catch (e) {
        lastErr = e;
        if (!shouldRetry || stepCanceled) throw e;
        await new Promise((r) => setTimeout(r, 120));
      }
    } while (Date.now() < deadline);

    // Deadline passed: best effort, document scope allowed.
    return findClickTarget(step, false);
  }

  function findClickTarget(step, requireModalScope) {
    // In-modal steps wait for the dialog to exist, then resolve within it.
    if (stepInModal(step) && requireModalScope && !findTopmostModal()) {
      throw new Error("Waiting for dialog to open");
    }
    const el = resolveClickTarget(step);
    if (!el) {
      throw new Error(
        "Element not found: " + (normalizeStepText(step.text) || step.selector || "?")
      );
    }
    return el;
  }

  function findInputTarget(step) {
    const el = firstVisibleMatch(step.selector);
    if (!el) throw new Error("Element not found: " + (step.selector || "?"));
    return el;
  }

  // Execute a single step. Timers run in the background; this only acts.
  async function execStep(step, payload) {
    stepCanceled = false;
    clearWaitStatus();
    verboseTrace = !payload || payload.verboseDebug !== false;
    const stepLabel =
      payload && payload.stepIndex
        ? `step ${payload.stepIndex}/${payload.stepTotal || "?"}`
        : "step";
    trace(
      "info",
      `${stepLabel} ${step.type}: ${normalizeStepText(step.text) || step.selector || step.key || ""}`
    );

    switch (step.type) {
      case "click": {
        const target = await findClickTargetWithRetry(step, payload);
        if (typeof target.scrollIntoView === "function") {
          target.scrollIntoView({ block: "center", inline: "center" });
        }
        if (isBistableToggle(target)) {
          // Always click toggles exactly as recorded (no idempotent skip).
          trace("info", "toggle — clicking as recorded");
          realisticClick(target);
          return { ok: true };
        }
        if (step.navigates) {
          try {
            sessionStorage.setItem(
              "__ire_nav_click",
              JSON.stringify({ text: step.text, from: location.href, ts: Date.now() })
            );
          } catch (e) {
            /* ignore */
          }
        }
        performClick(target);
        clearWaitStatus();

        // Navigation clicks unload this script — respond before any async wait.
        // step.navigates is set generically (recorder detects the URL change).
        if (step.navigates) {
          trace("ok", "click dispatched (timer handles load wait)");
          return { ok: true, clicked: true, mayNavigate: true };
        }

        trace("ok", "click completed");
        return { ok: true };
      }
      case "input": {
        applyInput(findInputTarget(step), step);
        return { ok: true };
      }
      case "key": {
        const el = step.selector ? findInputTarget(step) : null;
        dispatchKey(el, step);
        return { ok: true };
      }
      case "read": {
        return { ok: true, value: readValue(findInputTarget(step)) };
      }
      case "paste": {
        pasteValue(findInputTarget(step), payload ? payload.value : "");
        return { ok: true };
      }
      default:
        return { ok: false, error: "Unknown step type: " + step.type };
    }
  }

  // ---------------------------------------------------------------------------
  // On-page toast
  // ---------------------------------------------------------------------------

  let replayStopBtn = null;

  function showReplayStop() {
    if (window.top !== window.self) return;
    if (replayStopBtn) return;
    replayStopBtn = document.createElement("button");
    replayStopBtn.setAttribute("data-ire-overlay", "1");
    replayStopBtn.type = "button";
    replayStopBtn.textContent = "Stop replay";
    replayStopBtn.style.cssText =
      "position:fixed;z-index:2147483647;bottom:16px;right:16px;" +
      "padding:10px 16px;border:none;border-radius:8px;font:13px/1.3 system-ui,sans-serif;" +
      "font-weight:600;cursor:pointer;color:#fff;background:#c0392b;" +
      "box-shadow:0 4px 14px rgba(0,0,0,.35);";
    replayStopBtn.addEventListener("click", () => {
      try {
        chrome.runtime.sendMessage({ action: "abortReplay" });
      } catch (e) {
        /* ignore */
      }
    });
    document.documentElement.appendChild(replayStopBtn);
  }

  function hideReplayStop() {
    if (replayStopBtn && replayStopBtn.parentNode) {
      replayStopBtn.parentNode.removeChild(replayStopBtn);
      replayStopBtn = null;
    }
  }

  let toastEl = null;
  let toastTimer = null;
  function showToast(msg, isError) {
    // Only the top document shows toasts (iframes would clip/duplicate them).
    if (window.top !== window.self) return;
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.setAttribute("data-ire-overlay", "1");
      toastEl.style.cssText =
        "position:fixed;z-index:2147483647;top:16px;right:16px;" +
        "padding:10px 14px;border-radius:8px;font:13px/1.3 system-ui,sans-serif;" +
        "color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.3);pointer-events:none;" +
        "max-width:320px;transition:opacity .2s;";
      document.documentElement.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.style.background = isError ? "#c0392b" : "#2d2d2d";
    toastEl.style.opacity = "1";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (toastEl) toastEl.style.opacity = "0";
    }, 2500);
  }

  // ---------------------------------------------------------------------------
  // Debug overlay (bottom-right): logs each captured/replayed step + its name
  // ---------------------------------------------------------------------------

  let debugPanel = null;
  let debugBody = null;
  function ensureDebugPanel() {
    if (debugPanel) return;
    debugPanel = document.createElement("div");
    debugPanel.setAttribute("data-ire-overlay", "1");
    debugPanel.style.cssText =
      "position:fixed;z-index:2147483647;right:12px;bottom:12px;width:320px;" +
      "max-height:360px;display:flex;flex-direction:column;" +
      "background:rgba(18,18,18,.94);color:#eee;border:1px solid #444;" +
      "border-radius:8px;box-shadow:0 6px 22px rgba(0,0,0,.45);overflow:hidden;" +
      "font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;";
    const head = document.createElement("div");
    head.style.cssText =
      "padding:6px 10px;font-weight:700;background:#262626;" +
      "border-bottom:1px solid #444;display:flex;justify-content:space-between;" +
      "align-items:center;cursor:move;user-select:none;touch-action:none;";
    const title = document.createElement("span");
    title.textContent = "\u2630 Recorder Debug";
    const clear = document.createElement("span");
    clear.textContent = "clear";
    clear.style.cssText =
      "cursor:pointer;color:#3a86ff;font-weight:400;padding:0 4px;";
    clear.addEventListener("click", (e) => {
      e.stopPropagation();
      if (debugBody) debugBody.innerHTML = "";
    });
    head.appendChild(title);
    head.appendChild(clear);
    debugBody = document.createElement("div");
    debugBody.style.cssText = "padding:4px 8px;overflow-y:auto;";
    debugPanel.appendChild(head);
    debugPanel.appendChild(debugBody);
    document.documentElement.appendChild(debugPanel);
    makeDraggable(debugPanel, head);
  }

  // Drag the panel around by its header (pointer-based, stays within viewport).
  function makeDraggable(panel, handle) {
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    const onMove = (e) => {
      if (!dragging) return;
      e.preventDefault();
      const w = panel.offsetWidth;
      const h = panel.offsetHeight;
      let left = e.clientX - offsetX;
      let top = e.clientY - offsetY;
      left = Math.max(0, Math.min(left, window.innerWidth - w));
      top = Math.max(0, Math.min(top, window.innerHeight - h));
      panel.style.left = left + "px";
      panel.style.top = top + "px";
      panel.style.right = "auto";
      panel.style.bottom = "auto";
    };

    const onUp = () => {
      dragging = false;
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("pointerup", onUp, true);
    };

    handle.addEventListener("pointerdown", (e) => {
      // Pin current position as left/top so dragging is smooth from any corner.
      const rect = panel.getBoundingClientRect();
      panel.style.left = rect.left + "px";
      panel.style.top = rect.top + "px";
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      dragging = true;
      document.addEventListener("pointermove", onMove, true);
      document.addEventListener("pointerup", onUp, true);
    });
  }

  function debugLog(phase, text, opts) {
    if (window.top !== window.self) return; // only the top frame renders it
    if (opts && opts.showPanel !== false) ensureDebugPanel();
    else if (!debugPanel) return;
    const row = document.createElement("div");
    row.style.cssText =
      "padding:2px 0;border-bottom:1px solid rgba(255,255,255,.06);" +
      "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
    const tag = phase === "replay" ? "\u25B6" : "\u25CF";
    row.style.color =
      (opts && opts.color) ||
      (phase === "replay" ? "#5aa0ff" : phase === "trace" ? "#ffb347" : "#5fd38b");
    const ts =
      opts && opts.ts
        ? new Date(opts.ts).toLocaleTimeString()
        : new Date().toLocaleTimeString();
    row.textContent = `${ts}  ${tag} ${text}`;
    row.title = text;
    debugBody.appendChild(row);
    while (debugBody.childNodes.length > 80) {
      debugBody.removeChild(debugBody.firstChild);
    }
    debugBody.scrollTop = debugBody.scrollHeight;
  }

  function restoreDebugPanel(lines) {
    if (window.top !== window.self) return;
    ensureDebugPanel();
    if (!lines || !lines.length) return;
    debugBody.innerHTML = "";
    for (const line of lines) {
      debugLog(line.phase, line.text, { ts: line.ts, showPanel: true });
    }
  }

  function requestDebugSync() {
    if (window.top !== window.self) return;
    try {
      chrome.runtime.sendMessage({ action: "syncDebugPanel" }, (res) => {
        if (res && res.enabled) {
          verboseTrace = res.verbose !== false;
          restoreDebugPanel(res.lines || []);
        }
      });
    } catch (e) {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------------------
  // Message bridge
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.action) return;
    switch (msg.action) {
      case "ping":
        sendResponse({ ok: true });
        break;
      case "startRecording":
        startRecording();
        sendResponse({ ok: true });
        break;
      case "stopRecording":
        stopRecording();
        sendResponse({ ok: true });
        break;
      case "armAbortListener":
        armAbortListener();
        sendResponse({ ok: true });
        break;
      case "disarmAbortListener":
        disarmAbortListener();
        sendResponse({ ok: true });
        break;
      case "cancelStep":
        stepCanceled = true;
        sendResponse({ ok: true });
        break;
      case "getStatus":
        sendResponse({ ok: true, recording });
        break;
      case "execStep":
        execStep(msg.step, msg.payload)
          .then((result) => {
            try {
              sendResponse(result);
            } catch (e) {
              /* channel may already be closed after navigation */
            }
          })
          .catch((e) => {
            try {
              sendResponse({ ok: false, error: e.message });
            } catch (e2) {
              /* ignore */
            }
          });
        return true; // async response
      case "toast":
        showToast(msg.message, msg.isError);
        sendResponse({ ok: true });
        break;
      case "timerWait":
        setWaitStatus(msg.label || "timer", `${msg.ms}ms`);
        sendResponse({ ok: true });
        break;
      case "clearTimerWait":
        clearWaitStatus();
        sendResponse({ ok: true });
        break;
      case "replayUi":
        if (msg.active) showReplayStop();
        else hideReplayStop();
        sendResponse({ ok: true });
        break;
      case "debugLog":
        debugLog(msg.phase, msg.text, { showPanel: msg.showPanel !== false });
        sendResponse({ ok: true });
        break;
      case "syncDebugPanel":
        if (msg.showPanel !== false) restoreDebugPanel(msg.lines || []);
        sendResponse({ ok: true });
        break;
      default:
        break;
    }
    return false;
  });

  // ---------------------------------------------------------------------------
  // Auto-arm recording on page load + react to session changes.
  // This makes capture survive full-page navigations and new tabs (the prior
  // content script is destroyed on navigation; the fresh one self-arms here
  // instead of waiting for a message from the background).
  // ---------------------------------------------------------------------------

  try {
    chrome.storage.local.get({ session: null }, (d) => {
      if (d && d.session && d.session.active) startRecording();
    });
  } catch (e) {
    /* ignore */
  }

  requestDebugSync();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.session) return;
    const v = changes.session.newValue;
    if (v && v.active) startRecording();
    else stopRecording();
  });
})();
