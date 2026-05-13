// modes/mode4-rxcui-to-ndcs.js — Mode 4 UI logic.
// Single RXCUI → active NDC table with rich metadata (labeler, packaging,
// marketing category, FDA approval number, etc.). Sortable columns.
//
// Reuses Mode 1's drugIdentityCard for the header. The NDC table is
// Mode-4-specific (different column set + sort affordance).

import { detectCodeType } from "../code-detection.js";
import {
  getProperties,
  getNdcPropertiesForRxcui,
} from "../rxnav-client.js";
import {
  drugIdentityCard,
  errorCard,
  skeletonCard,
} from "../ui-components.js";
import {
  isProductTty,
  explainNoNdcsForNonProduct,
  explainNoNdcsForProduct,
} from "../explanations.js";
import { downloadCsv } from "../csv-export.js";

let activeRunId = 0;

// ---------------- public ----------------

export function init(panelEl) {
  const refs = getRefs(panelEl);
  if (!refs.input) return;
  bindInput(refs);
  bindExamples(refs);
}

export function reset(panelEl) {
  const refs = getRefs(panelEl);
  if (!refs.input) return;
  activeRunId++;
  refs.input.value = "";
  refs.result.innerHTML = "";
  writeUrl("");
}

export async function submitFromUrl(panelEl, rxcui) {
  const refs = getRefs(panelEl);
  if (!refs.input) return;
  refs.input.value = rxcui;
  await runSubmit(refs, rxcui);
}

// ---------------- refs / binding ----------------

function getRefs(panelEl) {
  return {
    panel:  panelEl,
    input:  panelEl.querySelector("#mode4-input"),
    submit: panelEl.querySelector("#mode4-submit"),
    result: panelEl.querySelector("#mode4-result"),
  };
}

function bindInput(refs) {
  refs.submit.addEventListener("click", () => runSubmit(refs, refs.input.value));
  refs.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); runSubmit(refs, refs.input.value); }
    else if (e.key === "Escape") { e.preventDefault(); reset(refs.panel); }
  });
}

function bindExamples(refs) {
  refs.panel.querySelectorAll(".examples-chips .chip[data-rxcui]").forEach((chip) => {
    chip.addEventListener("click", () => {
      const rx = chip.dataset.rxcui;
      refs.input.value = rx;
      runSubmit(refs, rx);
    });
  });
}

// ---------------- main ----------------

async function runSubmit(refs, raw) {
  activeRunId++;
  const runId = activeRunId;
  refs.result.innerHTML = "";

  const trimmed = (raw || "").trim();
  writeUrl(trimmed);

  if (!trimmed) {
    refs.result.appendChild(errorCard({
      title: "Enter an RXCUI",
      body: "Type or paste an RxNorm Concept Unique Identifier (RXCUI).",
      variant: "info",
    }));
    return;
  }

  const detected = detectCodeType(trimmed);
  if (detected.type !== "RXCUI") {
    refs.result.appendChild(errorCard({
      title: `"${trimmed}" doesn't look like an RXCUI`,
      body: "RXCUIs are numeric (e.g., 259255). Mode 4 takes a single RXCUI and returns the active NDCs RxNav has on file.",
      variant: "warning",
    }));
    return;
  }

  refs.result.appendChild(skeletonCard());
  refs.result.appendChild(skeletonCard());

  let props, entries;
  try {
    [props, entries] = await Promise.all([
      getProperties(trimmed),
      getNdcPropertiesForRxcui(trimmed),
    ]);
  } catch {
    if (runId !== activeRunId) return;
    refs.result.innerHTML = "";
    refs.result.appendChild(errorCard({
      title: "Couldn't reach RxNav",
      body: "The NIH API isn't responding. Check your connection and try again.",
      actions: [{ label: "Retry", primary: true, onClick: () => runSubmit(refs, trimmed) }],
      variant: "error",
    }));
    return;
  }
  if (runId !== activeRunId) return;
  refs.result.innerHTML = "";

  if (!props.found) {
    refs.result.appendChild(errorCard({
      title: `RXCUI ${trimmed} not found`,
      body: "RxNav doesn't have this concept. Verify the number on RxNav, or look it up by drug name.",
      actions: [
        { label: "Verify on RxNav", primary: false, onClick: () => window.open(`https://mor.nlm.nih.gov/RxNav/search?searchBy=RXCUI&searchTerm=${trimmed}`, "_blank", "noopener") },
      ],
      variant: "error",
    }));
    return;
  }

  refs.result.appendChild(drugIdentityCard({
    rxcui: props.rxcui,
    name: props.name,
    tty: props.tty,
  }));

  if (entries.length === 0) {
    const productTty = isProductTty(props.tty);
    const body = productTty
      ? explainNoNdcsForProduct(props.name, props.tty)
      : explainNoNdcsForNonProduct(props.name, props.tty);
    const actions = [];
    if (!productTty && props.name) {
      const q = encodeURIComponent(props.name);
      actions.push({
        label: `Search RxNav for products of ${props.name}`,
        primary: false,
        onClick: () => window.open(`https://mor.nlm.nih.gov/RxNav/search?searchBy=String&searchTerm=${q}`, "_blank", "noopener"),
      });
    }
    refs.result.appendChild(errorCard({
      title: `No active NDCs for ${props.name || `RXCUI ${trimmed}`}`,
      body,
      actions,
      variant: "info",
    }));
    return;
  }

  // Summary card: total count
  refs.result.appendChild(buildNdcSummaryCard(entries.length));

  // Sortable NDC table
  refs.result.appendChild(buildNdcTable(entries));

  // CSV download
  refs.result.appendChild(buildDownloadRow({ rxcui: trimmed, props, entries }));
}

// ---------------- summary card ----------------

function buildNdcSummaryCard(count) {
  const section = document.createElement("section");
  section.className = "card";
  section.setAttribute("aria-label", "NDC summary");
  const title = document.createElement("p");
  title.className = "card-title";
  title.textContent = "Active NDCs";
  const num = document.createElement("h2");
  num.className = "ndc-summary-count";
  num.textContent = String(count);
  section.appendChild(title);
  section.appendChild(num);
  return section;
}

// ---------------- sortable table ----------------

const COLUMNS = [
  { key: "ndc11",             label: "NDC (11-digit)" },
  { key: "ndc10",             label: "NDC-10" },
  { key: "labeler",           label: "Labeler" },
  { key: "packaging",         label: "Packaging" },
  { key: "marketingCategory", label: "Marketing category" },
];

export function buildNdcTable(entries) {
  const wrap = document.createElement("section");
  wrap.className = "card ndc-table-card";
  wrap.setAttribute("aria-label", "NDC table");

  // Local state — current sort key + direction
  let sortKey = "labeler";
  let sortDir = "asc";

  const tableWrap = document.createElement("div");
  tableWrap.className = "batch-table-wrap";
  const table = document.createElement("table");
  table.className = "ndc-table";

  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  for (const col of COLUMNS) {
    const th = document.createElement("th");
    th.scope = "col";
    th.className = "sortable-th";
    th.dataset.key = col.key;
    const inner = document.createElement("button");
    inner.type = "button";
    inner.className = "th-sort-btn";
    inner.innerHTML = `${col.label} <span class="sort-indicator" aria-hidden="true"></span>`;
    inner.addEventListener("click", () => {
      if (sortKey === col.key) {
        sortDir = sortDir === "asc" ? "desc" : "asc";
      } else {
        sortKey = col.key;
        sortDir = "asc";
      }
      sortAndRender();
    });
    th.appendChild(inner);
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  table.appendChild(tbody);

  function sortAndRender() {
    const sorted = [...entries].sort((a, b) => compareEntries(a, b, sortKey, sortDir));
    tbody.innerHTML = "";
    for (const e of sorted) {
      const tr = document.createElement("tr");
      tr.className = "ndc-row";
      for (const col of COLUMNS) {
        const td = document.createElement("td");
        td.className = `cell-${col.key}`;
        const v = e[col.key] || "";
        if (col.key === "ndc11" || col.key === "ndc10") {
          const span = document.createElement("span");
          span.className = "code";
          span.textContent = v;
          td.appendChild(span);
        } else {
          td.textContent = v;
          if (col.key === "packaging" || col.key === "labeler") td.title = v;
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    // Refresh sort indicators
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
  wrap.appendChild(tableWrap);
  return wrap;
}

function compareEntries(a, b, key, dir) {
  const av = (a[key] || "").toString();
  const bv = (b[key] || "").toString();
  // Numeric-ish sort for NDC codes; alpha otherwise.
  const cmp = /^\d/.test(av) && /^\d/.test(bv)
    ? av.localeCompare(bv, undefined, { numeric: true })
    : av.localeCompare(bv, undefined, { sensitivity: "base" });
  return dir === "asc" ? cmp : -cmp;
}

// ---------------- CSV ----------------

function buildDownloadRow({ rxcui, props, entries }) {
  const section = document.createElement("section");
  section.className = "card";
  section.setAttribute("aria-label", "Actions");
  const row = document.createElement("div");
  row.className = "action-row";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn-primary";
  btn.textContent = `⬇ Download CSV (${entries.length} NDCs)`;
  btn.addEventListener("click", () => {
    const rows = buildNdcCsv({ rxcui, props, entries });
    const stamp = todayStamp();
    downloadCsv(`medcode-mode4-rxcui-${rxcui}-ndc-${stamp}.csv`, rows);
  });
  row.appendChild(btn);
  section.appendChild(row);
  return section;
}

function buildNdcCsv({ rxcui, props, entries }) {
  const rows = [["rxcui", "tty", "drug_name", "ndc_code", "ndc_10", "labeler", "packaging", "marketing_category", "fda_approval_number"]];
  for (const e of entries) {
    rows.push([
      rxcui,
      props.tty || "",
      props.name || "",
      e.ndc11 || "",
      e.ndc10 || "",
      e.labeler || "",
      e.packaging || "",
      e.marketingCategory || "",
      e.fdaApprovalNumber || "",
    ]);
  }
  return rows;
}

// ---------------- helpers ----------------

function writeUrl(rxcui) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.set("mode", "4");
  if (rxcui) url.searchParams.set("rxcui", rxcui);
  else url.searchParams.delete("rxcui");
  window.history.pushState({}, "", url);
}

function todayStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}
