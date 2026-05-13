// modes/mode2-batch-forward.js — Mode 2 UI logic.
// Batch validation of up to 200 RXCUIs at a time. Reuses the Mode 1 resolver
// and Mode 1 detail rendering verbatim — Mode 2 owns only batch plumbing:
// parsing, dedupe, table assembly, status classification, progress + ETA,
// filter chips, CSV exports.
//
// No fetch() here; no filter logic here; no inline reason strings — those
// rules from CLAUDE.md still apply.

import { detectCodeType } from "../code-detection.js";
import {
  getProperties,
  getDfgs,
} from "../rxnav-client.js";
import { resolveRoute } from "../filter-engine.js";
import { convertRxcuiToAtc } from "../atc-resolver.js";
import { renderInto as renderMode1Into } from "./mode1-single-forward.js";
import {
  statusBadge,
  progressBar,
  updateProgressBar,
  batchSummaryBar,
  batchRow,
  errorCard,
  educationalBanner,
  statusInfoIcon,
} from "../ui-components.js";
import { downloadCsv } from "../csv-export.js";

const MAX_BATCH = 200;

const STATUSES = ["CLEAN_FIX", "UNCHANGED", "LEGIT_MULTI", "NEEDS_REVIEW"];
const STATUS_CHIP_LABEL = {
  CLEAN_FIX:    "Clean fixes",
  UNCHANGED:    "Unchanged",
  LEGIT_MULTI:  "Legit multi",
  NEEDS_REVIEW: "Needs review",
};

// Per-status copy used in Layer 1 banner, Layer 2 chip tooltips,
// and Layer 3 fallback row tooltips. Single source of truth.
const STATUS_INFO = {
  CLEAN_FIX: {
    dot: "success",
    name: "Clean fix",
    short: "The filter removed wrong-route codes",
    long: "The route filter removed at least one wrong-route ATC code for this drug. The kept code matches the product's actual administration route.",
  },
  UNCHANGED: {
    dot: "muted",
    name: "Unchanged",
    short: "Mapping was already correct",
    long: "All ATC codes for the ingredient already matched this product's route. Nothing needed to be filtered out.",
  },
  LEGIT_MULTI: {
    dot: "accent",
    name: "Multi-route",
    short: "Ingredient with multiple valid codes",
    long: "This is an ingredient-level RXCUI (TTY=IN) with multiple valid Level 5 ATC codes across different routes. No filtering applied — all codes shown as kept.",
  },
  NEEDS_REVIEW: {
    dot: "warning",
    name: "Needs review",
    short: "Couldn't be processed automatically",
    long: "This RXCUI couldn't be processed automatically. Common causes: RXCUI not found, network error, invalid input format, or no ATC mapping in RxNorm.",
  },
};

function buildMode2Banner({ showDismiss = true, ignoreDismissed = false } = {}) {
  return educationalBanner({
    storageKey: "medcode_mode2_status_banner_dismissed",
    title: "Results categorized by what the route filter did",
    items: STATUSES.map(k => ({
      dot: STATUS_INFO[k].dot,
      name: STATUS_INFO[k].name,
      desc: STATUS_INFO[k].short,
    })),
    footnote: "Click any row for the full explanation.",
    showDismiss,
    ignoreDismissed,
  });
}

let mobileWarningDismissed = false;
let activeRunId = 0; // bump to invalidate any in-flight batch when a new one starts

// ---------------- public entry points ----------------

export function init(panelEl) {
  const refs = getRefs(panelEl);
  if (!refs.input) return; // panel not mounted yet
  bindInput(refs);
  bindUpload(refs);
  bindAnalyze(refs);
  updateCounter(refs);
}

export function reset(panelEl) {
  const refs = getRefs(panelEl);
  if (!refs.input) return;
  activeRunId++; // cancel any in-flight batch
  refs.input.value = "";
  refs.warningSlot.innerHTML = "";
  refs.progressSlot.innerHTML = "";
  refs.summarySlot.innerHTML = "";
  refs.filtersSlot.innerHTML = "";
  refs.tableSlot.innerHTML = "";
  refs.mobileSlot.innerHTML = "";
  updateCounter(refs);
}

// ---------------- refs ----------------

function getRefs(panelEl) {
  return {
    panel:        panelEl,
    input:        panelEl.querySelector("#mode2-input"),
    counter:      panelEl.querySelector("#mode2-counter"),
    analyze:      panelEl.querySelector("#mode2-analyze"),
    uploadInput:  panelEl.querySelector("#mode2-upload"),
    uploadLink:   panelEl.querySelector("#mode2-upload-link"),
    warningSlot:  panelEl.querySelector("#mode2-input-warning"),
    mobileSlot:   panelEl.querySelector("#mode2-mobile"),
    progressSlot: panelEl.querySelector("#mode2-progress"),
    summarySlot:  panelEl.querySelector("#mode2-summary"),
    filtersSlot:  panelEl.querySelector("#mode2-filters"),
    tableSlot:    panelEl.querySelector("#mode2-table"),
  };
}

// ---------------- input parsing ----------------

function parseTokens(raw) {
  const tokens = (raw || "")
    .split(/[\s,;]+/)
    .map(t => t.trim())
    .filter(Boolean);

  const seen = new Set();
  const ordered = [];
  const duplicates = new Set();
  for (const t of tokens) {
    if (seen.has(t)) {
      duplicates.add(t);
      continue;
    }
    seen.add(t);
    ordered.push(t);
  }
  return { ordered, duplicates, rawCount: tokens.length };
}

function isLikelyRxcui(token) {
  const d = detectCodeType(token);
  return d.type === "RXCUI";
}

function parseCsvFirstColumn(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    let cell = lines[i].split(",")[0].trim();
    if (cell.startsWith('"') && cell.endsWith('"')) cell = cell.slice(1, -1);
    // Skip a header row: non-digit first character on line 1.
    if (i === 0 && !/^\d/.test(cell)) continue;
    if (cell) out.push(cell);
  }
  return out;
}

// ---------------- input UI ----------------

function bindInput(refs) {
  refs.input.addEventListener("input", () => updateCounter(refs));
  refs.input.addEventListener("paste", () => {
    setTimeout(() => updateCounter(refs), 0);
  });
}

function bindUpload(refs) {
  refs.uploadLink.addEventListener("click", (e) => {
    e.preventDefault();
    refs.uploadInput.click();
  });
  refs.uploadInput.addEventListener("change", async () => {
    const file = refs.uploadInput.files && refs.uploadInput.files[0];
    if (!file) return;
    const text = await file.text();
    const tokens = parseCsvFirstColumn(text);
    refs.input.value = tokens.join("\n");
    updateCounter(refs);
    refs.uploadInput.value = "";
  });
}

function updateCounter(refs) {
  const { ordered } = parseTokens(refs.input.value);
  const n = ordered.length;
  refs.counter.textContent = `${n} / ${MAX_BATCH}`;
  refs.counter.classList.toggle("over", n > MAX_BATCH);
  refs.analyze.disabled = n === 0 || n > MAX_BATCH;

  refs.warningSlot.innerHTML = "";
  if (n > MAX_BATCH) {
    refs.warningSlot.appendChild(errorCard({
      title: `Over the ${MAX_BATCH}-RXCUI cap`,
      body: `Mode 2 accepts up to ${MAX_BATCH} RXCUIs per batch. You have ${n}. Trim the list or split it into multiple runs.`,
      variant: "warning",
    }));
    return;
  }
  if (n === 0) return;

  const invalid = ordered.filter(t => !isLikelyRxcui(t));
  if (invalid.length > 0) {
    const sample = invalid.slice(0, 3).join(", ");
    const more = invalid.length > 3 ? ` (and ${invalid.length - 3} more)` : "";
    refs.warningSlot.appendChild(errorCard({
      title: `${invalid.length} token${invalid.length === 1 ? "" : "s"} don't look like RXCUIs`,
      body: `These will be flagged as Needs review in the results: ${sample}${more}.`,
      variant: "warning",
    }));
  }
}

// ---------------- batch run ----------------

function bindAnalyze(refs) {
  refs.analyze.addEventListener("click", () => runBatch(refs));
}

async function runBatch(refs) {
  // Mobile gate (one-time per session)
  const isMobile = window.matchMedia("(max-width: 768px)").matches;
  if (isMobile && !mobileWarningDismissed) {
    showMobileWarning(refs);
    return;
  }

  const { ordered, duplicates } = parseTokens(refs.input.value);
  if (ordered.length === 0 || ordered.length > MAX_BATCH) return;

  activeRunId++;
  const runId = activeRunId;

  // Wipe prior run output
  refs.summarySlot.innerHTML = "";
  refs.filtersSlot.innerHTML = "";
  refs.tableSlot.innerHTML = "";

  // Build progress bar
  refs.progressSlot.innerHTML = "";
  const progEl = progressBar({ done: 0, total: ordered.length, eta: "Estimating…" });
  refs.progressSlot.appendChild(progEl);

  // Build empty table
  const { table, tbody } = buildTable();
  refs.tableSlot.appendChild(table);

  // Pre-build all rows in pending state so the table is visible immediately.
  const records = new Map(); // rxcui → record
  const rowApis = new Map(); // rxcui → batchRow handle
  for (const rxcui of ordered) {
    const rowApi = batchRow({ rxcui, isDuplicate: duplicates.has(rxcui) });
    tbody.appendChild(rowApi.tr);
    tbody.appendChild(rowApi.detailRow);
    rowApis.set(rxcui, rowApi);
    records.set(rxcui, {
      rxcui, status: "PENDING",
      name: "", tty: "", route: "", kept: [], removed: 0, reason: "",
      duplicate: duplicates.has(rxcui),
    });
  }

  const startTs = Date.now();
  let done = 0;

  const tick = () => {
    if (runId !== activeRunId) return;
    const elapsed = Date.now() - startTs;
    let eta;
    if (done === 0) eta = "Estimating…";
    else if (done >= ordered.length) eta = `Done in ${formatDuration(elapsed)}`;
    else {
      const avg = elapsed / done;
      const remaining = avg * (ordered.length - done);
      eta = `~${formatDuration(remaining)} remaining`;
    }
    updateProgressBar(progEl, { done, total: ordered.length, eta });
  };
  tick();

  // Fire all tasks in parallel — the rxnav-client's internal Promise pool
  // (6 concurrent) and rate limiter (15 req/sec) keep this from melting the API.
  const tasks = ordered.map((rxcui) => processOne({
    rxcui,
    rowApi: rowApis.get(rxcui),
    record: records.get(rxcui),
    runId,
    isStillActive: () => runId === activeRunId,
  }).then(() => {
    if (runId !== activeRunId) return;
    done++;
    tick();
  }).catch(() => {
    // processOne already records errors into the row; never throw.
    if (runId !== activeRunId) return;
    done++;
    tick();
  }));

  await Promise.all(tasks);
  if (runId !== activeRunId) return;

  // Wire row-expand handlers for valid rows (after data is in)
  for (const [rxcui, rowApi] of rowApis) {
    const rec = records.get(rxcui);
    if (rec.status === "NEEDS_REVIEW" && rec.kept.length === 0) continue; // can't expand a NEEDS_REVIEW invalid token
    rowApi.setOnExpand((container) => {
      renderMode1Into({ rxcui, resultEl: container }).catch(() => {});
    });
  }

  // Build summary + filter chips
  const counts = countByStatus(records);
  renderSummary(refs, ordered.length, counts, records);
  renderFilterChips(refs, counts, tbody);
}

async function processOne({ rxcui, rowApi, record, runId, isStillActive }) {
  // Token-level validation: not an RXCUI → straight to NEEDS_REVIEW, no fetch.
  if (!isLikelyRxcui(rxcui)) {
    record.status = "NEEDS_REVIEW";
    record.reason = "Token doesn't look like an RXCUI";
    rowApi.update({
      status: "NEEDS_REVIEW",
      name: record.reason,
      route: "",
      kept: [],
      removed: 0,
      reason: record.reason,
      tooltip: record.reason,
    });
    return;
  }

  let props, dfgs, result;
  try {
    [props, dfgs, result] = await Promise.all([
      getProperties(rxcui),
      getDfgs(rxcui),
      convertRxcuiToAtc(rxcui),
    ]);
  } catch (err) {
    if (!isStillActive()) return;
    record.status = "NEEDS_REVIEW";
    record.reason = "Network error reaching RxNav";
    rowApi.update({
      status: "NEEDS_REVIEW",
      name: "Network error",
      route: "",
      kept: [],
      removed: 0,
      reason: record.reason,
      tooltip: record.reason,
    });
    return;
  }
  if (!isStillActive()) return;

  if (!props || !props.found) {
    record.status = "NEEDS_REVIEW";
    record.reason = `RXCUI ${rxcui} not found in RxNav`;
    rowApi.update({
      status: "NEEDS_REVIEW",
      name: "Not in RxNav",
      route: "",
      kept: [],
      removed: 0,
      reason: record.reason,
      tooltip: record.reason,
    });
    return;
  }

  record.name = props.name || "";
  record.tty = props.tty || "";

  // Route resolution + rejected-L4 count (the table shows the count of
  // ingredient-level Level 4 ATC subgroups removed by the route filter;
  // the row-expand renders the full Mode 1 view with L4→L5 promotion).
  const route = result.status === "INGREDIENT_LEVEL"
    ? ""
    : resolveRoute(dfgs);
  record.route = (route && route !== "unknown") ? route : "";

  // The engine attaches `rejectedL4` — the deduped final state of route-
  // filter rejections (already excludes ATCPROD-overridden L4s and the
  // L4 prefixes of kept L5 codes). This is the single source of truth;
  // Mode 1's row-expand renders the same list as rejected cards.
  const removed = Array.isArray(result && result.rejectedL4) ? result.rejectedL4.length : 0;
  record.removed = removed;

  const keptL5 = (Array.isArray(result.codes) ? result.codes : [])
    .filter(c => (c.code || "").length === 7);
  record.kept = keptL5;

  // Status classification — per the revised rule:
  //   KEEP, has rejections          → CLEAN_FIX
  //   KEEP, no rejections           → UNCHANGED
  //   INGREDIENT_LEVEL, kept == 1   → UNCHANGED
  //   INGREDIENT_LEVEL, kept >= 2   → LEGIT_MULTI
  //   KEEP with no Level 5 kept     → NEEDS_REVIEW (L4-only fallback, unresolvable)
  //   NO_ATC, etc.                  → NEEDS_REVIEW
  let status;
  if (result.status === "INGREDIENT_LEVEL") {
    if (keptL5.length === 0) {
      status = "NEEDS_REVIEW";
      record.reason = "No ATC mapping stored for this ingredient";
    } else if (keptL5.length === 1) {
      status = "UNCHANGED";
    } else {
      status = "LEGIT_MULTI";
    }
  } else if (result.status === "KEEP") {
    if (keptL5.length === 0) {
      status = "NEEDS_REVIEW";
      record.reason = "Level 5 ATC could not be resolved (L4 fallback only)";
    } else if (removed > 0) {
      status = "CLEAN_FIX";
    } else {
      status = "UNCHANGED";
    }
  } else {
    status = "NEEDS_REVIEW";
    record.reason = "No ATC mapping available";
  }
  record.status = status;

  rowApi.update({
    status,
    name: record.name || "(unknown)",
    route: record.route || (result.status === "INGREDIENT_LEVEL" ? "ingredient" : "—"),
    kept: keptL5,
    removed,
    reason: record.reason,
    tooltip: buildRowTooltip(record),
  });
}

// ---------------- summary + filters ----------------

function countByStatus(records) {
  const counts = { CLEAN_FIX: 0, UNCHANGED: 0, LEGIT_MULTI: 0, NEEDS_REVIEW: 0 };
  for (const rec of records.values()) {
    if (counts[rec.status] != null) counts[rec.status]++;
  }
  return counts;
}

function renderSummary(refs, total, counts, records) {
  refs.summarySlot.innerHTML = "";
  refs.summarySlot.appendChild(batchSummaryBar({
    total,
    cleanFix:     counts.CLEAN_FIX,
    unchanged:    counts.UNCHANGED,
    legitMulti:   counts.LEGIT_MULTI,
    needsReview:  counts.NEEDS_REVIEW,
    onDownloadCleaned: () => downloadCleaned(records),
    onDownloadAudit:   () => downloadAudit(records),
    onReset: () => reset(refs.panel),
  }));
}

function renderFilterChips(refs, counts, tbody) {
  refs.filtersSlot.innerHTML = "";

  // Layer 1 — educational banner above the chips (dismissible, persisted)
  const banner = buildMode2Banner();
  if (banner) refs.filtersSlot.appendChild(banner);

  const chips = [
    { key: "ALL", label: "All", count: counts.CLEAN_FIX + counts.UNCHANGED + counts.LEGIT_MULTI + counts.NEEDS_REVIEW, tooltip: "" },
    ...STATUSES.map(s => ({
      key: s,
      label: STATUS_CHIP_LABEL[s],
      count: counts[s],
      tooltip: STATUS_INFO[s].long,
    })),
  ];
  let active = "ALL";

  const chipBar = document.createElement("div");
  chipBar.className = "filter-chips";

  function applyFilter(key) {
    active = key;
    for (const btn of chipBar.querySelectorAll(".filter-chip")) {
      btn.classList.toggle("is-active", btn.dataset.key === key);
      btn.setAttribute("aria-pressed", btn.dataset.key === key ? "true" : "false");
    }
    for (const tr of tbody.querySelectorAll("tr.batch-row")) {
      const rowStatus = tr.dataset.status;
      const visible = key === "ALL" || rowStatus === key;
      tr.hidden = !visible;
      const detail = tr.nextElementSibling;
      if (detail && detail.classList.contains("batch-row-detail")) {
        if (!visible) detail.hidden = true;
      }
    }
  }

  for (const c of chips) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "filter-chip" + (c.key === active ? " is-active" : "");
    btn.dataset.key = c.key;
    btn.setAttribute("aria-pressed", c.key === active ? "true" : "false");
    btn.setAttribute("data-tooltip-pos", "bottom");
    if (c.tooltip) {
      btn.setAttribute("data-tooltip", c.tooltip);
      btn.setAttribute("aria-label", `${c.label} (${c.count}) — ${c.tooltip}`);
    }
    btn.innerHTML = `${c.label} <span class="filter-chip-count">${c.count}</span>`;
    btn.addEventListener("click", () => applyFilter(c.key));
    chipBar.appendChild(btn);
  }
  refs.filtersSlot.appendChild(chipBar);

  // Header info icon — re-open the banner content as a popover even if dismissed.
  // The status column header is the first <th> in the rendered table.
  const statusTh = refs.tableSlot.querySelector(".batch-table thead th:first-child");
  if (statusTh && !statusTh.querySelector(".col-info-btn")) {
    const { iconBtn } = statusInfoIcon({
      buildBanner: (force) => buildMode2Banner({ showDismiss: false, ignoreDismissed: !!force || true }),
    });
    statusTh.appendChild(iconBtn);
  }
}

// Build a per-row tooltip string. Called whenever a record is updated.
function buildRowTooltip(record) {
  const s = record.status;
  if (!s || s === "PENDING") return "";

  if (s === "CLEAN_FIX") {
    const keptCodes = (record.kept || []).map(k => k.code).filter(Boolean);
    const removed = record.removedAtcs || [];
    const removedStr = removed.length
      ? removed.map(r => r.code + (r.route ? ` (${r.route})` : "")).join(", ")
      : `${record.removed || 0} wrong-route code${(record.removed || 0) === 1 ? "" : "s"}`;
    const total = keptCodes.length + (record.removed || 0);
    return `This drug had ${total} candidate ATC codes for its ingredient. The route filter kept ${keptCodes.join(", ") || "—"} (matches ${record.route} route) and removed ${removed.length || record.removed || 0} wrong-route code${(removed.length || record.removed || 0) === 1 ? "" : "s"}${removed.length ? ": " + removedStr : ""}.`;
  }
  if (s === "UNCHANGED") {
    const n = (record.kept || []).length;
    return `This drug had ${n} candidate ATC code${n === 1 ? "" : "s"} for its ingredient, all of which matched the ${record.route || "—"} route. No filtering needed.`;
  }
  if (s === "LEGIT_MULTI") {
    const n = (record.kept || []).length;
    return `Ingredient-level RXCUI (TTY=${record.tty || "IN"}). Returned ${n} canonical Level 5 ATC codes across multiple anatomical groups. Route filtering doesn't apply at ingredient level.`;
  }
  if (s === "NEEDS_REVIEW") {
    return record.reason || STATUS_INFO.NEEDS_REVIEW.long;
  }
  return "";
}

// ---------------- CSV downloads ----------------

function downloadCleaned(records) {
  const rows = [["rxcui", "drug_name", "tty", "route", "kept_atc", "kept_atc_name"]];
  for (const rec of records.values()) {
    if (rec.status === "NEEDS_REVIEW") continue;
    if (!rec.kept || rec.kept.length === 0) continue;
    for (const k of rec.kept) {
      rows.push([rec.rxcui, rec.name, rec.tty, rec.route, k.code, k.name || ""]);
    }
  }
  downloadCsv(`medcode-cleaned-${todayStamp()}.csv`, rows);
}

function downloadAudit(records) {
  const rows = [[
    "rxcui", "status", "drug_name", "tty", "route",
    "kept_count", "kept_atcs", "kept_atc_names", "removed_count",
    "reason", "duplicate_in_input",
  ]];
  for (const rec of records.values()) {
    rows.push([
      rec.rxcui,
      rec.status,
      rec.name,
      rec.tty,
      rec.route,
      String((rec.kept || []).length),
      (rec.kept || []).map(k => k.code).join(";"),
      (rec.kept || []).map(k => k.name || "").join(";"),
      String(rec.removed || 0),
      rec.reason || "",
      rec.duplicate ? "true" : "false",
    ]);
  }
  downloadCsv(`medcode-audit-${todayStamp()}.csv`, rows);
}

// ---------------- helpers ----------------

function buildTable() {
  const table = document.createElement("table");
  table.className = "batch-table";
  const thead = document.createElement("thead");
  thead.innerHTML = `
    <tr>
      <th scope="col">Status</th>
      <th scope="col">RXCUI</th>
      <th scope="col">Drug</th>
      <th scope="col">Route</th>
      <th scope="col">Kept</th>
      <th scope="col">Removed</th>
      <th scope="col" aria-label="Expand"></th>
    </tr>`;
  const tbody = document.createElement("tbody");
  table.appendChild(thead);
  table.appendChild(tbody);
  return { table, tbody };
}

function showMobileWarning(refs) {
  refs.mobileSlot.innerHTML = "";
  refs.mobileSlot.appendChild(errorCard({
    title: "Mode 2 works best on desktop",
    body: "The results table is wide and easier to read on a larger screen. You can continue here if you'd like.",
    actions: [
      { label: "Continue anyway", primary: true, onClick: () => {
          mobileWarningDismissed = true;
          refs.mobileSlot.innerHTML = "";
          runBatch(refs);
        },
      },
    ],
    variant: "info",
  }));
}

function formatDuration(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
}

function todayStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}
