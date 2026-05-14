// modes/mode7-batch-ndc-to-rxcui.js, Mode 7 UI logic.
// Batch NDC → RxCUI via RxNav's /ndcstatus endpoint. Returns the parent
// RxCUI, drug concept name, RxNorm status, the canonical 11-digit form,
// and the marketing-range history window. Same input/cap/progress/Stop
// shape as Modes 5/6.

import { getNdcStatus } from "../rxnav-client.js";
import {
  mode3ProgressCard,
  errorCard,
} from "../ui-components.js";
import { downloadCsv } from "../csv-export.js";

const MAX_BATCH = 200;
// Single RxNav fetch per NDC, well below RxNav's 15 req/sec ceiling. Cold-
// cache settles around 150-300 ms per NDC end-to-end after rate-limit
// warm-up; 250 ms is a safe baseline for the pre-submit duration hint.
const EST_MS_PER_NDC = 250;
const DURATION_HINT_THRESHOLD = 5;

let activeRunId = 0;
let activeCancel = null;

function makeCancelToken() {
  let resolveIt;
  const promise = new Promise(r => { resolveIt = r; });
  const t = {
    cancelled: false,
    promise,
    fire() { if (!t.cancelled) { t.cancelled = true; resolveIt(); } },
  };
  return t;
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
  if (activeCancel) activeCancel.fire();
  refs.input.value = "";
  for (const k of ["warningSlot", "progressSlot", "summarySlot", "tableSlot"]) {
    if (refs[k]) refs[k].innerHTML = "";
  }
  updateCounter(refs);
}

function getRefs(panelEl) {
  return {
    panel:        panelEl,
    input:        panelEl.querySelector("#mode7-input"),
    counter:      panelEl.querySelector("#mode7-counter"),
    analyze:      panelEl.querySelector("#mode7-analyze"),
    uploadInput:  panelEl.querySelector("#mode7-upload"),
    uploadLink:   panelEl.querySelector("#mode7-upload-link"),
    warningSlot:  panelEl.querySelector("#mode7-input-warning"),
    progressSlot: panelEl.querySelector("#mode7-progress"),
    summarySlot:  panelEl.querySelector("#mode7-summary"),
    tableSlot:    panelEl.querySelector("#mode7-table"),
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
  // Split on whitespace + commas/semicolons; dashed NDCs stay intact.
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

function looksLikeNdc(token) {
  const digits = String(token).replace(/\D/g, "");
  return digits.length === 10 || digits.length === 11;
}

function parseCsvFirstColumn(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    let cell = lines[i].split(",")[0].trim();
    if (cell.startsWith('"') && cell.endsWith('"')) cell = cell.slice(1, -1);
    if (i === 0 && !/^[\d-]/.test(cell)) continue;
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
  refs.analyze.disabled = n === 0 || n > MAX_BATCH;

  refs.warningSlot.innerHTML = "";

  if (n > MAX_BATCH) {
    refs.warningSlot.appendChild(errorCard({
      title: `You pasted ${n} items, current limit is ${MAX_BATCH} per batch`,
      body: `Process the first ${MAX_BATCH} now and skip the rest?`,
      actions: [{
        label: `Trim to ${MAX_BATCH} and run`,
        primary: true,
        onClick: () => {
          refs.input.value = ordered.slice(0, MAX_BATCH).join("\n");
          updateCounter(refs);
          runBatch(refs);
        },
      }],
      variant: "warning",
    }));
    return;
  }

  if (n === 0) return;

  const invalid = ordered.filter(t => !looksLikeNdc(t));
  if (invalid.length > 0) {
    const sample = invalid.slice(0, 3).join(", ");
    const more = invalid.length > 3 ? ` (and ${invalid.length - 3} more)` : "";
    refs.warningSlot.appendChild(errorCard({
      title: `${invalid.length} token${invalid.length === 1 ? "" : "s"} don't look like NDCs`,
      body: `NDCs are 10 or 11 digits, optionally dashed. These will be skipped: ${sample}${more}.`,
      variant: "warning",
    }));
  }

  if (n > DURATION_HINT_THRESHOLD) {
    const secs = Math.max(1, Math.round((n * EST_MS_PER_NDC) / 1000));
    const text = secs < 60 ? `Estimated time: ~${secs}s` : `Estimated time: ~${Math.round(secs / 60)} min`;
    const hint = document.createElement("p");
    hint.className = "input-hint";
    hint.textContent = text;
    refs.warningSlot.appendChild(hint);
  }
}

// ---------------- batch run ----------------

async function runBatch(refs) {
  const { ordered } = parseTokens(refs.input.value);
  if (ordered.length === 0 || ordered.length > MAX_BATCH) return;
  const candidates = ordered.filter(looksLikeNdc);
  if (candidates.length === 0) {
    refs.warningSlot.innerHTML = "";
    refs.tableSlot.innerHTML = "";
    refs.summarySlot.innerHTML = "";
    refs.summarySlot.appendChild(errorCard({
      title: "No valid NDCs in input",
      body: "Every token failed the 10/11-digit format check.",
      variant: "warning",
    }));
    return;
  }

  const { runId, cancel } = startRun();

  refs.summarySlot.innerHTML = "";
  refs.tableSlot.innerHTML = "";
  refs.progressSlot.innerHTML = "";

  const progCard = mode3ProgressCard({
    title: `Resolving ${candidates.length} NDC${candidates.length === 1 ? "" : "s"} to RxCUIs`,
    status: "Querying RxNav…",
  });
  progCard.setOnStop(() => cancel.fire());
  refs.progressSlot.appendChild(progCard.el);
  progCard.update({
    phase: "verifying",
    current: 0, total: candidates.length,
    eta: "Estimating…", lastName: "",
  });

  const startTs = Date.now();
  const results = new Array(candidates.length).fill(null);
  const completionTs = [];
  let done = 0;
  let lastName = "";
  let visualPct = 0;

  const recomputeTarget = () => {
    const total = candidates.length;
    const elapsed = Date.now() - startTs;
    const measured = done >= 3 ? elapsed / done : null;
    const perItem = measured || EST_MS_PER_NDC;
    const timePct = Math.min(95, (elapsed / (perItem * total)) * 100);
    const realPct = (done / total) * 100;
    return Math.max(visualPct, realPct, timePct);
  };

  const tick = () => {
    if (runId !== activeRunId) return;
    const total = candidates.length;
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
      eta = "Fetching…";
    }
    progCard.update({ current: done, total, fillPct: visualPct, eta, lastName });
  };

  const visualTimer = setInterval(() => {
    if (runId !== activeRunId || cancel.cancelled || done >= candidates.length) return;
    visualPct = Math.max(visualPct, visualPct + (recomputeTarget() - visualPct) * 0.25);
    tick();
  }, 100);

  tick();

  let resolveAllDone;
  const allDone = new Promise(r => { resolveAllDone = r; });

  candidates.forEach((ndc, i) => {
    getNdcStatus(ndc)
      .catch(() => null)
      .then(rec => {
        if (runId !== activeRunId || cancel.cancelled) return;
        results[i] = rec;
        done++;
        completionTs.push(Date.now());
        lastName = rec && rec.conceptName
          ? `${rec.conceptName} (RxCUI ${rec.rxcui})`
          : `NDC ${ndc}`;
        tick();
        if (done >= candidates.length) resolveAllDone();
      });
  });

  await Promise.race([allDone, cancel.promise]);
  clearInterval(visualTimer);
  if (runId !== activeRunId) return;

  const wasCancelled = cancel.cancelled;
  const records = candidates.map((ndc, i) => ({ input: ndc, record: results[i] }));
  const completed = records.filter(r => r.record !== null).length;
  const matched   = records.filter(r => r.record && r.record.found).length;
  const missing   = completed - matched;
  const skipped   = records.length - completed;

  if (wasCancelled) {
    visualPct = Math.min(95, (done / candidates.length) * 100);
    progCard.update({
      status: `Stopped at ${done} of ${candidates.length}. Showing partial results below.`,
      eta: "", lastName: "", stopped: true, fillPct: visualPct,
    });
    progCard.finish({ stopped: true });
  } else {
    progCard.update({
      status: `Matched ${matched} of ${candidates.length} NDC${candidates.length === 1 ? "" : "s"} to RxCUIs${missing ? `, ${missing} not in RxNorm` : ""}${skipped ? `, ${skipped} skipped` : ""}.`,
      eta: "", lastName: "", fillPct: 100,
    });
    progCard.finish({ stopped: false });
  }

  renderResults(refs, records);
}

// ---------------- results render ----------------

function renderResults(refs, records) {
  refs.summarySlot.innerHTML = "";
  refs.tableSlot.innerHTML = "";

  const total   = records.length;
  const matched = records.filter(r => r.record && r.record.found).length;
  const missing = records.filter(r => r.record && !r.record.found).length;
  const skipped = records.filter(r => r.record === null).length;

  const section = document.createElement("section");
  section.className = "summary-bar";
  section.appendChild(el("p", { class: "summary-text" },
    `Looked up ${total} NDC${total === 1 ? "" : "s"}. ${matched} matched a RxCUI${missing ? `, ${missing} not in RxNorm` : ""}${skipped ? `, ${skipped} skipped` : ""}.`,
  ));
  const actions = el("div", { class: "action-row" });
  const csvBtn = el("button", {
    type: "button", class: "btn-primary",
    onclick: () => downloadCsv(
      `medcode-mode7-ndc-to-rxcui-${todayStamp()}.csv`,
      buildCsv(records),
    ),
  }, `⬇ Download CSV (${total} row${total === 1 ? "" : "s"})`);
  const resetBtn = el("button", {
    type: "button", class: "btn-secondary",
    onclick: () => reset(refs.panel),
  }, "Reset");
  actions.appendChild(csvBtn);
  actions.appendChild(resetBtn);
  section.appendChild(actions);
  refs.summarySlot.appendChild(section);

  if (records.length === 0) return;
  refs.tableSlot.appendChild(buildTable(records));
}

const COLUMNS = [
  { key: "input",         label: "NDC (input)" },
  { key: "rxcui",         label: "RxCUI" },
  { key: "conceptName",   label: "Drug" },
  { key: "ndcStatus",     label: "NDC status" },
  { key: "conceptStatus", label: "RxCUI status" },
  { key: "marketingWindow", label: "Marketing window" },
  { key: "ndc11",         label: "Canonical NDC-11" },
];

function buildTable(records) {
  const rows = records.map(r => {
    const rec = r.record || {};
    return {
      input: r.input,
      matched: !!(rec && rec.found),
      skipped: r.record === null,
      rxcui: rec.rxcui || "",
      conceptName: rec.conceptName || "",
      ndcStatus: rec.status || "",
      active: rec.active || "",
      conceptStatus: rec.conceptStatus || "",
      ndc11: rec.ndc11 || "",
      marketingWindow: formatMarketingWindow(rec.marketingStart, rec.marketingEnd),
    };
  });

  let sortKey = "input";
  let sortDir = "asc";

  const tableWrap = el("div", { class: "batch-table-wrap" });
  const table = el("table", { class: "ndc-table" });

  const thead = el("thead");
  const headerRow = el("tr");
  for (const col of COLUMNS) {
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
    const sorted = [...rows].sort((a, b) => compare(a, b, sortKey, sortDir));
    tbody.innerHTML = "";
    for (const r of sorted) {
      const tr = el("tr", { class: "ndc-row" + (r.matched ? "" : " is-missing") });
      for (const col of COLUMNS) {
        const td = el("td", { class: `cell-${col.key}` });
        const v = r[col.key] || "";
        if (col.key === "input" || col.key === "rxcui" || col.key === "ndc11") {
          if (v) td.appendChild(el("span", { class: "code" }, String(v)));
          else td.textContent = "–";
        } else if (!r.matched && col.key === "conceptName") {
          td.textContent = r.skipped ? "Skipped (network/cancel)" : "Not in RxNorm";
          td.classList.add("cell-empty");
        } else {
          td.textContent = v ? String(v) : "–";
          if (v && col.key === "conceptName") td.title = String(v);
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
  const card = el("section", { class: "card ndc-table-card", "aria-label": "NDC to RxCUI" });
  card.appendChild(tableWrap);
  return card;
}

function compare(a, b, key, dir) {
  const av = (a[key] || "").toString();
  const bv = (b[key] || "").toString();
  const cmp = /^\d/.test(av) && /^\d/.test(bv)
    ? av.localeCompare(bv, undefined, { numeric: true })
    : av.localeCompare(bv, undefined, { sensitivity: "base" });
  return dir === "asc" ? cmp : -cmp;
}

// RxNav returns dates as YYYYMM strings on ndcHistory entries. Display
// "YYYY-MM → YYYY-MM" (or "YYYY-MM → present" when there's no end).
function formatMarketingWindow(start, end) {
  if (!start) return "";
  const s = `${start.slice(0, 4)}-${start.slice(4, 6)}`;
  const e = end ? `${end.slice(0, 4)}-${end.slice(4, 6)}` : "present";
  return `${s} → ${e}`;
}

function buildCsv(records) {
  const rows = [[
    "ndc_input", "rxcui", "concept_name",
    "ndc11", "ndc_status", "active",
    "rxnorm_ndc", "concept_status", "alt_ndc",
    "marketing_start", "marketing_end",
    "source_list", "matched", "skipped",
  ]];
  for (const r of records) {
    const rec = r.record || {};
    const skipped = r.record === null;
    rows.push([
      r.input,
      rec.rxcui || "",
      rec.conceptName || "",
      rec.ndc11 || "",
      rec.status || "",
      rec.active || "",
      rec.rxnormNdc || "",
      rec.conceptStatus || "",
      rec.altNdc || "",
      rec.marketingStart || "",
      rec.marketingEnd || "",
      Array.isArray(rec.sourceList) ? rec.sourceList.join("|") : "",
      rec.found ? "true" : "false",
      skipped ? "true" : "false",
    ]);
  }
  return rows;
}

// ---------------- helpers ----------------

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
