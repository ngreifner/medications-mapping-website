// modes/mode3-atc-to-rxcuis.js — Mode 3 UI logic.
// ATC → RXCUIs + NDC drill-down for a single Level 4 or Level 5 ATC code.
//
// API quirks (verified empirically against RxNav, Jan 2026):
//   1. /rxclass/classMembers is Level-4-only. L5 classId queries return 0
//      regardless of relaSource. For an L5 query we fetch the L4 parent and
//      filter post-verification.
//   2. ATCPROD vs ATC schemas differ:
//        ATCPROD members  → product RXCUIs; nodeAttr.SourceId = the RXCUI
//        ATC     members  → ingredient RXCUIs; nodeAttr.SourceId = L5 ATC
//      ATCPROD has no "declared L5" attribution — so L5 grouping uses the
//      resolver's first kept L5 (post-verification), not member.sourceId.
//
// Flow:
//   1. validate format + level
//   2. render breadcrumb
//   3. fetch L4 parent's members (ATCPROD primary, ATC fallback)
//   4. (L4 gate removed — Mode 3 only accepts Level 5 codes)
//   5. verify every member via convertRxcuiToAtc + getProperties (progress bar)
//   6. fetch active NDCs for KEPT rows
//   7. render the table (grouped for L4, flat for L5)
//   8. wire filter chips, group toggle, row-expand

import { detectCodeType, atcLevel } from "../code-detection.js";
import { atcLevelCodes, ATC_LEVEL1 } from "../atc-anatomy.js";
import {
  getAtcClassName,
  getClassMembers,
  getProperties,
  getDfgs,
} from "../rxnav-client.js";
import { convertRxcuiToAtc } from "../atc-resolver.js";
import { resolveRoute } from "../filter-engine.js";
import { renderInto as renderMode1Into } from "./mode1-single-forward.js";
import { downloadCsv } from "../csv-export.js";
import {
  atcBreadcrumbCard,
  memberRow,
  progressBar,
  updateProgressBar,
  errorCard,
  educationalBanner,
  statusInfoIcon,
} from "../ui-components.js";

const STATUSES = ["KEPT", "ROUTE_MISMATCH", "NEEDS_REVIEW"];
const STATUS_CHIP_LABEL = {
  KEPT:           "Kept",
  ROUTE_MISMATCH: "Mismatch",
  NEEDS_REVIEW:   "Needs review",
};

const STATUS_INFO = {
  KEPT: {
    dot: "success",
    name: "Kept",
    short: "Member resolves back to this ATC",
    long: "This RXCUI is listed as a member of the queried ATC class, AND the route-aware resolver agrees — confirming the mapping in both directions.",
  },
  ROUTE_MISMATCH: {
    dot: "error",
    name: "Route mismatch",
    short: "Member resolves to a different ATC",
    long: "RxNorm's classMembers list includes this RXCUI under the queried ATC, but the route-aware resolver maps it to a different L5 ATC code. This indicates a potential discrepancy between source data and product-level classification.",
  },
  NEEDS_REVIEW: {
    dot: "warning",
    name: "Needs review",
    short: "Could not verify automatically",
    long: "This RXCUI couldn't be auto-verified. See the row's reason field — common causes are missing properties, no DFG, or no ATC mapping returned by the resolver.",
  },
};

function buildMode3Banner({ showDismiss = true, ignoreDismissed = false } = {}) {
  return educationalBanner({
    storageKey: "medcode_mode3_status_banner_dismissed",
    title: "ATC class members — verification results",
    items: STATUSES.map(k => ({
      dot: STATUS_INFO[k].dot,
      name: STATUS_INFO[k].name,
      desc: STATUS_INFO[k].short,
    })),
    footnote: "Click any row for the full Mode 1 explanation.",
    showDismiss,
    ignoreDismissed,
  });
}

function buildMode3RowTooltip(rec) {
  if (!rec.status) return "";
  if (rec.status === "KEPT") {
    return `${rec.name || rec.rxcui} resolves back to the queried ATC. Both the source list and the route-aware resolver agree.`;
  }
  if (rec.status === "ROUTE_MISMATCH") {
    const resolved = rec.resolvedAtcs && rec.resolvedAtcs.length
      ? rec.resolvedAtcs.join(", ")
      : "a different L5 ATC";
    return `RxNorm lists ${rec.name || rec.rxcui} under this class, but the route-aware resolver maps it to ${resolved}.`;
  }
  return rec.reason || STATUS_INFO.NEEDS_REVIEW.long;
}

let activeRunId = 0;

// ---------------- public entry ----------------

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
  clearOutput(refs);
  writeUrl("");
}

export async function submitFromUrl(panelEl, atc) {
  const refs = getRefs(panelEl);
  if (!refs.input) return;
  refs.input.value = atc;
  await runSubmit(refs, atc);
}

// ---------------- refs ----------------

function getRefs(panelEl) {
  return {
    panel:        panelEl,
    input:        panelEl.querySelector("#mode3-input"),
    submit:       panelEl.querySelector("#mode3-submit"),
    breadcrumb:   panelEl.querySelector("#mode3-breadcrumb"),
    progress:     panelEl.querySelector("#mode3-progress"),
    summary:      panelEl.querySelector("#mode3-summary"),
    filters:      panelEl.querySelector("#mode3-filters"),
    table:        panelEl.querySelector("#mode3-table"),
  };
}

function clearOutput(refs) {
  for (const k of ["breadcrumb", "progress", "summary", "filters", "table"]) {
    if (refs[k]) refs[k].innerHTML = "";
  }
}

function bindInput(refs) {
  refs.submit.addEventListener("click", () => runSubmit(refs, refs.input.value));
  refs.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); runSubmit(refs, refs.input.value); }
    else if (e.key === "Escape") { e.preventDefault(); reset(refs.panel); }
  });
}

function bindExamples(refs) {
  refs.panel.querySelectorAll(".examples-chips .chip[data-atc]").forEach((chip) => {
    chip.addEventListener("click", () => {
      const atc = chip.dataset.atc;
      refs.input.value = atc;
      runSubmit(refs, atc);
    });
  });
}

// ---------------- main submit ----------------

async function runSubmit(refs, rawAtc) {
  activeRunId++;
  const runId = activeRunId;
  clearOutput(refs);

  const trimmed = (rawAtc || "").trim().toUpperCase();
  writeUrl(trimmed);

  if (!trimmed) {
    refs.table.appendChild(errorCard({
      title: "Enter an ATC code",
      body: "Type or paste a Level 5 ATC code (7 characters, e.g., R01AD08).",
      variant: "info",
    }));
    return;
  }

  const detected = detectCodeType(trimmed);
  if (detected.type !== "ATC") {
    refs.table.appendChild(errorCard({
      title: `"${trimmed}" doesn't look like an ATC code`,
      body: "ATC codes follow the pattern letter–digit–digit–letter–letter–digit–digit (e.g., R01AD08).",
      variant: "warning",
    }));
    return;
  }
  const lvl = atcLevel(trimmed);
  if (lvl !== 5) {
    refs.table.appendChild(errorCard({
      title: "Mode 3 requires a Level 5 ATC code",
      body: `"${trimmed}" is a Level ${lvl || "?"} code. Mode 3 requires a Level 5 ATC code (7 characters, e.g., R01AD08). Shorter codes return too many results to be useful — drill down to a specific substance code instead.`,
      variant: "warning",
    }));
    return;
  }

  renderBreadcrumb(refs, trimmed);

  // RxNav's /classMembers is L4-only. For our L5 query, fetch the L4 parent
  // and post-filter (the actual filtering happens in verifyAndRender via the
  // resolver-verdict check).
  const fetchClassId = trimmed.slice(0, 5);

  let members = [];
  let source = "ATCPROD";
  try {
    members = await getClassMembers(fetchClassId, "ATCPROD");
    if (runId !== activeRunId) return;
    if (members.length === 0) {
      const fallback = await getClassMembers(fetchClassId, "ATC");
      if (runId !== activeRunId) return;
      if (fallback.length > 0) {
        members = fallback;
        source = "ATC";
      }
    }
  } catch (e) {
    if (runId !== activeRunId) return;
    refs.table.appendChild(errorCard({
      title: "Couldn't reach RxNav",
      body: "The NIH API isn't responding. Check your connection and try again.",
      actions: [{ label: "Retry", primary: true, onClick: () => runSubmit(refs, trimmed) }],
      variant: "error",
    }));
    return;
  }

  if (members.length === 0) {
    refs.table.appendChild(errorCard({
      title: `No members found for ${trimmed}`,
      body: `RxNav returned no drug members under either ATCPROD or ATC source for ${fetchClassId} (the L4 parent of ${trimmed}). The code may be unused or refer to a non-pharmaceutical class.`,
      variant: "info",
    }));
    return;
  }

  await verifyAndRender(refs, { atc: trimmed, members, source, runId });
}

// ---------------- breadcrumb ----------------

async function renderBreadcrumb(refs, atc) {
  refs.breadcrumb.innerHTML = "";
  const prefixes = atcLevelCodes(atc);
  const levels = prefixes.map((p, i) => {
    const levelNum = (i === 0) ? 1 : (i === 1) ? 2 : (i === 2) ? 3 : (i === 3) ? 4 : 5;
    let name = "";
    if (levelNum === 1) {
      const l1 = ATC_LEVEL1[p];
      name = l1 ? l1.title : "";
    }
    return { atc: p, name, level: levelNum, isCurrent: i === prefixes.length - 1 };
  });
  const card = atcBreadcrumbCard({ levels });
  refs.breadcrumb.appendChild(card);

  // Async enrich L2-N names
  const slots = card.querySelectorAll(".atc-crumb");
  Promise.all(levels.map(async (lvlObj, i) => {
    if (lvlObj.level === 1) return;
    try {
      const name = await getAtcClassName(lvlObj.atc);
      if (!name) return;
      const slot = slots[i];
      if (!slot) return;
      let nameSpan = slot.querySelector(".atc-crumb-name");
      if (!nameSpan) {
        nameSpan = document.createElement("span");
        nameSpan.className = "atc-crumb-name";
        slot.appendChild(nameSpan);
      }
      nameSpan.textContent = name;
      slot.title = name;
    } catch {}
  })).catch(() => {});
}

// ---------------- verify + render ----------------

async function verifyAndRender(refs, { atc, members, source, runId }) {
  // Phase 1: verify all members in parallel; progress bar visible.
  refs.progress.innerHTML = "";
  const progEl = progressBar({ done: 0, total: members.length, eta: "Estimating…" });
  refs.progress.appendChild(progEl);

  const startTs = Date.now();
  let done = 0;
  const tick = () => {
    if (runId !== activeRunId) return;
    const elapsed = Date.now() - startTs;
    const avg = done > 0 ? elapsed / done : 0;
    const remaining = avg * (members.length - done);
    const eta = done === 0 ? "Estimating…"
              : done >= members.length ? `Done in ${formatDuration(elapsed)}`
              : `~${formatDuration(remaining)} remaining`;
    updateProgressBar(progEl, { done, total: members.length, eta });
  };
  tick();

  const records = await Promise.all(members.map(async (m) => {
    const rec = await verifyMember({ atc, member: m });
    if (runId !== activeRunId) return rec;
    done++; tick();
    return rec;
  }));
  if (runId !== activeRunId) return;

  // Render every verified member. Rows resolved to a different L5 inside the
  // same L4 parent appear as ROUTE_MISMATCH so the filter chips can narrow
  // the table to just the queried L5.
  const visibleRecords = records;

  if (visibleRecords.length === 0) {
    refs.table.appendChild(errorCard({
      title: `No matching RXCUIs for ${atc}`,
      body: `The L4 parent has ${members.length} member${members.length === 1 ? "" : "s"}, but none of them resolved to ${atc} via the route-validation engine.`,
      variant: "info",
    }));
    refs.progress.innerHTML = "";
    return;
  }

  buildAndRenderTable(refs, { records, visibleRecords });
  renderFilterChips(refs, visibleRecords);
  renderSummary(refs, { atc, members, records, visibleRecords, source });
}

async function verifyMember({ atc, member }) {
  let result, props, dfgs;
  try {
    [result, props, dfgs] = await Promise.all([
      convertRxcuiToAtc(member.rxcui),
      getProperties(member.rxcui),
      getDfgs(member.rxcui),
    ]);
  } catch {
    return {
      rxcui: member.rxcui,
      status: "NEEDS_REVIEW", reason: "Network error",
      name: "", tty: member.tty || "",
      route: "", resolvedAtc: "", resolvedAtcName: "",
      keptCodes: [],
    };
  }
  const keptL5 = ((result && result.codes) || []).filter(c => (c.code || "").length === 7);

  let status, reason = "";
  if (!props || !props.found) {
    status = "NEEDS_REVIEW"; reason = "RXCUI not found in RxNav";
  } else if (keptL5.length === 0) {
    status = "NEEDS_REVIEW"; reason = "No Level 5 ATC resolved";
  } else {
    const matches = keptL5.some(c => c.code === atc);
    status = matches ? "KEPT" : "ROUTE_MISMATCH";
    if (!matches) reason = `Resolver returned ${keptL5.map(c => c.code).join(", ")} (not ${atc})`;
  }

  // Pick the resolver's "primary" L5 — the queried code on a KEPT row, else
  // whatever the resolver returned first.
  const matchedCode = keptL5.find(c => c.code === atc);
  const primaryCode = matchedCode || keptL5[0] || null;

  // Route from DFGs (or "ingredient" for INGREDIENT_LEVEL inputs).
  let route = "";
  if (result && result.status === "INGREDIENT_LEVEL") {
    route = "ingredient";
  } else {
    const r = resolveRoute(dfgs);
    route = (r && r !== "unknown") ? r : "";
  }

  return {
    rxcui: member.rxcui,
    status, reason,
    name: (props && props.name) || "",
    tty: (props && props.tty) || member.tty || "",
    route,
    resolvedAtc: primaryCode ? primaryCode.code : "",
    resolvedAtcName: primaryCode ? (primaryCode.name || "") : "",
    keptCodes: keptL5,
  };
}

// ---------------- table assembly ----------------

function buildAndRenderTable(refs, { records, visibleRecords }) {
  const table = buildTableShell();
  refs.table.appendChild(table);
  const tbody = document.createElement("tbody");
  table.appendChild(tbody);
  for (const rec of visibleRecords) {
    appendRowForRecord(rec, tbody);
  }
}

function appendRowForRecord(rec, tbody) {
  const rowApi = memberRow({ rxcui: rec.rxcui });
  rowApi.update({
    status: rec.status,
    name: rec.name || (rec.status === "NEEDS_REVIEW" ? "—" : "(unknown)"),
    tty: rec.tty || "—",
    reason: rec.reason,
    tooltip: buildMode3RowTooltip(rec),
  });
  rowApi.setOnExpand((container) => {
    renderMode1Into({ rxcui: rec.rxcui, resultEl: container }).catch(() => {});
  });
  tbody.appendChild(rowApi.tr);
  tbody.appendChild(rowApi.detailRow);
}

function buildTableShell() {
  const table = document.createElement("table");
  table.className = "member-table";
  const thead = document.createElement("thead");
  thead.innerHTML = `
    <tr>
      <th scope="col">Status</th>
      <th scope="col">RXCUI</th>
      <th scope="col">TTY</th>
      <th scope="col">Drug</th>
      <th scope="col" aria-label="Expand"></th>
    </tr>`;
  table.appendChild(thead);
  return table;
}

// ---------------- filter chips ----------------

function renderFilterChips(refs, visibleRecords) {
  refs.filters.innerHTML = "";

  // Layer 1 banner
  const banner = buildMode3Banner();
  if (banner) refs.filters.appendChild(banner);

  const counts = { ALL: 0, KEPT: 0, ROUTE_MISMATCH: 0, NEEDS_REVIEW: 0 };
  for (const rec of visibleRecords) {
    counts.ALL++;
    if (counts[rec.status] != null) counts[rec.status]++;
  }
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
      btn.setAttribute("aria-label", `${c.label} (${counts[c.key] || 0}) — ${c.tooltip}`);
    }
    btn.innerHTML = `${c.label} <span class="filter-chip-count">${counts[c.key] || 0}</span>`;
    btn.addEventListener("click", () => applyFilter(refs, c.key));
    chipBar.appendChild(btn);
  }
  refs.filters.appendChild(chipBar);

  // Header info icon — Mode 3 uses .member-table, first column is Status.
  const statusTh = refs.table && refs.table.querySelector("thead th:first-child");
  if (statusTh && !statusTh.querySelector(".col-info-btn")) {
    const { iconBtn } = statusInfoIcon({
      buildBanner: () => buildMode3Banner({ showDismiss: false, ignoreDismissed: true }),
    });
    statusTh.appendChild(iconBtn);
  }
}

function applyFilter(refs, key) {
  const chipBar = refs.filters.querySelector(".filter-chips");
  if (chipBar) {
    chipBar.dataset.filter = key;
    for (const b of chipBar.querySelectorAll(".filter-chip")) {
      const active = b.dataset.key === key;
      b.classList.toggle("is-active", active);
      b.setAttribute("aria-pressed", active ? "true" : "false");
    }
  }
  for (const tr of refs.table.querySelectorAll("tr.member-row")) {
    const visible = rowMatchesFilter(tr, key);
    tr.hidden = !visible;
    const detail = tr.nextElementSibling;
    if (detail && detail.classList.contains("member-row-detail")) {
      if (!visible) detail.hidden = true;
    }
  }
}

function rowMatchesFilter(tr, key) {
  if (!key || key === "ALL") return true;
  return tr.dataset.status === key;
}

function getActiveFilter(refs) {
  const chipBar = refs.filters.querySelector(".filter-chips");
  return (chipBar && chipBar.dataset.filter) || "ALL";
}

// ---------------- summary ----------------

function renderSummary(refs, { atc, members, records, visibleRecords, source }) {
  refs.summary.innerHTML = "";
  let kept = 0, mismatch = 0, review = 0;
  for (const rec of visibleRecords) {
    if (rec.status === "KEPT") kept++;
    else if (rec.status === "ROUTE_MISMATCH") mismatch++;
    else review++;
  }
  const className = refs.breadcrumb.querySelector(".atc-crumb.is-current .atc-crumb-name")?.textContent || "";
  const headerLine = className ? `${atc} (${className})` : atc;
  const memberNote = `${visibleRecords.length} RXCUI${visibleRecords.length === 1 ? "" : "s"} verified`;
  const summary = `${headerLine} — ${memberNote}. ${kept} kept · ${mismatch} mismatch · ${review} need review. Source: ${source}.`;

  const section = document.createElement("section");
  section.className = "summary-bar";
  const p = document.createElement("p");
  p.className = "summary-text";
  p.textContent = summary;
  section.appendChild(p);

  // Two CSV download buttons. The queried code's class name (the L4 parent's
  // name for an L5 query, or the L4's name itself) is used to populate the
  // atc_class_name column in the compact CSV.
  const queriedClassName = className;
  const actionRow = document.createElement("div");
  actionRow.className = "action-row";

  const stamp = todayStamp();
  const fnameSafe = atc.replace(/[^A-Z0-9]/g, "");

  const compactBtn = document.createElement("button");
  compactBtn.type = "button";
  compactBtn.className = "btn-primary";
  compactBtn.textContent = "⬇ Download CSV (compact)";
  compactBtn.addEventListener("click", () => {
    const rows = buildCompactCsv(records, atc, queriedClassName);
    downloadCsv(`medcode-mode3-${fnameSafe}-${stamp}.csv`, rows);
  });

  const auditBtn = document.createElement("button");
  auditBtn.type = "button";
  auditBtn.className = "btn-secondary";
  auditBtn.textContent = "⬇ Download audit log";
  auditBtn.addEventListener("click", () => {
    const rows = buildAuditCsv(records, atc, queriedClassName);
    downloadCsv(`medcode-mode3-${fnameSafe}-audit-${stamp}.csv`, rows);
  });

  actionRow.appendChild(compactBtn);
  actionRow.appendChild(auditBtn);
  section.appendChild(actionRow);

  refs.summary.appendChild(section);
}

// ---------------- CSV builders ----------------

/**
 * Variant A: Compact, RXCUI-level. One row per KEPT record.
 */
function buildCompactCsv(records, queriedAtc, queriedClassName) {
  const rows = [["rxcui", "tty", "drug_name", "route", "resolved_atc", "atc_class_name"]];
  for (const rec of records) {
    if (rec.status !== "KEPT") continue;
    rows.push([
      rec.rxcui,
      rec.tty || "",
      rec.name || "",
      rec.route || "",
      rec.resolvedAtc || "",
      rec.resolvedAtcName || queriedClassName || "",
    ]);
  }
  return rows;
}

/**
 * Variant B: Audit log. Every visible member regardless of status. queried_atc
 * and resolved_atc side-by-side so disagreements are explicit. reason is
 * empty for KEPT rows.
 */
function buildAuditCsv(records, queriedAtc, queriedClassName) {
  const rows = [["rxcui", "status", "tty", "drug_name", "route", "queried_atc", "resolved_atc", "reason"]];
  for (const rec of records) {
    rows.push([
      rec.rxcui,
      rec.status,
      rec.tty || "",
      rec.name || "",
      rec.route || "",
      queriedAtc,
      rec.resolvedAtc || "",
      rec.reason || "",
    ]);
  }
  return rows;
}

function todayStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

// ---------------- helpers ----------------

function writeUrl(atc) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.set("mode", "3");
  if (atc) url.searchParams.set("atc", atc);
  else url.searchParams.delete("atc");
  window.history.pushState({}, "", url);
}

function formatDuration(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
}
