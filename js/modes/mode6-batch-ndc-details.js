// modes/mode6-batch-ndc-details.js, Mode 6 UI logic.
// Batch NDC → FDA product details (brand name, generic name, labeler,
// dosage form, route, strength, marketing dates, packaging description).
// Same input/cap/progress/Stop shape as Mode 5 but calls the OpenFDA
// client instead of RxNav. Cap matches Mode 5 at 200 inputs.

import { getOpenFdaDetailsForNdcs } from "../openfda-client.js";
import {
  mode3ProgressCard,
  errorCard,
} from "../ui-components.js";
import { downloadCsv } from "../csv-export.js";

const MAX_BATCH = 200;
const EST_MS_PER_NDC = 80; // batched OR queries are fast; ~25 NDCs per request
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

// ---------------- refs / binding ----------------

function getRefs(panelEl) {
  return {
    panel:        panelEl,
    input:        panelEl.querySelector("#mode6-input"),
    counter:      panelEl.querySelector("#mode6-counter"),
    analyze:      panelEl.querySelector("#mode6-analyze"),
    uploadInput:  panelEl.querySelector("#mode6-upload"),
    uploadLink:   panelEl.querySelector("#mode6-upload-link"),
    warningSlot:  panelEl.querySelector("#mode6-input-warning"),
    progressSlot: panelEl.querySelector("#mode6-progress"),
    summarySlot:  panelEl.querySelector("#mode6-summary"),
    tableSlot:    panelEl.querySelector("#mode6-table"),
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
  // Inputs can be hyphenated NDCs or pure digits. Split on whitespace and
  // commas/semicolons only, so dashed forms stay intact.
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
  // Allow hyphens; the digit count after stripping should be 10 or 11.
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
    title: `Fetching FDA details for ${candidates.length} NDC${candidates.length === 1 ? "" : "s"}`,
    status: "Querying OpenFDA…",
  });
  progCard.setOnStop(() => cancel.fire());
  refs.progressSlot.appendChild(progCard.el);
  progCard.update({
    phase: "verifying",
    current: 0, total: candidates.length,
    eta: "Estimating…", lastName: "",
  });

  const startTs = Date.now();
  let done = 0;
  let visualPct = 0;

  const recomputeTarget = () => {
    const total = candidates.length;
    const elapsed = Date.now() - startTs;
    const perItem = EST_MS_PER_NDC;
    const timePct = Math.min(95, (elapsed / (perItem * total)) * 100);
    const realPct = (done / total) * 100;
    return Math.max(visualPct, realPct, timePct);
  };

  const tick = (extra = {}) => {
    if (runId !== activeRunId) return;
    const total = candidates.length;
    let eta = "";
    if (done >= total) {
      eta = `Done in ${formatDuration(Date.now() - startTs)}`;
      visualPct = 100;
    } else if (done > 0) {
      const elapsed = Date.now() - startTs;
      const perItem = elapsed / done;
      eta = `About ${formatDuration(perItem * (total - done))} remaining`;
    } else {
      eta = "Fetching…";
    }
    progCard.update({ current: done, total, fillPct: visualPct, eta, lastName: extra.lastName || "" });
  };

  const visualTimer = setInterval(() => {
    if (runId !== activeRunId || cancel.cancelled || done >= candidates.length) return;
    visualPct = Math.max(visualPct, visualPct + (recomputeTarget() - visualPct) * 0.25);
    tick();
  }, 100);

  tick();

  // The OpenFDA client batches internally; emit per-batch progress.
  const resultsPromise = getOpenFdaDetailsForNdcs(candidates, {
    cancel,
    onBatchDone: ({ done: d, total }) => {
      if (runId !== activeRunId) return;
      done = d;
      tick();
    },
  });

  let resultMap;
  try {
    resultMap = await Promise.race([
      resultsPromise,
      cancel.promise.then(() => null),
    ]);
  } catch {
    resultMap = null;
  }
  clearInterval(visualTimer);
  if (runId !== activeRunId) return;

  const wasCancelled = cancel.cancelled;
  const records = candidates.map(ndc => ({
    input: ndc,
    record: (resultMap && resultMap.get(ndc)) || null,
  }));
  const matched = records.filter(r => r.record).length;
  const missing = records.length - matched;

  if (wasCancelled) {
    visualPct = Math.min(95, (done / candidates.length) * 100);
    progCard.update({
      status: `Stopped at ${done} of ${candidates.length}. Showing partial results below.`,
      eta: "", lastName: "", stopped: true, fillPct: visualPct,
    });
    progCard.finish({ stopped: true });
  } else {
    progCard.update({
      status: `Matched ${matched} of ${candidates.length} NDC${candidates.length === 1 ? "" : "s"} in OpenFDA${missing ? `, ${missing} not found` : ""}.`,
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

  const matched = records.filter(r => r.record);
  const missing = records.filter(r => !r.record);

  // Summary + CSV button.
  const section = document.createElement("section");
  section.className = "summary-bar";
  section.appendChild(el("p", { class: "summary-text" },
    `Looked up ${records.length} NDC${records.length === 1 ? "" : "s"}. ${matched.length} matched in OpenFDA${missing.length ? `, ${missing.length} not found` : ""}.`,
  ));
  const actions = el("div", { class: "action-row" });
  const csvBtn = el("button", {
    type: "button", class: "btn-primary",
    onclick: () => downloadCsv(
      `medcode-mode6-ndc-details-${todayStamp()}.csv`,
      buildCsv(records),
    ),
  }, `⬇ Download CSV (${records.length} row${records.length === 1 ? "" : "s"})`);
  const resetBtn = el("button", {
    type: "button", class: "btn-secondary",
    onclick: () => reset(refs.panel),
  }, "Reset");
  actions.appendChild(csvBtn);
  actions.appendChild(resetBtn);
  section.appendChild(actions);
  refs.summarySlot.appendChild(section);

  // Flat table.
  if (records.length === 0) {
    refs.tableSlot.appendChild(errorCard({
      title: "No NDCs to show",
      body: "Every input failed validation.",
      variant: "info",
    }));
    return;
  }
  refs.tableSlot.appendChild(buildNdcDetailsTable(records));
}

const COLUMNS = [
  { key: "input",              label: "NDC" },
  { key: "brandName",          label: "Brand name" },
  { key: "genericName",        label: "Generic name" },
  { key: "labelerName",        label: "Labeler" },
  { key: "dosageForm",         label: "Dosage form" },
  { key: "route",              label: "Route" },
  { key: "strength",           label: "Strength" },
  { key: "marketingCategory",  label: "Marketing category" },
  { key: "firstMarketedYear",  label: "First marketed" },
  { key: "packagingDescription", label: "Packaging" },
];

function buildNdcDetailsTable(records) {
  // Decorate each row with the input NDC + the year for first marketed.
  const rows = records.map(r => {
    const rec = r.record || {};
    return {
      input: r.input,
      matched: !!r.record,
      brandName: rec.brandName || "",
      genericName: rec.genericName || "",
      labelerName: rec.labelerName || "",
      dosageForm: rec.dosageForm || "",
      route: rec.route || "",
      strength: rec.strength || "",
      marketingCategory: rec.marketingCategory || "",
      firstMarketedYear: yearFromYyyymmdd(rec.marketingStartDate),
      packagingDescription: rec.packagingDescription || "",
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
        if (col.key === "input") {
          td.appendChild(el("span", { class: "code" }, String(v)));
        } else if (!r.matched && col.key === "brandName") {
          td.textContent = "Not in OpenFDA";
          td.classList.add("cell-empty");
        } else {
          td.textContent = v ? String(v) : "–";
          if (v && (col.key === "brandName" || col.key === "genericName" || col.key === "labelerName" || col.key === "packagingDescription")) {
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
  const card = el("section", { class: "card ndc-table-card", "aria-label": "NDC details" });
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

function buildCsv(records) {
  const rows = [[
    "ndc_input", "matched",
    "brand_name", "generic_name",
    "labeler_name",
    "dosage_form", "route",
    "strength", "active_ingredients",
    "marketing_category", "marketing_status",
    "marketing_start_date", "marketing_end_date", "first_marketed_year",
    "product_type", "product_ndc",
    "packaging_description",
    "spl_set_id", "fda_application_number",
  ]];
  for (const r of records) {
    const rec = r.record || {};
    rows.push([
      r.input, r.record ? "true" : "false",
      rec.brandName || "", rec.genericName || "",
      rec.labelerName || "",
      rec.dosageForm || "", rec.route || "",
      rec.strength || "", rec.activeIngredients || "",
      rec.marketingCategory || "", rec.marketingStatus || "",
      rec.marketingStartDate || "", rec.marketingEndDate || "", yearFromYyyymmdd(rec.marketingStartDate),
      rec.productType || "", rec.productNdc || "",
      rec.packagingDescription || "",
      rec.splSetId || "", rec.fdaApprovalNumber || "",
    ]);
  }
  return rows;
}

function yearFromYyyymmdd(s) {
  if (!s) return "";
  const m = /^(\d{4})/.exec(String(s));
  return m ? m[1] : "";
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
