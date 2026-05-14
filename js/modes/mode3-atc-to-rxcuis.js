// modes/mode3-atc-to-rxcuis.js, Mode 3 UI logic.
// ATC → RXCUIs + NDC drill-down for a single Level 4 or Level 5 ATC code.
//
// API quirks (verified empirically against RxNav, Jan 2026):
//   1. /rxclass/classMembers is Level-4-only. L5 classId queries return 0
//      regardless of relaSource. For an L5 query we fetch the L4 parent and
//      filter post-verification.
//   2. ATCPROD vs ATC schemas differ:
//        ATCPROD members  → product RXCUIs; nodeAttr.SourceId = the RXCUI
//        ATC     members  → ingredient RXCUIs; nodeAttr.SourceId = L5 ATC
//      ATCPROD has no "declared L5" attribution, so L5 grouping uses the
//      resolver's first kept L5 (post-verification), not member.sourceId.
//
// Flow:
//   1. validate format + level
//   2. render breadcrumb
//   3. fetch L4 parent's members (ATCPROD primary, ATC fallback)
//   4. (L4 gate removed, Mode 3 only accepts Level 5 codes)
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
  getLevel5ChildrenForL4,
  getNdcPropertiesForRxcui,
} from "../rxnav-client.js";
import { convertRxcuiToAtc } from "../atc-resolver.js";
import { resolveRoute } from "../filter-engine.js";
import { renderInto as renderMode1Into } from "./mode1-single-forward.js";
import { downloadCsv } from "../csv-export.js";
import {
  atcBreadcrumbCard,
  memberRow,
  mode3ProgressCard,
  errorCard,
  educationalBanner,
  statusInfoIcon,
  atcFamilyCard,
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
    long: "This RXCUI is listed as a member of the queried ATC class, AND the route-aware resolver agrees, confirming the mapping in both directions.",
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
    long: "This RXCUI couldn't be auto-verified. See the row's reason field, common causes are missing properties, no DFG, or no ATC mapping returned by the resolver.",
  },
};

function buildMode3Banner({ showDismiss = true, ignoreDismissed = false } = {}) {
  return educationalBanner({
    storageKey: "medcode_mode3_status_banner_dismissed",
    title: "ATC class members, verification results",
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
let activeCancel = null; // cancel token of the in-flight run; fired on supersession

// Snapshot of the most-recently-completed query, used by the optional NDC
// extension and the RxCUI/NDC view toggle. Reset on every new submit. Holds
// the records array, the original ATC code + L4 source, and a Map keyed by
// RxCUI carrying the NDC entries fetched during the extension phase.
let currentRun = null;

// Mode 5's batch cap inherits here, since the NDC extension calls the same
// underlying NDC-properties endpoint per RxCUI.
const NDC_EXTENSION_CAP = 200;

// Per-run cancellation token. The user's Stop button fires `cancel.fire()`,
// which both sets the `cancelled` flag AND resolves the promise so any waiter
// in Promise.race wakes up immediately. New submits also fire the previous
// run's token so its Promise.race wakes and the function returns cleanly.
function makeCancelToken() {
  let resolveIt;
  const promise = new Promise(r => { resolveIt = r; });
  const token = {
    cancelled: false,
    promise,
    fire() {
      if (token.cancelled) return;
      token.cancelled = true;
      resolveIt();
    },
  };
  return token;
}

// Begin a new run: bumps the run id, fires any previous cancel, hands back
// a fresh runId + cancel token. Callers use this at the top of submit-style
// functions so superseded runs don't leak pending Promise.race awaiters.
function bumpRunAndSupersede() {
  activeRunId++;
  const runId = activeRunId;
  if (activeCancel) activeCancel.fire();
  const cancel = makeCancelToken();
  activeCancel = cancel;
  return { runId, cancel };
}

function startRun() {
  const out = bumpRunAndSupersede();
  // A fresh ATC query supersedes any cached run snapshot, including NDC data.
  currentRun = null;
  return out;
}

function startExtensionRun() {
  // NDC extension runs against the existing currentRun snapshot. We still
  // want a fresh runId + cancel token so Stop / a new ATC query can wake
  // this phase, but the snapshot itself is preserved.
  return bumpRunAndSupersede();
}

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
    hint:         panelEl.querySelector("#mode3-input-hint"),
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
  // Live level hint, updates as the user types.
  const update = () => updateInputHint(refs);
  refs.input.addEventListener("input", update);
  refs.input.addEventListener("paste", () => setTimeout(update, 0));
  update();
}

function updateInputHint(refs) {
  if (!refs.hint) return;
  const raw = (refs.input.value || "").trim().toUpperCase();
  refs.hint.classList.remove("is-l4", "is-l5", "is-error");
  if (!raw) { refs.hint.textContent = ""; return; }
  const det = detectCodeType(raw);
  if (det.type !== "ATC") {
    refs.hint.classList.add("is-error");
    refs.hint.textContent = `"${raw}" doesn't look like an ATC code yet, keep typing.`;
    return;
  }
  const lvl = atcLevel(raw);
  if (lvl === 4) {
    refs.hint.classList.add("is-l4");
    refs.hint.textContent = `Level 4 family code, pressing Look up will show the Level 5 cousins in this family.`;
  } else if (lvl === 5) {
    refs.hint.classList.add("is-l5");
    refs.hint.textContent = `Level 5 code, pressing Look up will fetch all RxCUIs in this class.`;
  } else {
    refs.hint.classList.add("is-error");
    refs.hint.textContent = `Level ${lvl} code detected, only Level 4 (5 chars) and Level 5 (7 chars) are supported.`;
  }
}

function bindExamples(refs) {
  // Example chips prefill the input only; the user runs the lookup with
  // the Look up button or Enter. updateInputHint still fires so the live
  // L4/L5 hint reflects the new value.
  refs.panel.querySelectorAll(".examples-chips .chip[data-atc]").forEach((chip) => {
    chip.addEventListener("click", () => {
      const atc = chip.dataset.atc;
      refs.input.value = atc;
      updateInputHint(refs);
      refs.input.focus();
    });
  });
}

// ---------------- main submit ----------------

async function runSubmit(refs, rawAtc) {
  const { runId, cancel } = startRun();
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
  if (lvl === 4) {
    await runL4Family(refs, trimmed, runId);
    return;
  }
  if (lvl !== 5) {
    refs.table.appendChild(errorCard({
      title: "Mode 3 supports Level 4 and Level 5 ATC codes",
      body: `"${trimmed}" is a Level ${lvl || "?"} code. Only Level 4 (5 chars, e.g., M01AE) and Level 5 (7 chars, e.g., R01AD08) are supported.`,
      variant: "warning",
    }));
    return;
  }

  renderBreadcrumb(refs, trimmed);

  // Mount the progress card immediately, before the roster fetch, so the
  // user sees something moving within the first ~100ms of clicking Look up.
  // The cancel token was created in startRun(); wire its Stop button now.
  const progCard = mode3ProgressCard({
    title: `Looking up ${trimmed}`,
    status: "Fetching family roster…",
  });
  progCard.setOnStop(() => cancel.fire());
  refs.progress.innerHTML = "";
  refs.progress.appendChild(progCard.el);

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
    progCard.finish({ stopped: false });
    refs.progress.innerHTML = "";
    refs.table.appendChild(errorCard({
      title: "Couldn't reach RxNav",
      body: "The NIH API isn't responding. Check your connection and try again.",
      actions: [{ label: "Retry", primary: true, onClick: () => runSubmit(refs, trimmed) }],
      variant: "error",
    }));
    return;
  }

  // Stop pressed during roster fetch, nothing to render, just close cleanly.
  if (cancel.cancelled) {
    progCard.finish({ stopped: true });
    progCard.update({ status: "Stopped before any members were verified." });
    return;
  }

  if (members.length === 0) {
    refs.progress.innerHTML = "";
    refs.table.appendChild(errorCard({
      title: `No members found for ${trimmed}`,
      body: `RxNav returned no drug members under either ATCPROD or ATC source for ${fetchClassId} (the L4 parent of ${trimmed}). The code may be unused or refer to a non-pharmaceutical class.`,
      variant: "info",
    }));
    return;
  }

  await verifyAndRender(refs, { atc: trimmed, members, source, runId, progCard, cancel });
}

// ---------------- Level 4 family expansion ----------------
//
// For an L4 input (e.g. M01AE), enumerate the L5 cousins observable through
// RxClass's ATC source and render the family card. Each cousin gets a "Query"
// button that re-runs Mode 3 on that specific L5, the standard L5 path is
// completely unchanged, this is purely a navigation aid.
//
// Coverage caveat (documented in CLAUDE.md): the cousin list reflects "L5s
// for which RxNorm has at least one drug member," which is a subset of WHO's
// official catalog. L5s WHO has defined but RxNorm doesn't classify any drug
// under will not appear.

async function runL4Family(refs, l4code, runId) {
  renderBreadcrumb(refs, l4code);

  let cousins, l4name;
  try {
    [cousins, l4name] = await Promise.all([
      getLevel5ChildrenForL4(l4code),
      getAtcClassName(l4code).catch(() => ""),
    ]);
  } catch (e) {
    if (runId !== activeRunId) return;
    refs.table.appendChild(errorCard({
      title: "Couldn't retrieve Level 5 cousins",
      body: "The NIH API isn't responding. Please try again, or enter a Level 5 code directly.",
      actions: [{ label: "Retry", primary: true, onClick: () => runL4Family(refs, l4code, runId) }],
      variant: "error",
    }));
    return;
  }
  if (runId !== activeRunId) return;

  if (!cousins || cousins.length === 0) {
    refs.table.appendChild(errorCard({
      title: `${l4code} has no Level 5 cousins indexed in RxClass`,
      body: "The class may exist in WHO's ATC taxonomy but not be exposed through the public API. Try a Level 5 code directly if you know one.",
      variant: "info",
    }));
    return;
  }

  const annotated = cousins.map(c => ({
    code: c.code,
    name: c.name,
    isCombination: isCombinationL5(c.code, c.name, l4name),
  }));

  const card = atcFamilyCard({
    parentCode: l4code,
    parentName: l4name || "(name unavailable)",
    cousins: annotated,
    onQueryCousin: (l5) => {
      refs.input.value = l5;
      updateInputHint(refs);
      runSubmit(refs, l5);
    },
    onExport: () => {
      const rows = buildFamilyCsv(l4code, l4name, annotated);
      downloadCsv(`medcode-mode3-family-${l4code}-${todayStamp()}.csv`, rows);
    },
    onQueryAll: () => runL4FamilyBatch(refs, l4code, l4name, annotated, runId),
  });
  refs.table.appendChild(card);
}

// Combination L5s, surface a soft visual marker. Heuristic combines two
// signals: (a) standard WHO ATC numbering where digits 5x and 7x mean
// combinations, and (b) name/parent name containing "combination(s)".
function isCombinationL5(code, name, parentName) {
  const c = (code || "").toUpperCase();
  if (c.length === 7) {
    const sixth = c.charAt(5);
    if (sixth === "5" || sixth === "7") return true;
  }
  const n = (name || "").toLowerCase();
  if (n.includes("combination")) return true;
  const p = (parentName || "").toLowerCase();
  if (p.includes("combinations of") || /\bcombinations\b/.test(p)) return true;
  return false;
}

// Family CSV, one row per cousin with the parent for context. Lets users
// drop the list straight into a reference document.
function buildFamilyCsv(l4code, l4name, cousins) {
  const rows = [["parent_atc", "parent_name", "child_atc", "child_name", "is_combination"]];
  for (const c of cousins) {
    rows.push([
      l4code,
      l4name || "",
      c.code,
      c.name || "",
      c.isCombination ? "true" : "false",
    ]);
  }
  return rows;
}

// Query all cousins as one batch, fetch the L4's classMembers once (reused
// across cousins), verify every member, and bucket KEPT rows by the L5 each
// resolves to. This is a thin wrapper over the existing verify path; no
// duplicate resolver logic.
async function runL4FamilyBatch(refs, l4code, l4name, cousins, _outerRunId) {
  // Query-all-cousins is a separate run from the L4 expansion that spawned
  // it. Start a fresh run so a previous in-flight verify (if any) is fired.
  const { runId, cancel } = startRun();
  clearOutput(refs);
  renderBreadcrumb(refs, l4code);

  const progCard = mode3ProgressCard({
    title: `Looking up all of ${l4code}`,
    status: "Fetching family roster…",
  });
  progCard.setOnStop(() => cancel.fire());
  refs.progress.innerHTML = "";
  refs.progress.appendChild(progCard.el);

  let members = [];
  let source = "ATCPROD";
  try {
    members = await getClassMembers(l4code, "ATCPROD");
    if (runId !== activeRunId) return;
    if (members.length === 0) {
      const fallback = await getClassMembers(l4code, "ATC");
      if (runId !== activeRunId) return;
      if (fallback.length > 0) { members = fallback; source = "ATC"; }
    }
  } catch {
    if (runId !== activeRunId) return;
    refs.progress.innerHTML = "";
    refs.table.appendChild(errorCard({
      title: "Couldn't reach RxNav",
      body: "Failed to fetch the L4 class members.",
      variant: "error",
    }));
    return;
  }

  if (cancel.cancelled) {
    progCard.finish({ stopped: true });
    progCard.update({ status: "Stopped before any members were verified." });
    return;
  }

  if (members.length === 0) {
    refs.progress.innerHTML = "";
    refs.table.appendChild(errorCard({
      title: `No members found for ${l4code}`,
      body: "RxNav returned no drug members under either ATCPROD or ATC source.",
      variant: "info",
    }));
    return;
  }

  await verifyAndRender(refs, {
    atc: l4code,           // queried "atc" carries the L4, verifyMember
    members,               // accepts a record where resolvedAtc starts with
    source,                // this prefix, see acceptedL5Prefix below.
    runId,
    acceptedL5Prefix: l4code,
    progCard,
    cancel,
  });
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

async function verifyAndRender(refs, {
  atc, members, source, runId,
  acceptedL5Prefix = null,
  progCard = null,
  cancel = null,
}) {
  // If a caller didn't pre-mount the progress card (legacy paths), build one
  // now so the user always gets a Stop button + live count.
  if (!progCard) {
    cancel = cancel || makeCancelToken();
    progCard = mode3ProgressCard({
      title: `Verifying members of ${atc}`,
      status: "Verifying members…",
    });
    progCard.setOnStop(() => cancel.fire());
    refs.progress.innerHTML = "";
    refs.progress.appendChild(progCard.el);
  }
  if (!cancel) cancel = makeCancelToken();

  // Transition the card from "Fetching family roster…" into per-member mode.
  progCard.update({
    phase: "verifying",
    status: `Verifying ${members.length} member${members.length === 1 ? "" : "s"}…`,
    current: 0,
    total: members.length,
    eta: "Estimating…",
    lastName: "",
  });

  // Normal L5 query: KEPT when resolver returns the queried L5 exactly.
  // L4 family batch: KEPT when resolver returns any L5 under the L4 prefix.
  const acceptCode = acceptedL5Prefix
    ? (code) => (code || "").toUpperCase().startsWith(acceptedL5Prefix.toUpperCase())
    : (code) => code === atc;

  const startTs = Date.now();
  const records = new Array(members.length).fill(null);
  const completionTs = []; // wall-clock timestamps of each completion
  let done = 0;
  let lastCompletedName = "";

  // Visual fill percentage, interpolated independently of real completions so
  // the bar always shows motion. Targets the max of (a) real done/total,
  // (b) a time-based projection using the current best estimate of total
  // duration, and (c) its own prior value (monotonic). Initial duration
  // estimate is 500ms/member; once at least three members have completed we
  // switch to the measured pace. Capped at 95% so the final snap to 100%
  // still reads as completion.
  let visualPct = 0;
  const INITIAL_MS_PER_MEMBER = 500;

  const recomputeVisualTarget = () => {
    const total = members.length;
    const elapsed = Date.now() - startTs;
    const measuredPace = done >= 3 ? elapsed / done : null;
    const estTotalMs = (measuredPace || INITIAL_MS_PER_MEMBER) * total;
    const timePct = Math.min(95, (elapsed / Math.max(1, estTotalMs)) * 100);
    const realPct = (done / total) * 100;
    return Math.max(visualPct, realPct, timePct);
  };

  // Rolling ETA: average inter-completion interval over the most recent
  // window. Per-member execution time is meaningless under parallel
  // throttled fetch, what matters is the rate at which the rate-limited
  // queue is producing completions.
  const tick = () => {
    if (runId !== activeRunId) return;
    const total = members.length;
    let etaText = "";
    if (done >= total) {
      etaText = `Done in ${formatDuration(Date.now() - startTs)}`;
      visualPct = 100;
    } else if (completionTs.length >= 5) {
      const w = Math.min(5, completionTs.length - 1);
      const span = completionTs[completionTs.length - 1] - completionTs[completionTs.length - 1 - w];
      const perItem = span / w;
      const remaining = total - done;
      etaText = `About ${formatDuration(perItem * remaining)} remaining`;
    } else if (done > 0) {
      etaText = "Estimating…";
    } else {
      etaText = "Verifying…";
    }
    progCard.update({ current: done, total, fillPct: visualPct, eta: etaText, lastName: lastCompletedName });
  };

  // Drive the visual fill on a 100ms timer. Eases 25% of the gap each tick
  // toward the target, gives smooth motion from t=0 without ever regressing.
  const visualTimer = setInterval(() => {
    if (runId !== activeRunId) return;
    if (cancel.cancelled || done >= members.length) return;
    const target = recomputeVisualTarget();
    visualPct = Math.max(visualPct, visualPct + (target - visualPct) * 0.25);
    tick();
  }, 100);

  tick();

  // Allow Promise.race to wake immediately when all members complete.
  let resolveAllDone;
  const allDonePromise = new Promise(r => { resolveAllDone = r; });

  // Fire all member verifications. Track each completion individually so
  // the progress card advances on every result, not after the batch.
  members.forEach((m, i) => {
    verifyMember({ atc, member: m, acceptCode })
      .catch(() => ({
        rxcui: m.rxcui,
        status: "NEEDS_REVIEW", reason: "Network error",
        name: "", tty: m.tty || "",
        route: "", resolvedAtc: "", resolvedAtcName: "",
        keptCodes: [],
      }))
      .then(rec => {
        if (runId !== activeRunId) return;
        if (cancel.cancelled) return; // ignore late arrivals after Stop
        records[i] = rec;
        done++;
        completionTs.push(Date.now());
        lastCompletedName = rec.name ? `${rec.name} (RxCUI ${rec.rxcui})` : `RxCUI ${rec.rxcui}`;
        tick();
        if (done >= members.length) resolveAllDone();
      });
  });

  // Race: either every member completed, or the user clicked Stop.
  await Promise.race([allDonePromise, cancel.promise]);
  clearInterval(visualTimer);
  if (runId !== activeRunId) return;

  const wasCancelled = cancel.cancelled;
  const finalRecords = records.filter(r => r !== null);
  const elapsedMs = Date.now() - startTs;
  // Snap the bar to its final position so the freeze state is honest.
  visualPct = wasCancelled ? Math.min(95, (finalRecords.length / members.length) * 100) : 100;

  if (wasCancelled) {
    progCard.update({
      status: `Stopped at ${finalRecords.length} of ${members.length}. Showing partial results below.`,
      eta: "",
      lastName: "",
      stopped: true,
      fillPct: visualPct,
    });
    progCard.finish({ stopped: true });
  } else {
    progCard.update({
      status: `Verified ${finalRecords.length} of ${members.length} member${members.length === 1 ? "" : "s"} in ${formatDuration(elapsedMs)}.`,
      eta: "",
      lastName: "",
      fillPct: 100,
    });
    progCard.finish({ stopped: false });
  }

  if (finalRecords.length === 0) {
    refs.table.appendChild(errorCard({
      title: wasCancelled
        ? "Stopped before any members were verified"
        : `No matching RXCUIs for ${atc}`,
      body: wasCancelled
        ? "Click 'Look up' to start a fresh query."
        : `The L4 parent has ${members.length} member${members.length === 1 ? "" : "s"}, but none of them resolved to ${atc} via the route-validation engine.`,
      variant: "info",
    }));
    return;
  }

  // Snapshot for the optional NDC extension. The view toggle and the
  // re-render path both read from this.
  const className = refs.breadcrumb.querySelector(".atc-crumb.is-current .atc-crumb-name")?.textContent || "";
  currentRun = {
    atc, members, source, className,
    records: finalRecords,
    ndcs: new Map(),
    ndcTrimNote: null,
    extensionRan: false,
    view: "rxcui",
  };
  renderResultsInCurrentView(refs);
}

// Re-render the table + filters + summary for whichever view the run is in.
// Called after the initial verify completes, after the NDC extension
// finishes, and when the user flips the view toggle.
function renderResultsInCurrentView(refs) {
  if (!currentRun) return;
  refs.summary.innerHTML = "";
  refs.filters.innerHTML = "";
  refs.table.innerHTML = "";
  if (currentRun.view === "ndc") {
    renderNdcLevelView(refs);
  } else {
    buildAndRenderTable(refs, { records: currentRun.records, visibleRecords: currentRun.records });
    renderFilterChips(refs, currentRun.records);
    renderSummary(refs, {
      atc: currentRun.atc, members: currentRun.members,
      records: currentRun.records, visibleRecords: currentRun.records,
      source: currentRun.source,
    });
    renderExtendCard(refs);
  }
}

async function verifyMember({ atc, member, acceptCode = null }) {
  const accept = acceptCode || ((code) => code === atc);
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
    const matches = keptL5.some(c => accept(c.code));
    status = matches ? "KEPT" : "ROUTE_MISMATCH";
    if (!matches) reason = `Resolver returned ${keptL5.map(c => c.code).join(", ")} (not ${atc})`;
  }

  // Pick the resolver's "primary" L5, the first code that satisfies the
  // accept predicate, else whatever the resolver returned first.
  const matchedCode = keptL5.find(c => accept(c.code));
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
    name: rec.name || (rec.status === "NEEDS_REVIEW" ? "–" : "(unknown)"),
    tty: rec.tty || "–",
    reason: rec.reason,
    tooltip: buildMode3RowTooltip(rec),
    resolvedAtc: rec.resolvedAtc || "",
    resolvedAtcName: rec.resolvedAtcName || "",
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
      <th scope="col">Resolved L5</th>
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
      btn.setAttribute("aria-label", `${c.label} (${counts[c.key] || 0}), ${c.tooltip}`);
    }
    btn.innerHTML = `${c.label} <span class="filter-chip-count">${counts[c.key] || 0}</span>`;
    btn.addEventListener("click", () => applyFilter(refs, c.key));
    chipBar.appendChild(btn);
  }
  refs.filters.appendChild(chipBar);

  // Header info icon, Mode 3 uses .member-table, first column is Status.
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
  const summary = `${headerLine}, ${memberNote}. ${kept} kept · ${mismatch} mismatch · ${review} need review. Source: ${source}.`;

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

  // After the NDC extension has run once, surface a view toggle so the user
  // can flip back to the three-level table without re-running anything.
  if (currentRun && currentRun.extensionRan) {
    actionRow.appendChild(buildViewToggle(refs, "rxcui"));
  }

  section.appendChild(actionRow);

  refs.summary.appendChild(section);
}

// ---------------- NDC extension (optional second phase) ----------------
//
// Adds an "Extend with NDCs" action below the summary. When the user clicks
// it, every KEPT RxCUI is run through getNdcPropertiesForRxcui (the same
// client helper Mode 5 uses) and the table flips to an NDC-level view: one
// row per RxCUI/NDC pair, with the originally queried ATC L5 stamped on each
// row. A view toggle lets the user switch back to the RxCUI-level view; the
// fetched NDC data is cached in currentRun.ndcs so the toggle is instant.

// A row is "extendable" only when the resolver confirmed the queried ATC.
// ROUTE_MISMATCH rows are siblings under the same L4 that resolved to a
// different L5; their NDCs don't belong under the user's queried code, so
// the three-level mapping (queried_atc → rxcui → ndc) would be dishonest.
function isExtendable(rec) {
  return rec && rec.rxcui && rec.status === "KEPT";
}

function renderExtendCard(refs) {
  if (!currentRun) return;
  const keptCount = currentRun.records.filter(isExtendable).length;
  const card = document.createElement("section");
  card.className = "card card-extend";
  card.setAttribute("aria-label", "Extend with NDCs");

  if (currentRun.extensionRan) {
    // After the extension has run once, the card collapses into a small
    // status line. The user can re-flip the view toggle instead of re-running.
    const note = document.createElement("p");
    note.className = "card-body";
    const fetched = [...currentRun.ndcs.values()].reduce((a, b) => a + b.length, 0);
    note.textContent = `NDC extension complete: ${fetched} NDC row${fetched === 1 ? "" : "s"} cached across ${currentRun.ndcs.size} RxCUI${currentRun.ndcs.size === 1 ? "" : "s"}.`;
    card.appendChild(note);
    refs.summary.appendChild(card);
    return;
  }

  const title = document.createElement("h3");
  title.className = "card-title";
  title.textContent = "Extend this result with NDC mappings";
  card.appendChild(title);

  const body = document.createElement("p");
  body.className = "card-body";
  body.textContent = `Fetch the current FDA NDCs for each verified RxCUI. The table becomes a three-level view (ATC L5 → RxCUI → NDC) and the CSV export follows.`;
  card.appendChild(body);

  const row = document.createElement("div");
  row.className = "action-row";

  if (keptCount === 0) {
    const muted = document.createElement("p");
    muted.className = "card-body";
    muted.style.color = "var(--text-muted)";
    muted.textContent = "No verified RxCUIs to extend. Every member resolved to a different L5 or needs review.";
    card.appendChild(muted);
  } else {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-primary";
    btn.textContent = `→ Extend with NDCs (${keptCount} verified RxCUI${keptCount === 1 ? "" : "s"})`;
    btn.addEventListener("click", () => runNdcExtension(refs));
    row.appendChild(btn);

    const hint = document.createElement("span");
    hint.className = "card-aside";
    const est = Math.max(1, Math.round((keptCount * 300) / 1000));
    hint.textContent = `Estimated ~${est}s for ${keptCount} RxCUI${keptCount === 1 ? "" : "s"}.`;
    row.appendChild(hint);
    card.appendChild(row);
  }
  refs.summary.appendChild(card);
}

async function runNdcExtension(refs) {
  if (!currentRun) return;
  const allKept = currentRun.records.filter(isExtendable);
  if (allKept.length === 0) return;

  // 200-cap inheritance from Mode 5. Render a confirm prompt that replaces
  // the extend card; "Trim and run" continues with the first 200, "Cancel"
  // restores the extend card untouched.
  if (allKept.length > NDC_EXTENSION_CAP) {
    refs.summary.innerHTML = "";
    // Re-render summary bar + a prompt card. Calling renderResultsInCurrentView
    // here would re-mount the full RxCUI view; instead just re-add summary +
    // a custom prompt.
    renderSummary(refs, {
      atc: currentRun.atc, members: currentRun.members,
      records: currentRun.records, visibleRecords: currentRun.records,
      source: currentRun.source,
    });
    refs.summary.appendChild(errorCard({
      title: `Result has ${allKept.length} verified RxCUIs`,
      body: `The NDC extension processes up to ${NDC_EXTENSION_CAP} at a time. Process the first ${NDC_EXTENSION_CAP} now and skip the rest?`,
      actions: [
        {
          label: `Process first ${NDC_EXTENSION_CAP}`,
          primary: true,
          onClick: () => {
            currentRun._trimmedTo = NDC_EXTENSION_CAP;
            currentRun._trimmedFrom = allKept.length;
            runNdcExtensionInner(refs, allKept.slice(0, NDC_EXTENSION_CAP));
          },
        },
        {
          label: "Cancel",
          primary: false,
          onClick: () => renderResultsInCurrentView(refs),
        },
      ],
      variant: "warning",
    }));
    return;
  }

  await runNdcExtensionInner(refs, allKept);
}

async function runNdcExtensionInner(refs, keptToProcess) {
  // startExtensionRun preserves currentRun (unlike startRun, which clears it).
  const { runId, cancel } = startExtensionRun();
  const snapshot = currentRun;
  if (!snapshot) return;

  // Replace the action card area with a fresh progress card. The RxCUI table
  // stays mounted underneath so the user keeps context while NDCs fetch.
  refs.summary.innerHTML = "";
  // Re-mount the (existing) summary bar so the user still sees the verdict
  // summary above the new progress card.
  renderSummary(refs, {
    atc: snapshot.atc, members: snapshot.members,
    records: snapshot.records, visibleRecords: snapshot.records,
    source: snapshot.source,
  });

  const progCard = mode3ProgressCard({
    title: `Fetching NDCs for ${keptToProcess.length} verified RxCUI${keptToProcess.length === 1 ? "" : "s"}`,
    status: "Verifying NDC properties…",
  });
  progCard.setOnStop(() => cancel.fire());
  refs.summary.appendChild(progCard.el);
  progCard.update({
    phase: "verifying",
    current: 0, total: keptToProcess.length,
    eta: "Estimating…", lastName: "",
  });

  const startTs = Date.now();
  const completionTs = [];
  let done = 0;
  let lastName = "";
  let visualPct = 0;
  const EST_MS_PER_RXCUI = 300;

  const recomputeTarget = () => {
    const total = keptToProcess.length;
    const elapsed = Date.now() - startTs;
    const measured = done >= 3 ? elapsed / done : null;
    const perItem = measured || EST_MS_PER_RXCUI;
    const timePct = Math.min(95, (elapsed / (perItem * total)) * 100);
    const realPct = (done / total) * 100;
    return Math.max(visualPct, realPct, timePct);
  };

  const tick = () => {
    if (runId !== activeRunId) return;
    const total = keptToProcess.length;
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
    progCard.update({ current: done, total, fillPct: visualPct, eta, lastName: lastName });
  };

  const visualTimer = setInterval(() => {
    if (runId !== activeRunId || cancel.cancelled || done >= keptToProcess.length) return;
    visualPct = Math.max(visualPct, visualPct + (recomputeTarget() - visualPct) * 0.25);
    tick();
  }, 100);

  tick();

  let resolveAllDone;
  const allDone = new Promise(r => { resolveAllDone = r; });

  keptToProcess.forEach(rec => {
    getNdcPropertiesForRxcui(rec.rxcui)
      .catch(() => [])
      .then(entries => {
        if (runId !== activeRunId || cancel.cancelled) return;
        snapshot.ndcs.set(rec.rxcui, Array.isArray(entries) ? entries : []);
        done++;
        completionTs.push(Date.now());
        lastName = rec.name ? `${rec.name} (RxCUI ${rec.rxcui})` : `RxCUI ${rec.rxcui}`;
        tick();
        if (done >= keptToProcess.length) resolveAllDone();
      });
  });

  await Promise.race([allDone, cancel.promise]);
  clearInterval(visualTimer);
  if (runId !== activeRunId) return;

  const wasCancelled = cancel.cancelled;
  if (wasCancelled) {
    visualPct = Math.min(95, (done / keptToProcess.length) * 100);
    progCard.update({
      status: `Stopped at ${done} of ${keptToProcess.length}. Partial NDC data available.`,
      eta: "", lastName: "", stopped: true, fillPct: visualPct,
    });
    progCard.finish({ stopped: true });
  } else {
    progCard.update({
      status: `Fetched NDCs for ${done} of ${keptToProcess.length} RxCUI${keptToProcess.length === 1 ? "" : "s"}.`,
      eta: "", lastName: "", fillPct: 100,
    });
    progCard.finish({ stopped: false });
  }

  snapshot.extensionRan = true;
  snapshot.view = "ndc";
  if (snapshot._trimmedFrom && snapshot._trimmedTo) {
    snapshot.ndcTrimNote = `Showing NDCs for the first ${snapshot._trimmedTo} of ${snapshot._trimmedFrom} verified RxCUIs. Refine the query to cover the remainder.`;
  }
  renderResultsInCurrentView(refs);
}

// ---------------- NDC-level view ----------------

function renderNdcLevelView(refs) {
  if (!currentRun) return;
  const snapshot = currentRun;

  // 1. Summary bar + view toggle + CSV download.
  const section = document.createElement("section");
  section.className = "summary-bar";

  const fetchedRxcuis = snapshot.ndcs.size;
  const totalRows = [...snapshot.ndcs.values()].reduce((a, b) => a + Math.max(1, b.length), 0);
  const summaryText = `${snapshot.atc} · ${fetchedRxcuis} RxCUI${fetchedRxcuis === 1 ? "" : "s"} extended · ${totalRows} NDC row${totalRows === 1 ? "" : "s"}.`;
  section.appendChild(el("p", { class: "summary-text" }, summaryText));

  if (snapshot.ndcTrimNote) {
    section.appendChild(el("p", { class: "summary-trim-note" }, snapshot.ndcTrimNote));
  }

  // Action row: view toggle + CSV download.
  const actions = el("div", { class: "action-row" });
  actions.appendChild(buildViewToggle(refs, "ndc"));
  const stamp = todayStamp();
  const fnameSafe = snapshot.atc.replace(/[^A-Z0-9]/g, "");
  const csvBtn = el("button", { type: "button", class: "btn-primary" }, `⬇ Download CSV (three-level, ${totalRows} row${totalRows === 1 ? "" : "s"})`);
  csvBtn.addEventListener("click", () => {
    downloadCsv(`medcode-mode3-with-ndcs-${fnameSafe}-${stamp}.csv`, buildThreeLevelCsv(snapshot));
  });
  actions.appendChild(csvBtn);
  section.appendChild(actions);
  refs.summary.appendChild(section);

  // 2. The three-level table.
  refs.table.appendChild(buildNdcLevelTable(snapshot));
}

function buildViewToggle(refs, currentView) {
  const wrap = el("div", { class: "view-toggle", "aria-label": "View" });
  wrap.appendChild(el("span", { class: "view-toggle-label" }, "View:"));
  const opts = [
    { key: "rxcui", label: "RxCUI-level" },
    { key: "ndc",   label: "NDC-level" },
  ];
  for (const o of opts) {
    const btn = el("button", {
      type: "button",
      class: "view-toggle-btn" + (o.key === currentView ? " is-active" : ""),
      "aria-pressed": o.key === currentView ? "true" : "false",
    }, o.label);
    btn.addEventListener("click", () => {
      if (!currentRun || currentRun.view === o.key) return;
      currentRun.view = o.key;
      renderResultsInCurrentView(refs);
    });
    wrap.appendChild(btn);
  }
  return wrap;
}

function buildNdcLevelTable(snapshot) {
  const card = el("section", { class: "card ndc-table-card", "aria-label": "Three-level mapping table" });
  const tableWrap = el("div", { class: "batch-table-wrap" });
  const table = el("table", { class: "ndc-table" });

  const thead = el("thead");
  const COLUMNS = [
    { key: "atc",      label: "ATC" },
    { key: "atcName",  label: "ATC name" },
    { key: "rxcui",    label: "RxCUI" },
    { key: "drugName", label: "Drug" },
    { key: "ndc11",    label: "NDC (11-digit)" },
    { key: "labeler",  label: "Labeler" },
    { key: "route",    label: "Route" },
    { key: "status",   label: "Member status" },
  ];
  const headerRow = el("tr");
  for (const c of COLUMNS) {
    headerRow.appendChild(el("th", { scope: "col", class: `cell-${c.key}` }, c.label));
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = el("tbody");
  table.appendChild(tbody);

  // Best ATC class name we can put in the on-screen "ATC name" column.
  // L5-byId returns empty, so for L5 queries we fall back to the resolver's
  // substance name on KEPT rows (resolvedAtc === query on those rows).
  const atcNameFor = (rec) => {
    if (snapshot.className) return snapshot.className;
    if (rec && rec.resolvedAtc === snapshot.atc && rec.resolvedAtcName) return rec.resolvedAtcName;
    return "";
  };

  // One row per (extendable record × NDC). Extendable = any row with a real
  // RxCUI (KEPT or ROUTE_MISMATCH). RxCUIs whose record has no NDCs still
  // emit one row with an empty NDC cell and a soft note, so they're not
  // silently dropped from the view.
  for (const rec of snapshot.records) {
    if (!isExtendable(rec)) continue;
    const entries = snapshot.ndcs.get(rec.rxcui) || [];
    const aName = atcNameFor(rec);
    if (entries.length === 0) {
      const tr = el("tr", { class: "ndc-row", "data-no-ndcs": "true" });
      tr.appendChild(el("td", { class: "cell-atc" }, el("span", { class: "code" }, snapshot.atc)));
      tr.appendChild(el("td", { class: "cell-atcName" }, aName || "–"));
      tr.appendChild(el("td", { class: "cell-rxcui" }, el("span", { class: "code" }, rec.rxcui)));
      tr.appendChild(el("td", { class: "cell-drugName" }, rec.name || "(unknown)"));
      tr.appendChild(el("td", { class: "cell-ndc11 cell-empty" }, "no active NDCs"));
      tr.appendChild(el("td", { class: "cell-labeler" }, "–"));
      tr.appendChild(el("td", { class: "cell-route" }, rec.route || "–"));
      tr.appendChild(el("td", { class: "cell-status" }, rec.status));
      tbody.appendChild(tr);
      continue;
    }
    for (const e of entries) {
      const tr = el("tr", { class: "ndc-row" });
      tr.appendChild(el("td", { class: "cell-atc" }, el("span", { class: "code" }, snapshot.atc)));
      tr.appendChild(el("td", { class: "cell-atcName" }, aName || "–"));
      tr.appendChild(el("td", { class: "cell-rxcui" }, el("span", { class: "code" }, rec.rxcui)));
      tr.appendChild(el("td", { class: "cell-drugName" }, rec.name || "(unknown)"));
      tr.appendChild(el("td", { class: "cell-ndc11" }, el("span", { class: "code" }, e.ndc11 || "")));
      tr.appendChild(el("td", { class: "cell-labeler" }, e.labeler || "–"));
      tr.appendChild(el("td", { class: "cell-route" }, rec.route || "–"));
      tr.appendChild(el("td", { class: "cell-status" }, rec.status));
      tbody.appendChild(tr);
    }
  }

  tableWrap.appendChild(table);
  card.appendChild(tableWrap);
  return card;
}

function buildThreeLevelCsv(snapshot) {
  const rows = [[
    "query_atc", "query_atc_name",
    "resolved_atc", "resolved_atc_name",
    "rxcui", "rxcui_name", "rxcui_tty", "route",
    "ndc_11", "ndc_10", "labeler", "packaging",
    "marketing_category", "marketing_status",
    "fda_approval_number",
    "marketing_start_date", "first_marketed_year",
    "status",
  ]];
  // Best available class name for the queried ATC. For L5 inputs, RxClass's
  // byId returns nothing, so the breadcrumb's name stays empty — fall back to
  // the resolver's substance name when the resolved code matches the query.
  const queryAtcName = (rec) => {
    if (snapshot.className) return snapshot.className;
    if (rec && rec.resolvedAtc === snapshot.atc && rec.resolvedAtcName) return rec.resolvedAtcName;
    return "";
  };
  for (const rec of snapshot.records) {
    if (!isExtendable(rec)) continue;
    const entries = snapshot.ndcs.get(rec.rxcui) || [];
    const qName = queryAtcName(rec);
    if (entries.length === 0) {
      rows.push([
        snapshot.atc, qName,
        rec.resolvedAtc || "", rec.resolvedAtcName || "",
        rec.rxcui, rec.name || "", rec.tty || "", rec.route || "",
        "", "", "", "",
        "", "",
        "",
        "", "",
        rec.status,
      ]);
      continue;
    }
    for (const e of entries) {
      rows.push([
        snapshot.atc, qName,
        rec.resolvedAtc || "", rec.resolvedAtcName || "",
        rec.rxcui, rec.name || "", rec.tty || "", rec.route || "",
        e.ndc11 || "", e.ndc10 || "", e.labeler || "", e.packaging || "",
        e.marketingCategory || "", e.marketingStatus || "",
        e.fdaApprovalNumber || "",
        e.marketingStartDate || "", yearFromYyyymmdd(e.marketingStartDate),
        rec.status,
      ]);
    }
  }
  return rows;
}

function yearFromYyyymmdd(s) {
  if (!s) return "";
  const m = /^(\d{4})/.exec(String(s));
  return m ? m[1] : "";
}

// Tiny DOM helper, scoped to Mode 3 (mirrors the one in Mode 5).
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
