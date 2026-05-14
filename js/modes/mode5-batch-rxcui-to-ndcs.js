// modes/mode5-batch-rxcui-to-ndcs.js, Mode 5 UI logic.
// Batch RXCUI → active NDCs for up to 20 RXCUIs at a time. Hard cap is
// intentionally tighter than Mode 2's (200) because each RXCUI can produce
// hundreds of NDCs in the exploded CSV, 20 × ~300 avg ≈ 6,000 rows; 200
// would balloon to 60k+.
//
// Reuses Mode 2's parser shape (textarea + dedupe + counter) and Mode 4's
// sortable NDC table (via buildNdcTable export) for row-expand detail.

import { detectCodeType } from "../code-detection.js";
import {
  getProperties,
  getNdcPropertiesForRxcui,
} from "../rxnav-client.js";
import {
  statusBadge,
  progressBar,
  updateProgressBar,
  batchSummaryBar,
  errorCard,
  educationalBanner,
  statusInfoIcon,
} from "../ui-components.js";
import {
  isProductTty,
  explainNoNdcsForNonProduct,
  explainNoNdcsForProduct,
  noNdcsTooltipForNonProduct,
  noNdcsTooltipForProduct,
} from "../explanations.js";
import { buildNdcTable } from "./mode4-rxcui-to-ndcs.js";
import { downloadCsv } from "../csv-export.js";

const MAX_BATCH = 20;

const STATUSES = ["OK", "NO_NDCS", "NEEDS_REVIEW"];
const STATUS_CHIP_LABEL = {
  OK:           "OK",
  NO_NDCS:      "No NDCs",
  NEEDS_REVIEW: "Needs review",
};

const STATUS_INFO = {
  OK: {
    dot: "success",
    name: "OK",
    short: "Valid RXCUI with active NDCs",
    long: "This RXCUI returned at least one active NDC from RxNorm. Active NDCs are those present in the current RxNorm release.",
  },
  NO_NDCS: {
    dot: "accent",
    name: "No NDCs",
    short: "RXCUI exists but no active NDCs",
    long: "This RXCUI exists in RxNorm but has no active NDCs. Two distinct reasons, see the banner below.",
  },
  NEEDS_REVIEW: {
    dot: "warning",
    name: "Needs review",
    short: "Couldn't be processed automatically",
    long: "This RXCUI couldn't be processed automatically. Check the row for the specific reason (RXCUI not found, network error, or invalid input format).",
  },
};

// Sub-categories of NO_NDCS, distinct reasons surfaced in the banner,
// tooltips, and row-expand info card, but lumped under one filter chip.
const NO_NDCS_INFO = {
  NON_PRODUCT: {
    name: "No NDCs · non-product TTY",
    short: "Ingredients or brand-name concepts (TTY=IN/PIN/MIN/BN/DF/…). RxNorm only assigns NDCs to specific products, look up an SCD or SBD instead.",
  },
  PRODUCT: {
    name: "No NDCs · product, none active",
    short: "SCD/SBD/BPCK/GPCK that exists in RxNorm but has no active NDCs in the current release (retired, unmarketed in US, or not yet indexed).",
  },
};

function buildMode5Banner({ showDismiss = true, ignoreDismissed = false, counts = null } = {}) {
  const fmt = (key) => counts ? `, ${counts[key] || 0} row${(counts[key] || 0) === 1 ? "" : "s"}` : "";
  const items = [
    { dot: STATUS_INFO.OK.dot,           name: STATUS_INFO.OK.name + fmt("OK"),                           desc: STATUS_INFO.OK.short },
    { dot: STATUS_INFO.NO_NDCS.dot,      name: NO_NDCS_INFO.NON_PRODUCT.name + fmt("NO_NDCS_NON_PRODUCT"), desc: NO_NDCS_INFO.NON_PRODUCT.short },
    { dot: STATUS_INFO.NO_NDCS.dot,      name: NO_NDCS_INFO.PRODUCT.name + fmt("NO_NDCS_PRODUCT"),         desc: NO_NDCS_INFO.PRODUCT.short },
    { dot: STATUS_INFO.NEEDS_REVIEW.dot, name: STATUS_INFO.NEEDS_REVIEW.name + fmt("NEEDS_REVIEW"),       desc: STATUS_INFO.NEEDS_REVIEW.short },
  ];
  return educationalBanner({
    storageKey: "medcode_mode5_status_banner_dismissed",
    title: "NDC lookup results",
    items,
    footnote: "Click any row to see all NDC details.",
    showDismiss,
    ignoreDismissed,
  });
}

function buildMode5RowTooltip(record) {
  const s = record.status;
  if (!s || s === "PENDING") return "";
  if (s === "OK") {
    return `Returned ${record.ndcCount || 0} active NDC${(record.ndcCount || 0) === 1 ? "" : "s"} for ${record.name || "this RXCUI"} (TTY=${record.tty || "?"}).`;
  }
  if (s === "NO_NDCS") {
    return record.subStatus === "NO_NDCS_PRODUCT"
      ? noNdcsTooltipForProduct(record.tty || "?")
      : noNdcsTooltipForNonProduct(record.tty || "?");
  }
  return record.reason || STATUS_INFO.NEEDS_REVIEW.long;
}

let activeRunId = 0;

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
  refs.analyze.disabled = n === 0 || n > MAX_BATCH;

  refs.warningSlot.innerHTML = "";
  if (n > MAX_BATCH) {
    refs.warningSlot.appendChild(errorCard({
      title: `Over the ${MAX_BATCH}-RXCUI cap`,
      body: `Mode 5 caps at ${MAX_BATCH} RXCUIs per batch, each can produce hundreds of NDC rows. You have ${n}.`,
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
}

// ---------------- batch run ----------------

async function runBatch(refs) {
  const { ordered, duplicates } = parseTokens(refs.input.value);
  if (ordered.length === 0 || ordered.length > MAX_BATCH) return;

  activeRunId++;
  const runId = activeRunId;

  refs.summarySlot.innerHTML = "";
  refs.filtersSlot.innerHTML = "";
  refs.tableSlot.innerHTML = "";

  refs.progressSlot.innerHTML = "";
  const progEl = progressBar({ done: 0, total: ordered.length, eta: "Estimating…" });
  refs.progressSlot.appendChild(progEl);

  // Pre-build table shell + pending rows
  const { table, tbody } = buildTableShell();
  refs.tableSlot.appendChild(table);

  const records = new Map();
  const rowApis = new Map();
  for (const rxcui of ordered) {
    const rowApi = makePendingRow({ rxcui, isDuplicate: duplicates.has(rxcui) });
    tbody.appendChild(rowApi.tr);
    tbody.appendChild(rowApi.detailRow);
    rowApis.set(rxcui, rowApi);
    records.set(rxcui, {
      rxcui, status: "PENDING", subStatus: null,
      tty: "", name: "", entries: [], reason: "",
      duplicate: duplicates.has(rxcui),
    });
  }

  const startTs = Date.now();
  let done = 0;
  const tick = () => {
    if (runId !== activeRunId) return;
    const elapsed = Date.now() - startTs;
    const avg = done > 0 ? elapsed / done : 0;
    const remaining = avg * (ordered.length - done);
    const eta = done === 0 ? "Estimating…"
              : done >= ordered.length ? `Done in ${formatDuration(elapsed)}`
              : `~${formatDuration(remaining)} remaining`;
    updateProgressBar(progEl, { done, total: ordered.length, eta });
  };
  tick();

  const tasks = ordered.map(rxcui => processOne({
    rxcui,
    rowApi: rowApis.get(rxcui),
    record: records.get(rxcui),
    isStillActive: () => runId === activeRunId,
  }).then(() => {
    if (runId !== activeRunId) return;
    done++; tick();
  }).catch(() => {
    if (runId !== activeRunId) return;
    done++; tick();
  }));

  await Promise.all(tasks);
  if (runId !== activeRunId) return;

  // Wire row-expand (lazy NDC table render)
  for (const [rxcui, rowApi] of rowApis) {
    const rec = records.get(rxcui);
    if (rec.status === "NEEDS_REVIEW" && rec.entries.length === 0) continue;
    rowApi.setOnExpand((container) => {
      if (rec.entries.length === 0) {
        const body = rec.subStatus === "NO_NDCS_PRODUCT"
          ? explainNoNdcsForProduct(rec.name, rec.tty)
          : explainNoNdcsForNonProduct(rec.name, rec.tty);
        const actions = [];
        if (rec.subStatus === "NO_NDCS_NON_PRODUCT" && rec.name) {
          const q = encodeURIComponent(rec.name);
          actions.push({
            label: `Search RxNav for products of ${rec.name}`,
            primary: false,
            onClick: () => window.open(`https://mor.nlm.nih.gov/RxNav/search?searchBy=String&searchTerm=${q}`, "_blank", "noopener"),
          });
        }
        container.appendChild(errorCard({
          title: `No active NDCs for ${rec.name || rxcui}`,
          body,
          actions,
          variant: "info",
        }));
        return;
      }
      container.appendChild(buildNdcTable(rec.entries));
    });
  }

  renderSummary(refs, ordered.length, records);
  renderFilterChips(refs, table, records);
}

async function processOne({ rxcui, rowApi, record, isStillActive }) {
  if (!isLikelyRxcui(rxcui)) {
    record.status = "NEEDS_REVIEW";
    record.reason = "Token doesn't look like an RXCUI";
    rowApi.update({ status: "NEEDS_REVIEW", name: record.reason, tty: "", ndcCount: "–", tooltip: record.reason });
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
    rowApi.update({ status: "NEEDS_REVIEW", name: "Network error", tty: "", ndcCount: "–", tooltip: record.reason || "Network error reaching RxNav" });
    return;
  }
  if (!isStillActive()) return;

  if (!props || !props.found) {
    record.status = "NEEDS_REVIEW";
    record.reason = `RXCUI ${rxcui} not found in RxNav`;
    rowApi.update({ status: "NEEDS_REVIEW", name: "Not in RxNav", tty: "", ndcCount: "–", tooltip: record.reason });
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
      record.reason = `Non-product TTY (${props.tty}), RxNorm assigns NDCs only to SCD/SBD/BPCK/GPCK`;
    }
  } else {
    record.status = "OK";
  }

  rowApi.update({
    status: record.status,
    name: record.name,
    tty: record.tty,
    ndcCount: entries.length,
    tooltip: buildMode5RowTooltip({ ...record, ndcCount: entries.length }),
  });
}

// ---------------- table shell + row builders ----------------

function buildTableShell() {
  const table = document.createElement("table");
  table.className = "batch-table";
  const thead = document.createElement("thead");
  thead.innerHTML = `
    <tr>
      <th scope="col">Status</th>
      <th scope="col">RXCUI</th>
      <th scope="col">TTY</th>
      <th scope="col">Drug</th>
      <th scope="col">Active NDCs</th>
      <th scope="col" aria-label="Expand"></th>
    </tr>`;
  const tbody = document.createElement("tbody");
  table.appendChild(thead);
  table.appendChild(tbody);
  return { table, tbody };
}

function makePendingRow({ rxcui, isDuplicate }) {
  const statusCell = el("td", { class: "cell-status" }, statusBadge("PENDING"));
  const rxcuiCell = el("td", { class: "cell-rxcui" }, [
    el("span", { class: "code" }, rxcui),
    isDuplicate ? el("span", { class: "dup-tag" }, "dup") : null,
  ]);
  const ttyCell = el("td", { class: "cell-tty" }, "…");
  const nameCell = el("td", { class: "cell-name" }, "…");
  const ndcCell = el("td", { class: "cell-ndcs" }, "…");

  const chevron = el("button", {
    type: "button",
    class: "row-toggle",
    "aria-label": "Expand details",
    "aria-expanded": "false",
    disabled: true,
  }, "▶");
  const togCell = el("td", { class: "cell-toggle" }, chevron);

  const tr = el("tr", {
    class: "batch-row",
    "data-status": "PENDING",
    "data-rxcui": rxcui,
  }, [statusCell, rxcuiCell, ttyCell, nameCell, ndcCell, togCell]);

  const detailInner = el("div", { class: "row-detail-inner" });
  const detailRow = el("tr", { class: "batch-row-detail", hidden: true },
    [el("td", { colspan: "6" }, detailInner)],
  );

  let isOpen = false;
  let rendered = false;
  let onExpand = null;

  chevron.addEventListener("click", () => {
    isOpen = !isOpen;
    chevron.textContent = isOpen ? "▼" : "▶";
    chevron.setAttribute("aria-expanded", isOpen ? "true" : "false");
    if (isOpen) detailRow.removeAttribute("hidden");
    else detailRow.setAttribute("hidden", "");
    if (isOpen && !rendered && onExpand) {
      rendered = true;
      onExpand(detailInner);
    }
  });

  function update({ status, name, tty, ndcCount, tooltip }) {
    statusCell.innerHTML = "";
    const badge = statusBadge(status, tooltip || "");
    if (tooltip) badge.setAttribute("data-tooltip-align", "start");
    statusCell.appendChild(badge);
    tr.dataset.status = status;
    nameCell.textContent = name || "–";
    nameCell.title = name || "";
    ttyCell.textContent = tty || "–";
    ndcCell.textContent = ndcCount == null ? "–" : String(ndcCount);
    const hasDetail = status === "OK" || (status === "NO_NDCS" && !!name);
    chevron.disabled = !hasDetail;
  }
  function setOnExpand(fn) { onExpand = fn; }

  return { tr, detailRow, update, setOnExpand };
}

// tiny local DOM helper (mode files don't use a shared one yet)
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    if (typeof c === "string") node.appendChild(document.createTextNode(c));
    else node.appendChild(c);
  }
  return node;
}

// ---------------- filter chips ----------------

function renderFilterChips(refs, table, records) {
  refs.filtersSlot.innerHTML = "";

  const counts = { ALL: 0, OK: 0, NO_NDCS: 0, NEEDS_REVIEW: 0, NO_NDCS_PRODUCT: 0, NO_NDCS_NON_PRODUCT: 0 };
  for (const rec of records.values()) {
    counts.ALL++;
    if (counts[rec.status] != null) counts[rec.status]++;
    if (rec.status === "NO_NDCS" && rec.subStatus && counts[rec.subStatus] != null) {
      counts[rec.subStatus]++;
    }
  }

  // Layer 1 banner, pass sub-counts so the two NO_NDCS sub-rows are quantified.
  const banner = buildMode5Banner({ counts });
  if (banner) refs.filtersSlot.appendChild(banner);
  const chipBar = document.createElement("div");
  chipBar.className = "filter-chips";
  chipBar.dataset.filter = "ALL";
  const chips = [
    { key: "ALL", label: "All", tooltip: "" },
    ...STATUSES.map(s => ({
      key: s,
      label: STATUS_CHIP_LABEL[s],
      tooltip: STATUS_INFO[s].long,
    })),
  ];
  for (const c of chips) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "filter-chip" + (c.key === "ALL" ? " is-active" : "");
    btn.dataset.key = c.key;
    btn.setAttribute("aria-pressed", c.key === "ALL" ? "true" : "false");
    btn.setAttribute("data-tooltip-pos", "bottom");
    if (c.tooltip) {
      btn.setAttribute("data-tooltip", c.tooltip);
      btn.setAttribute("aria-label", `${c.label} (${counts[c.key] || 0}), ${c.tooltip}`);
    }
    btn.innerHTML = `${c.label} <span class="filter-chip-count">${counts[c.key] || 0}</span>`;
    btn.addEventListener("click", () => applyFilter(table, chipBar, c.key));
    chipBar.appendChild(btn);
  }
  refs.filtersSlot.appendChild(chipBar);

  // Header info icon next to the Status column header
  const statusTh = refs.tableSlot.querySelector(".batch-table thead th:first-child");
  if (statusTh && !statusTh.querySelector(".col-info-btn")) {
    const { iconBtn } = statusInfoIcon({
      buildBanner: () => buildMode5Banner({ showDismiss: false, ignoreDismissed: true, counts }),
    });
    statusTh.appendChild(iconBtn);
  }
}

function applyFilter(table, chipBar, key) {
  chipBar.dataset.filter = key;
  for (const b of chipBar.querySelectorAll(".filter-chip")) {
    const active = b.dataset.key === key;
    b.classList.toggle("is-active", active);
    b.setAttribute("aria-pressed", active ? "true" : "false");
  }
  for (const tr of table.querySelectorAll("tr.batch-row")) {
    const visible = key === "ALL" || tr.dataset.status === key;
    tr.hidden = !visible;
    const detail = tr.nextElementSibling;
    if (detail && detail.classList.contains("batch-row-detail")) {
      if (!visible) detail.hidden = true;
    }
  }
}

// ---------------- summary + downloads ----------------

function renderSummary(refs, total, records) {
  refs.summarySlot.innerHTML = "";

  let ok = 0, noNdcs = 0, noNdcsProduct = 0, noNdcsNonProduct = 0, review = 0, totalNdcs = 0;
  for (const rec of records.values()) {
    if (rec.status === "OK") { ok++; totalNdcs += rec.entries.length; }
    else if (rec.status === "NO_NDCS") {
      noNdcs++;
      if (rec.subStatus === "NO_NDCS_PRODUCT") noNdcsProduct++;
      else noNdcsNonProduct++;
    }
    else review++;
  }
  const noNdcsBreakdown = noNdcs > 0
    ? ` (${noNdcsNonProduct} non-product TTY, ${noNdcsProduct} product without active NDCs)`
    : "";
  const summary = `Analyzed ${total} RXCUI${total === 1 ? "" : "s"}. ${totalNdcs} total active NDC${totalNdcs === 1 ? "" : "s"} across ${ok} with NDCs. ${noNdcs} had no NDCs${noNdcsBreakdown}. ${review} need${review === 1 ? "s" : ""} review.`;

  const section = document.createElement("section");
  section.className = "summary-bar";
  const p = document.createElement("p");
  p.className = "summary-text";
  p.textContent = summary;
  section.appendChild(p);

  const stamp = todayStamp();

  const row = document.createElement("div");
  row.className = "action-row";

  const compactBtn = document.createElement("button");
  compactBtn.type = "button";
  compactBtn.className = "btn-primary";
  compactBtn.textContent = "⬇ Download CSV (compact)";
  compactBtn.addEventListener("click", () => {
    const rows = buildCompactCsv(records);
    downloadCsv(`medcode-mode5-batch-ndc-summary-${stamp}.csv`, rows);
  });

  const explodedBtn = document.createElement("button");
  explodedBtn.type = "button";
  explodedBtn.className = "btn-secondary";
  explodedBtn.textContent = `⬇ Download CSV (with NDC codes, ${totalNdcs} rows)`;
  explodedBtn.addEventListener("click", () => {
    const rows = buildExplodedCsv(records);
    downloadCsv(`medcode-mode5-batch-ndc-exploded-${stamp}.csv`, rows);
  });

  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "btn-secondary";
  resetBtn.textContent = "Reset";
  resetBtn.addEventListener("click", () => reset(refs.panel));

  row.appendChild(compactBtn);
  row.appendChild(explodedBtn);
  row.appendChild(resetBtn);
  section.appendChild(row);

  refs.summarySlot.appendChild(section);
}

// ---------------- CSV builders ----------------

function buildCompactCsv(records) {
  const rows = [["rxcui", "tty", "drug_name", "active_ndc_count", "status"]];
  for (const rec of records.values()) {
    rows.push([
      rec.rxcui,
      rec.tty || "",
      rec.name || "",
      String((rec.entries || []).length),
      rec.status,
    ]);
  }
  return rows;
}

function buildExplodedCsv(records) {
  const rows = [["rxcui", "tty", "drug_name", "ndc_code", "ndc_10", "labeler", "packaging", "marketing_category", "fda_approval_number"]];
  for (const rec of records.values()) {
    if (rec.status !== "OK") continue;
    for (const e of rec.entries) {
      rows.push([
        rec.rxcui,
        rec.tty || "",
        rec.name || "",
        e.ndc11 || "",
        e.ndc10 || "",
        e.labeler || "",
        e.packaging || "",
        e.marketingCategory || "",
        e.fdaApprovalNumber || "",
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
