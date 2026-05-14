// modes/mode5-batch-rxcui-to-ndcs.js, Mode 5 UI logic.
// Batch RXCUI → active NDCs, up to 200 RXCUIs at a time. The cap matches
// Mode 2's because Mode 5's per-item API cost is actually lighter
// (2 fetches: getProperties + getNdcPropertiesForRxcui) than Mode 2's
// (3-5 fetches per RXCUI through the full resolver chain). The progress
// card carries a Stop button and surfaces partial results on cancel, so
// long runs are interruptible.

import { detectCodeType } from "../code-detection.js";
import {
  getProperties,
  getNdcPropertiesForRxcui,
} from "../rxnav-client.js";
import {
  mode3ProgressCard,
  errorCard,
} from "../ui-components.js";
import {
  isProductTty,
  explainNoNdcsForNonProduct,
  explainNoNdcsForProduct,
} from "../explanations.js";
import { downloadCsv } from "../csv-export.js";

const MAX_BATCH = 200;
// Rough calibration: under our 15-req/sec rate limit + parallel fetch
// pool, each RXCUI in Mode 5 settles around 250-350ms in steady state.
// 300ms is a reasonable middle estimate for the pre-submit duration hint.
const EST_MS_PER_RXCUI = 300;
const DURATION_HINT_THRESHOLD = 5;

let activeRunId = 0;
let activeCancel = null;

// Per-run cancel token (same shape as Mode 3): a flag + a promise that
// resolves when Stop fires. Used by Promise.race so the run wakes
// immediately on cancel instead of waiting for the next member.
function makeCancelToken() {
  let resolveIt;
  const promise = new Promise(r => { resolveIt = r; });
  const token = {
    cancelled: false,
    promise,
    fire() { if (!token.cancelled) { token.cancelled = true; resolveIt(); } },
  };
  return token;
}

function startRun() {
  activeRunId++;
  const runId = activeRunId;
  if (activeCancel) activeCancel.fire();
  const cancel = makeCancelToken();
  activeCancel = cancel;
  return { runId, cancel };
}

// ---------------- public ----------------

export function init(panelEl) {
  const refs = getRefs(panelEl);
  if (!refs.input) return;
  bindInput(refs);
  bindUpload(refs);
  bindAnalyze(refs);
  updateCounter(refs);
}

export function reset(panelEl) {
  const refs = getRefs(panelEl);
  if (!refs.input) return;
  activeRunId++;
  refs.input.value = "";
  for (const k of ["warningSlot", "progressSlot", "summarySlot", "filtersSlot", "tableSlot"]) {
    if (refs[k]) refs[k].innerHTML = "";
  }
  updateCounter(refs);
}

// ---------------- refs / binding ----------------

function getRefs(panelEl) {
  return {
    panel:        panelEl,
    input:        panelEl.querySelector("#mode5-input"),
    counter:      panelEl.querySelector("#mode5-counter"),
    analyze:      panelEl.querySelector("#mode5-analyze"),
    uploadInput:  panelEl.querySelector("#mode5-upload"),
    uploadLink:   panelEl.querySelector("#mode5-upload-link"),
    warningSlot:  panelEl.querySelector("#mode5-input-warning"),
    progressSlot: panelEl.querySelector("#mode5-progress"),
    summarySlot:  panelEl.querySelector("#mode5-summary"),
    filtersSlot:  panelEl.querySelector("#mode5-filters"),
    tableSlot:    panelEl.querySelector("#mode5-table"),
  };
}

function bindInput(refs) {
  refs.input.addEventListener("input", () => updateCounter(refs));
  refs.input.addEventListener("paste", () => setTimeout(() => updateCounter(refs), 0));
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

function bindAnalyze(refs) {
  refs.analyze.addEventListener("click", () => runBatch(refs));
}

// ---------------- parsing ----------------

function parseTokens(raw) {
  const tokens = (raw || "")
    .split(/[\s,;]+/)
    .map(t => t.trim())
    .filter(Boolean);
  const seen = new Set();
  const ordered = [];
  const duplicates = new Set();
  for (const t of tokens) {
    if (seen.has(t)) { duplicates.add(t); continue; }
    seen.add(t);
    ordered.push(t);
  }
  return { ordered, duplicates };
}

function isLikelyRxcui(token) {
  return detectCodeType(token).type === "RXCUI";
}

function parseCsvFirstColumn(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    let cell = lines[i].split(",")[0].trim();
    if (cell.startsWith('"') && cell.endsWith('"')) cell = cell.slice(1, -1);
    if (i === 0 && !/^\d/.test(cell)) continue;
    if (cell) out.push(cell);
  }
  return out;
}

// ---------------- counter / pre-submit warnings ----------------

function updateCounter(refs) {
  const { ordered } = parseTokens(refs.input.value);
  const n = ordered.length;
  refs.counter.textContent = `${n} / ${MAX_BATCH}`;
  refs.counter.classList.toggle("over", n > MAX_BATCH);
  // Analyze stays enabled in the over-cap case: the warning card carries
  // a "Trim to 200 and run" button that drives the actual submission.
  refs.analyze.disabled = n === 0 || n > MAX_BATCH;

  refs.warningSlot.innerHTML = "";

  if (n > MAX_BATCH) {
    // Friendly trim-and-run prompt instead of a hard block. Lets the user
    // proceed with the first 200 in one click, or edit the input manually.
    refs.warningSlot.appendChild(errorCard({
      title: `You pasted ${n} items, current limit is ${MAX_BATCH} per batch`,
      body: `Process the first ${MAX_BATCH} now and skip the rest?`,
      actions: [
        {
          label: `Trim to ${MAX_BATCH} and run`,
          primary: true,
          onClick: () => {
            const first = ordered.slice(0, MAX_BATCH);
            refs.input.value = first.join("\n");
            updateCounter(refs);
            runBatch(refs);
          },
        },
      ],
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
      body: `These will be flagged as Needs review: ${sample}${more}.`,
      variant: "warning",
    }));
  }

  // Soft duration estimate above the threshold. Cheap to recompute and
  // gives the user a heads-up before kicking off a multi-minute run.
  if (n > DURATION_HINT_THRESHOLD) {
    const secs = Math.max(1, Math.round((n * EST_MS_PER_RXCUI) / 1000));
    const text = secs < 60 ? `Estimated time: ~${secs}s` : `Estimated time: ~${Math.round(secs / 60)} min`;
    const hint = document.createElement("p");
    hint.className = "input-hint";
    hint.textContent = text;
    refs.warningSlot.appendChild(hint);
  }
}

// ---------------- batch run ----------------

async function runBatch(refs) {
  const { ordered, duplicates } = parseTokens(refs.input.value);
  if (ordered.length === 0 || ordered.length > MAX_BATCH) return;

  const { runId, cancel } = startRun();

  refs.summarySlot.innerHTML = "";
  refs.filtersSlot.innerHTML = "";
  refs.tableSlot.innerHTML = "";

  refs.progressSlot.innerHTML = "";
  const progCard = mode3ProgressCard({
    title: `Looking up NDCs for ${ordered.length} RXCUI${ordered.length === 1 ? "" : "s"}`,
    status: "Fetching NDC properties…",
  });
  progCard.setOnStop(() => cancel.fire());
  refs.progressSlot.appendChild(progCard.el);
  progCard.update({
    phase: "verifying",
    current: 0, total: ordered.length,
    eta: "Estimating…", lastName: "",
  });

  const records = new Map();
  for (const rxcui of ordered) {
    records.set(rxcui, {
      rxcui, status: "PENDING", subStatus: null,
      tty: "", name: "", entries: [], reason: "",
      duplicate: duplicates.has(rxcui),
    });
  }

  // Visual interpolation: bar starts moving immediately based on EST_MS_PER_RXCUI
  // and refines once real completions arrive. Same shape as Mode 3.
  const startTs = Date.now();
  const completionTs = [];
  let done = 0;
  let lastCompletedName = "";
  let visualPct = 0;

  const recomputeTarget = () => {
    const total = ordered.length;
    const elapsed = Date.now() - startTs;
    const measured = done >= 3 ? elapsed / done : null;
    const perItem = measured || EST_MS_PER_RXCUI;
    const timePct = Math.min(95, (elapsed / (perItem * total)) * 100);
    const realPct = (done / total) * 100;
    return Math.max(visualPct, realPct, timePct);
  };

  const tick = () => {
    if (runId !== activeRunId) return;
    const total = ordered.length;
    let eta = "";
    if (done >= total) {
      eta = `Done in ${formatDuration(Date.now() - startTs)}`;
      visualPct = 100;
    } else if (completionTs.length >= 5) {
      const w = Math.min(5, completionTs.length - 1);
      const span = completionTs[completionTs.length - 1] - completionTs[completionTs.length - 1 - w];
      const perItem = span / w;
      eta = `About ${formatDuration(perItem * (total - done))} remaining`;
    } else if (done > 0) {
      eta = "Estimating…";
    } else {
      eta = "Verifying…";
    }
    progCard.update({ current: done, total, fillPct: visualPct, eta, lastName: lastCompletedName });
  };

  const visualTimer = setInterval(() => {
    if (runId !== activeRunId || cancel.cancelled || done >= ordered.length) return;
    visualPct = Math.max(visualPct, visualPct + (recomputeTarget() - visualPct) * 0.25);
    tick();
  }, 100);

  tick();

  let resolveAllDone;
  const allDone = new Promise(r => { resolveAllDone = r; });

  ordered.forEach(rxcui => {
    processOne({
      rxcui,
      record: records.get(rxcui),
      isStillActive: () => runId === activeRunId && !cancel.cancelled,
    })
      .catch(() => {})
      .then(() => {
        if (runId !== activeRunId || cancel.cancelled) return;
        done++;
        completionTs.push(Date.now());
        const rec = records.get(rxcui);
        lastCompletedName = rec.name ? `${rec.name} (RxCUI ${rxcui})` : `RxCUI ${rxcui}`;
        tick();
        if (done >= ordered.length) resolveAllDone();
      });
  });

  await Promise.race([allDone, cancel.promise]);
  clearInterval(visualTimer);
  if (runId !== activeRunId) return;

  const wasCancelled = cancel.cancelled;
  // Re-compute completed count from records since the tick `done` value may
  // race with late .then() callbacks on the very last completion.
  let completed = 0;
  for (const rec of records.values()) if (rec.status !== "PENDING") completed++;

  if (wasCancelled) {
    // Records mid-flight when Stop fired stay PENDING; surface them in the
    // non-OK section with a clear reason rather than blank cells.
    for (const rec of records.values()) {
      if (rec.status === "PENDING") {
        rec.status = "NEEDS_REVIEW";
        rec.reason = "Cancelled before processing";
      }
    }
    visualPct = Math.min(95, (completed / ordered.length) * 100);
    progCard.update({
      status: `Stopped at ${completed} of ${ordered.length}. Showing partial results below.`,
      eta: "", lastName: "", stopped: true, fillPct: visualPct,
    });
    progCard.finish({ stopped: true });
  } else {
    progCard.update({
      status: `Verified ${completed} of ${ordered.length} RXCUI${ordered.length === 1 ? "" : "s"} in ${formatDuration(Date.now() - startTs)}.`,
      eta: "", lastName: "", fillPct: 100,
    });
    progCard.finish({ stopped: false });
  }

  renderResults(refs, ordered.length, records);
}

async function processOne({ rxcui, record, isStillActive }) {
  if (!isLikelyRxcui(rxcui)) {
    record.status = "NEEDS_REVIEW";
    record.reason = "Token doesn't look like an RXCUI";
    return;
  }

  let props, entries;
  try {
    [props, entries] = await Promise.all([
      getProperties(rxcui),
      getNdcPropertiesForRxcui(rxcui),
    ]);
  } catch {
    if (!isStillActive()) return;
    record.status = "NEEDS_REVIEW";
    record.reason = "Network error reaching RxNav";
    return;
  }
  if (!isStillActive()) return;

  if (!props || !props.found) {
    record.status = "NEEDS_REVIEW";
    record.reason = `RXCUI ${rxcui} not found in RxNav`;
    return;
  }

  record.name = props.name || "";
  record.tty = props.tty || "";
  record.entries = entries;

  if (entries.length === 0) {
    record.status = "NO_NDCS";
    if (isProductTty(props.tty)) {
      record.subStatus = "NO_NDCS_PRODUCT";
      record.reason = `Product (TTY=${props.tty}) with no active NDCs in current release`;
    } else {
      record.subStatus = "NO_NDCS_NON_PRODUCT";
      record.reason = `Non-product TTY (${props.tty}); RxNorm assigns NDCs only to SCD/SBD/BPCK/GPCK`;
    }
  } else {
    record.status = "OK";
  }
}

// ---------------- DOM helper ----------------
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (typeof v === "function" && k.startsWith("on")) node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    if (typeof c === "string") node.appendChild(document.createTextNode(c));
    else node.appendChild(c);
  }
  return node;
}

// ---------------- results render ----------------
//
// Mode 5's primary output is a single flat table: one row per NDC across
// all input RXCUIs. Each row carries the parent RXCUI and drug name so the
// list is self-contained, and the CSV mirrors the table.
//
// RXCUIs that produced no NDCs (or couldn't be processed) don't disappear:
// they're surfaced in a collapsible section below the table, so users can
// see why a given input didn't yield rows.

function renderResults(refs, totalRxcuis, records) {
  refs.progressSlot.innerHTML = "";
  refs.filtersSlot.innerHTML = "";
  refs.summarySlot.innerHTML = "";
  refs.tableSlot.innerHTML = "";

  // Aggregate counts
  let ok = 0, noNdcs = 0, noNdcsProduct = 0, noNdcsNonProduct = 0, review = 0;
  const flatRows = [];
  for (const rec of records.values()) {
    if (rec.status === "OK") {
      ok++;
      for (const e of rec.entries) {
        flatRows.push({
          rxcui: rec.rxcui,
          tty: rec.tty || "",
          drugName: rec.name || "",
          ...e,
        });
      }
    } else if (rec.status === "NO_NDCS") {
      noNdcs++;
      if (rec.subStatus === "NO_NDCS_PRODUCT") noNdcsProduct++;
      else noNdcsNonProduct++;
    } else {
      review++;
    }
  }

  // 1. Summary line + download + reset actions.
  const summary = el("section", { class: "summary-bar" });
  const summaryLine = flatRows.length > 0
    ? `Analyzed ${totalRxcuis} RXCUI${totalRxcuis === 1 ? "" : "s"}. Showing ${flatRows.length} NDC${flatRows.length === 1 ? "" : "s"} across ${ok} RXCUI${ok === 1 ? "" : "s"} with active NDCs.`
    : `Analyzed ${totalRxcuis} RXCUI${totalRxcuis === 1 ? "" : "s"}. No NDCs returned.`;
  summary.appendChild(el("p", { class: "summary-text" }, summaryLine));

  const actions = el("div", { class: "action-row" });
  const dlBtn = el("button", {
    type: "button", class: "btn-primary",
    onclick: () => downloadCsv(
      `medcode-mode5-all-ndcs-${todayStamp()}.csv`,
      buildAllNdcsCsv(records),
    ),
  }, `⬇ Download CSV (${flatRows.length} NDC row${flatRows.length === 1 ? "" : "s"})`);
  const resetBtn = el("button", {
    type: "button", class: "btn-secondary",
    onclick: () => reset(refs.panel),
  }, "Reset");
  actions.appendChild(dlBtn);
  actions.appendChild(resetBtn);
  summary.appendChild(actions);
  refs.summarySlot.appendChild(summary);

  // 2. Flat NDC table (primary view).
  if (flatRows.length > 0) {
    refs.tableSlot.appendChild(buildFlatNdcTable(flatRows));
  } else {
    refs.tableSlot.appendChild(errorCard({
      title: "No NDCs to list",
      body: "None of the supplied RXCUIs returned active NDCs. See the section below for the per-RXCUI breakdown.",
      variant: "info",
    }));
  }

  // 3. Non-OK RXCUIs section. Keeps zero-NDC inputs visible.
  if (noNdcs > 0 || review > 0) {
    refs.tableSlot.appendChild(buildNonOkSection({
      records, noNdcs, noNdcsProduct, noNdcsNonProduct, review,
    }));
  }
}

// ---------------- flat NDC table ----------------

const FLAT_COLUMNS = [
  { key: "rxcui",             label: "RXCUI" },
  { key: "drugName",          label: "Drug" },
  { key: "ndc11",             label: "NDC (11-digit)" },
  { key: "labeler",           label: "Labeler" },
  { key: "packaging",         label: "Packaging" },
  { key: "marketingCategory", label: "Marketing category" },
  { key: "marketingStatus",   label: "Marketing status" },
  { key: "firstMarketedYear", label: "First marketed" },
];

function buildFlatNdcTable(rows) {
  // Precompute the first-marketed year for each row.
  const decorated = rows.map(r => ({
    ...r,
    firstMarketedYear: yearFromYyyymmdd(r.marketingStartDate),
  }));

  let sortKey = "rxcui";
  let sortDir = "asc";

  const tableWrap = el("div", { class: "batch-table-wrap" });
  const table = el("table", { class: "ndc-table" });

  const thead = el("thead");
  const headerRow = el("tr");
  for (const col of FLAT_COLUMNS) {
    const th = el("th", { scope: "col", class: "sortable-th", "data-key": col.key });
    const btn = el("button", { type: "button", class: "th-sort-btn" });
    btn.innerHTML = `${col.label} <span class="sort-indicator" aria-hidden="true"></span>`;
    btn.addEventListener("click", () => {
      if (sortKey === col.key) sortDir = sortDir === "asc" ? "desc" : "asc";
      else { sortKey = col.key; sortDir = "asc"; }
      sortAndRender();
    });
    th.appendChild(btn);
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = el("tbody");
  table.appendChild(tbody);

  function sortAndRender() {
    const sorted = [...decorated].sort((a, b) => compareFlat(a, b, sortKey, sortDir));
    tbody.innerHTML = "";
    for (const r of sorted) {
      const tr = el("tr", { class: "ndc-row" });
      for (const col of FLAT_COLUMNS) {
        const td = el("td", { class: `cell-${col.key}` });
        const v = r[col.key] || "";
        if (col.key === "rxcui" || col.key === "ndc11") {
          td.appendChild(el("span", { class: "code" }, String(v)));
        } else {
          td.textContent = v ? String(v) : "–";
          if (v && (col.key === "drugName" || col.key === "packaging" || col.key === "labeler")) {
            td.title = String(v);
          }
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    for (const th of headerRow.querySelectorAll(".sortable-th")) {
      const ind = th.querySelector(".sort-indicator");
      if (th.dataset.key === sortKey) {
        ind.textContent = sortDir === "asc" ? "▲" : "▼";
        th.classList.add("is-sorted");
      } else {
        ind.textContent = "";
        th.classList.remove("is-sorted");
      }
    }
  }
  sortAndRender();

  tableWrap.appendChild(table);
  const card = el("section", { class: "card ndc-table-card", "aria-label": "All NDCs" });
  card.appendChild(tableWrap);
  return card;
}

function compareFlat(a, b, key, dir) {
  const av = (a[key] || "").toString();
  const bv = (b[key] || "").toString();
  const cmp = /^\d/.test(av) && /^\d/.test(bv)
    ? av.localeCompare(bv, undefined, { numeric: true })
    : av.localeCompare(bv, undefined, { sensitivity: "base" });
  return dir === "asc" ? cmp : -cmp;
}

function yearFromYyyymmdd(s) {
  if (!s) return "";
  const m = /^(\d{4})/.exec(String(s));
  return m ? m[1] : "";
}

// ---------------- non-OK RXCUIs section ----------------

function buildNonOkSection({ records, noNdcs, noNdcsProduct, noNdcsNonProduct, review }) {
  const totalNon = noNdcs + review;
  const card = el("section", { class: "card", "aria-label": "RXCUIs without NDC details" });
  const header = el("p", { class: "card-title" }, `${totalNon} RXCUI${totalNon === 1 ? "" : "s"} without NDC rows`);
  card.appendChild(header);

  const breakdown = [];
  if (noNdcsProduct > 0)     breakdown.push(`${noNdcsProduct} product TTY but no active NDCs`);
  if (noNdcsNonProduct > 0)  breakdown.push(`${noNdcsNonProduct} non-product TTY (RxNorm assigns NDCs only to SCD/SBD/BPCK/GPCK)`);
  if (review > 0)            breakdown.push(`${review} need review`);
  card.appendChild(el("p", { class: "card-body" }, breakdown.join(" · ")));

  const list = el("ul", { class: "non-ok-list" });
  for (const rec of records.values()) {
    if (rec.status === "OK") continue;
    const li = el("li", { class: "non-ok-row" }, [
      el("span", { class: "code" }, rec.rxcui),
      rec.tty ? el("span", { class: "tty-badge" }, rec.tty) : null,
      el("span", { class: "non-ok-name" }, rec.name || "(unknown)"),
      el("span", { class: "non-ok-reason" }, rec.reason || ""),
    ]);
    list.appendChild(li);
  }
  card.appendChild(list);
  return card;
}

// ---------------- CSV ----------------

function buildAllNdcsCsv(records) {
  const rows = [[
    "rxcui", "tty", "drug_name",
    "ndc_11", "ndc_10", "ndc_9",
    "labeler", "packaging",
    "marketing_category", "marketing_status",
    "fda_approval_number",
    "marketing_start_date", "marketing_end_date",
    "first_marketed_year",
  ]];
  for (const rec of records.values()) {
    if (rec.status !== "OK") continue;
    for (const e of rec.entries) {
      rows.push([
        rec.rxcui,
        rec.tty || "",
        rec.name || "",
        e.ndc11 || "",
        e.ndc10 || "",
        e.ndc9  || "",
        e.labeler || "",
        e.packaging || "",
        e.marketingCategory || "",
        e.marketingStatus || "",
        e.fdaApprovalNumber || "",
        e.marketingStartDate || "",
        e.marketingEndDate || "",
        yearFromYyyymmdd(e.marketingStartDate),
      ]);
    }
  }
  return rows;
}

// ---------------- helpers ----------------

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
