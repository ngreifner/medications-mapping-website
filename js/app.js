// app.js — main controller.
// Wires up theme cycling, tab switching, URL query state, code-detection
// hand-off, and keyboard handlers. Delegates mode-specific work to mode files.

import * as mode1 from "./modes/mode1-single-forward.js";
import * as mode2 from "./modes/mode2-batch-forward.js";
import * as mode3 from "./modes/mode3-atc-to-rxcuis.js";
import * as mode4 from "./modes/mode4-rxcui-to-ndcs.js";
import * as mode5 from "./modes/mode5-batch-rxcui-to-ndcs.js";
import { clearCache } from "./rxnav-client.js";
import { detectCodeType } from "./code-detection.js";
import { codeDetectionBanner } from "./ui-components.js";

const MODE_LABEL = { ATC: "ATC → RXCUI", NDC: "NDC → ATC", RXCUI: "RXCUI → ATC" };

// ---------------- theme ----------------
// Binary toggle: light ↔ dark. On first visit (no localStorage value) the
// system preference is read once to pick an initial theme; from there forward
// the toggle persists the user's explicit choice.
const THEME_KEY = "medcode_theme";
const THEME_GLYPH = { light: "☀", dark: "☾" };

function getTheme() {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === "light" || stored === "dark") return stored;
  // Dark is the canonical default. Users can toggle to light explicitly.
  return "dark";
}
function applyTheme(theme) {
  const html = document.documentElement;
  html.setAttribute("data-theme", theme);
  const btn = document.getElementById("theme-toggle");
  if (btn) {
    const glyph = btn.querySelector(".theme-glyph");
    if (glyph) glyph.textContent = THEME_GLYPH[theme] || THEME_GLYPH.light;
    btn.title = `Theme: ${theme} (click to switch)`;
    btn.setAttribute("aria-label", `Switch to ${theme === "light" ? "dark" : "light"} theme`);
  }
}
function cycleTheme() {
  const next = getTheme() === "light" ? "dark" : "light";
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
}

// ---------------- tabs ----------------
function activateTab(modeNum, { pushUrl = true } = {}) {
  const mode = String(modeNum);
  document.querySelectorAll(".tab").forEach(t => {
    const isActive = t.dataset.mode === mode;
    t.classList.toggle("is-active", isActive);
    t.setAttribute("aria-selected", isActive ? "true" : "false");
  });
  document.querySelectorAll(".mode-panel").forEach(p => {
    const isActive = p.dataset.mode === mode;
    p.classList.toggle("is-active", isActive);
    if (isActive) p.removeAttribute("hidden");
    else p.setAttribute("hidden", "");
  });

  // Sync the mode onto <html> — the inline head script sets it on first
  // paint; we keep it in sync as the user switches tabs in-app.
  document.documentElement.dataset.mode = mode;

  if (pushUrl) {
    const url = new URL(window.location.href);
    url.searchParams.set("mode", mode);
    if (mode !== "1") url.searchParams.delete("rxcui");
    if (mode !== "3") url.searchParams.delete("atc");
    window.history.pushState({}, "", url);
  }
}

// ---------------- URL state ----------------
function readUrlState() {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get("mode") || "1";
  // Accept "about" alongside the numeric modes; everything else falls back to "1".
  const valid = ["1", "2", "3", "4", "5", "about"];
  return {
    mode:  valid.includes(mode) ? mode : "1",
    rxcui: params.get("rxcui") || "",
    atc:   params.get("atc") || "",
  };
}
function writeMode1Url(rxcui) {
  const url = new URL(window.location.href);
  url.searchParams.set("mode", "1");
  if (rxcui) url.searchParams.set("rxcui", rxcui);
  else url.searchParams.delete("rxcui");
  window.history.pushState({}, "", url);
}

// ---------------- mode 1 plumbing ----------------
function getMode1Refs() {
  return {
    input: document.getElementById("mode1-input"),
    submit: document.getElementById("mode1-submit"),
    banner: document.getElementById("mode1-detect-banner-slot"),
    result: document.getElementById("mode1-result"),
  };
}

async function runMode1Lookup(rxcui) {
  const { input, banner, result } = getMode1Refs();
  if (input.value !== rxcui) input.value = rxcui;
  writeMode1Url(rxcui);
  await mode1.submit({
    rxcui,
    resultEl: result,
    bannerEl: banner,
    onSwitchMode: (detected) => {
      handleSwitchMode(detected);
    },
  });
}

function handleSwitchMode(detected) {
  if (detected.type === "ATC") {
    activateTab("3");
    const panel = getMode3Panel();
    if (panel) mode3.submitFromUrl(panel, detected.value);
  }
  // NDC input: Mode 4 now accepts RXCUIs, not NDCs. No auto-switch target.
}

function bindMode1() {
  const { input, submit } = getMode1Refs();

  submit.addEventListener("click", () => {
    runMode1Lookup(input.value.trim());
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      runMode1Lookup(input.value.trim());
    } else if (e.key === "Escape") {
      e.preventDefault();
      input.value = "";
      const { banner, result } = getMode1Refs();
      banner.innerHTML = "";
      result.innerHTML = "";
      writeMode1Url("");
    }
  });

  // Live paste detection — switch banner for ATC, passive notice for NDC.
  input.addEventListener("paste", (e) => {
    const pasted = (e.clipboardData || window.clipboardData)?.getData("text") || "";
    if (!pasted.trim()) return;
    const detected = detectCodeType(pasted);
    const { banner } = getMode1Refs();
    banner.innerHTML = "";
    if (detected.type === "ATC") {
      banner.appendChild(codeDetectionBanner({
        detectedType: "ATC code",
        value: detected.value,
        suggestedModeLabel: MODE_LABEL.ATC,
        onSwitch: () => handleSwitchMode(detected),
        onContinue: () => { banner.innerHTML = ""; },
      }));
    }
    // NDC paste: don't surface a switch banner — no mode accepts NDC input
    // in this build. The submit-time path shows a passive notice if the user
    // actually presses Enter / Look up.
  });

  // Example chips
  document.querySelectorAll(".examples-chips .chip").forEach(chip => {
    chip.addEventListener("click", () => {
      const rx = chip.dataset.rxcui;
      input.value = rx;
      runMode1Lookup(rx);
    });
  });
}

// ---------------- header / footer wiring ----------------
function bindHeader() {
  const themeBtn = document.getElementById("theme-toggle");
  if (themeBtn) themeBtn.addEventListener("click", cycleTheme);
  // Brand link goes to Mode 1; About link goes to the about panel. Both are
  // intercepted so we get an SPA-style switch instead of a full reload.
  const brand = document.querySelector(".brand");
  if (brand) brand.addEventListener("click", (e) => { e.preventDefault(); activateTab("1"); });
  const about = document.querySelector(".about-link");
  if (about) about.addEventListener("click", (e) => { e.preventDefault(); activateTab("about"); });
}
function bindFooter() {
  const clearBtn = document.getElementById("clear-cache");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      clearCache();
      const ok = clearBtn.textContent;
      clearBtn.textContent = "Cleared";
      setTimeout(() => { clearBtn.textContent = ok; }, 1500);
    });
  }
}
function bindTabs() {
  document.querySelectorAll(".tab").forEach(t => {
    t.addEventListener("click", () => {
      activateTab(t.dataset.mode);
    });
  });
}

// ---------------- popstate (browser back) ----------------
window.addEventListener("popstate", () => {
  const state = readUrlState();
  activateTab(state.mode, { pushUrl: false });
  if (state.mode === "1") {
    const { input, banner, result } = getMode1Refs();
    if (state.rxcui) {
      if (input.value !== state.rxcui) input.value = state.rxcui;
      mode1.submit({
        rxcui: state.rxcui,
        resultEl: result,
        bannerEl: banner,
        onSwitchMode: () => {},
      });
    } else {
      input.value = "";
      banner.innerHTML = "";
      result.innerHTML = "";
    }
  } else if (state.mode === "3") {
    const panel = getMode3Panel();
    if (!panel) return;
    if (state.atc) mode3.submitFromUrl(panel, state.atc);
    else mode3.reset(panel);
  } else if (state.mode === "4") {
    const panel = getMode4Panel();
    if (!panel) return;
    if (state.rxcui) mode4.submitFromUrl(panel, state.rxcui);
    else mode4.reset(panel);
  }
});

// ---------------- mode 2 plumbing ----------------
function getMode2Panel() {
  return document.querySelector('.mode-panel[data-mode="2"]');
}
function bindMode2() {
  const panel = getMode2Panel();
  if (panel) mode2.init(panel);
}

// ---------------- mode 3 plumbing ----------------
function getMode3Panel() {
  return document.querySelector('.mode-panel[data-mode="3"]');
}
function bindMode3() {
  const panel = getMode3Panel();
  if (panel) mode3.init(panel);
}

// ---------------- mode 4 plumbing ----------------
function getMode4Panel() {
  return document.querySelector('.mode-panel[data-mode="4"]');
}
function bindMode4() {
  const panel = getMode4Panel();
  if (panel) mode4.init(panel);
}

// ---------------- mode 5 plumbing ----------------
function getMode5Panel() {
  return document.querySelector('.mode-panel[data-mode="5"]');
}
function bindMode5() {
  const panel = getMode5Panel();
  if (panel) mode5.init(panel);
}

// ---------------- boot ----------------
applyTheme(getTheme());
bindHeader();
bindFooter();
bindTabs();
bindMode1();
bindMode2();
bindMode3();
bindMode4();
bindMode5();

const initial = readUrlState();
activateTab(initial.mode, { pushUrl: false });
if (initial.mode === "1" && initial.rxcui) {
  const { input } = getMode1Refs();
  input.value = initial.rxcui;
  runMode1Lookup(initial.rxcui);
} else if (initial.mode === "3" && initial.atc) {
  const panel = getMode3Panel();
  if (panel) mode3.submitFromUrl(panel, initial.atc);
} else if (initial.mode === "4" && initial.rxcui) {
  const panel = getMode4Panel();
  if (panel) mode4.submitFromUrl(panel, initial.rxcui);
}
