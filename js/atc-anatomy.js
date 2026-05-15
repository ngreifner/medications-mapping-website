// atc-anatomy.js, ATC Code Anatomy renderer.
//
// Ported (DOM-based) from the original browser app's buildAtcAnatomy /
// enrichAtcAnatomy pair. Visually decomposes an ATC code into its 5
// hierarchical levels:
//
//   Level 1, Anatomical main group        (1 letter)        e.g. R
//   Level 2, Therapeutic subgroup          (2 digits)        e.g. 01
//   Level 3, Pharmacological subgroup      (1 letter)        e.g. A
//   Level 4, Chemical subgroup             (1 letter)        e.g. D
//   Level 5, Individual chemical substance (2 digits)        e.g. 08
//
// buildAtcAnatomyElement(code, hintName) returns an HTMLElement.
// enrichAtcAnatomy(element, code) async-patches L2–L5 class names into
// the element's [data-atc-title] slots in parallel.

import { getAtcClassName } from "./rxnav-client.js";

// ---------------- pure data ----------------

/** Anatomical main groups (ATC Level 1), letter → { title, emoji }. */
export const ATC_LEVEL1 = {
  A: { title: "Alimentary tract and metabolism", emoji: "\u{1FAC4}", short: "Digestive / metabolic" },
  B: { title: "Blood and blood forming organs", emoji: "\u{1FA78}", short: "Blood" },
  C: { title: "Cardiovascular system", emoji: "❤️", short: "Cardiovascular" },
  D: { title: "Dermatologicals", emoji: "\u{1F9F4}", short: "Dermatological" },
  G: { title: "Genito urinary system and sex hormones", emoji: "\u{1FAD8}", short: "Genito-urinary / hormones" },
  H: { title: "Systemic hormonal preparations, excl. sex hormones and insulins", emoji: "\u{1F489}", short: "Systemic hormones" },
  J: { title: "Antiinfectives for systemic use", emoji: "\u{1F9A0}", short: "Anti-infective" },
  L: { title: "Antineoplastic and immunomodulating agents", emoji: "\u{1F397}️", short: "Oncology / immunology" },
  M: { title: "Musculo-skeletal system", emoji: "\u{1F9B4}", short: "Musculoskeletal" },
  N: { title: "Nervous system", emoji: "\u{1F9E0}", short: "Nervous system" },
  P: { title: "Antiparasitic products, insecticides and repellents", emoji: "\u{1FAB2}", short: "Antiparasitic" },
  R: { title: "Respiratory system", emoji: "\u{1FAC1}", short: "Respiratory" },
  S: { title: "Sensory organs", emoji: "\u{1F441}️", short: "Sensory organs" },
  V: { title: "Various", emoji: "\u{1F4E6}", short: "Various" },
};

/**
 * Return the Level-1 anatomical family for an ATC code (any level).
 * Returns { letter, glyph, short, title } or null if the leading letter
 * isn't a known L1 group. Used by ui-components to render a small "family
 * pill" on kept / rejected / drug-identity cards so the user sees at a
 * glance which anatomical class a code belongs to.
 */
export function familyForAtc(atc) {
  if (!atc) return null;
  const letter = String(atc).charAt(0).toUpperCase();
  const entry = ATC_LEVEL1[letter];
  if (!entry) return null;
  return {
    letter,
    glyph: entry.emoji,
    short: entry.short,
    title: entry.title,
  };
}

/**
 * Parse an ATC code into its hierarchical levels.
 * Returns null if the code's first character isn't a known Level 1 letter.
 */
export function parseAtcAnatomy(code) {
  if (!code) return null;
  const c = String(code).toUpperCase().replace(/\s/g, "");
  if (c.length < 1) return null;
  const letter = c.charAt(0);
  const l1 = ATC_LEVEL1[letter];
  if (!l1) return null;

  const levels = [];
  levels.push({
    code: letter,
    level: 1,
    color: "atc1",
    title: `${l1.emoji} ${l1.title}`,
    sub: "Level 1, Anatomical main group",
  });
  if (c.length >= 3) {
    levels.push({
      code: c.substring(1, 3),
      level: 2,
      color: "atc2",
      title: "Therapeutic/Pharmacological subgroup",
      sub: "Level 2, 2-digit therapeutic subgroup",
    });
  }
  if (c.length >= 4) {
    levels.push({
      code: c.charAt(3),
      level: 3,
      color: "atc3",
      title: "Pharmacological/Therapeutic subgroup",
      sub: "Level 3, Pharmacological subgroup",
    });
  }
  if (c.length >= 5) {
    levels.push({
      code: c.charAt(4),
      level: 4,
      color: "atc4",
      title: "Chemical/Pharmacological/Therapeutic subgroup",
      sub: "Level 4, Chemical subgroup",
    });
  }
  if (c.length >= 7) {
    levels.push({
      code: c.substring(5, 7),
      level: 5,
      color: "atc5",
      title: "Chemical substance",
      sub: "Level 5, Individual chemical substance",
    });
  }
  const maxLevel = levels[levels.length - 1].level;
  return { raw: c, letter, levels, maxLevel };
}

/** Cumulative prefix codes for each level (e.g. "R" → ["R","R01","R01A","R01AD","R01AD08"]). */
export function atcLevelCodes(code) {
  const c = String(code || "").toUpperCase().replace(/\s/g, "");
  const cuts = [1, 3, 4, 5, 7];
  const out = [];
  for (const n of cuts) if (c.length >= n) out.push(c.substring(0, n));
  return out;
}

// ---------------- DOM helpers ----------------

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "style") node.setAttribute("style", v);
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === "dataset") {
      for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = dv;
    } else {
      node.setAttribute(k, v);
    }
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    if (typeof c === "string") node.appendChild(document.createTextNode(c));
    else node.appendChild(c);
  }
  return node;
}

// ---------------- renderer ----------------

/**
 * Build the anatomy card for an ATC code as an HTMLElement.
 *
 * @param {string} code, the ATC code (any level)
 * @param {string} [hintName], optional name to use as the deepest level's
 *   title until async enrichment fills in the canonical class name. Mode 1
 *   passes the kept ATC's name here (e.g. "fluticasone").
 */
export function buildAtcAnatomyElement(code, hintName = "") {
  const anatomy = parseAtcAnatomy(code);
  if (!anatomy) return null;

  // Visual code segments. The deepest segment gets .is-final for a subtle glow.
  const visual = el("div", { class: "ca-visual" },
    anatomy.levels.map((l, i) => el("span", {
      class: `ca-seg ca-seg-${l.color}${i === anatomy.levels.length - 1 ? " is-final" : ""}`,
    }, l.code))
  );

  // Per-level rows
  const rows = el("div", { class: "ca-rows" });
  anatomy.levels.forEach((l, i) => {
    // For the deepest level, prefer the hint (the kept code's drug name) until
    // enrichment fetches the canonical className.
    let title = l.title;
    if (l.level > 1 && hintName && l.level === anatomy.maxLevel) title = hintName;

    const row = el("div", {
      class: "ca-row",
      style: `animation-delay:${i * 80}ms`,
      dataset: { atcLevel: String(l.level) },
    }, [
      el("span", { class: `ca-connector ca-color-${l.color}` }),
      el("div", { class: "ca-detail" }, [
        el("span", { class: `ca-label-tag ca-color-${l.color}` }, l.code),
        el("span", {
          class: "ca-row-title",
          dataset: { atcTitle: String(l.level) },
        }, title),
        el("span", { class: "ca-row-sub" }, l.sub),
      ]),
    ]);
    rows.appendChild(row);
  });

  // Toggle bar + content. Starts collapsed, user expands on demand.
  const content = el("div", { class: "ca-content", style: "display:none" }, [visual, rows]);
  const chevron = el("span", { class: "ca-chevron", "aria-hidden": "true" }, "▼");
  const toggle = el("button", {
    type: "button",
    class: "ca-toggle",
    "aria-expanded": "false",
  }, [
    el("span", { class: "ca-toggle-title" }, "\u{1F9EC} Code Anatomy"),
    el("span", { class: "ca-badge" }, "ATC"),
    chevron,
  ]);
  toggle.addEventListener("click", () => {
    const open = toggle.classList.toggle("is-open");
    content.style.display = open ? "" : "none";
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
  });

  return el("section", { class: "ca-card", "aria-label": `Anatomy of ATC ${code}` }, [toggle, content]);
}

// ---------------- async enrichment ----------------

/**
 * Fetch canonical class names for L2–L5 in parallel and patch the
 * `[data-atc-title="N"]` slots inside the given anatomy element.
 * Level 1 is skipped (we already have its name from ATC_LEVEL1).
 */
export async function enrichAtcAnatomy(element, code) {
  if (!element) return;
  const subs = atcLevelCodes(code);
  if (subs.length <= 1) return;

  const fetches = subs.map((sub, i) => {
    if (i === 0) return Promise.resolve(null); // Level 1 already known
    return getAtcClassName(sub).catch(() => null);
  });
  const results = await Promise.all(fetches);

  results.forEach((name, i) => {
    if (i === 0 || !name) return;
    const level = i + 1;
    const slot = element.querySelector(`[data-atc-title="${level}"]`);
    if (!slot) return;
    slot.textContent = name;
    slot.style.opacity = "0";
    requestAnimationFrame(() => {
      slot.style.transition = "opacity .3s ease";
      slot.style.opacity = "1";
    });
  });
}
