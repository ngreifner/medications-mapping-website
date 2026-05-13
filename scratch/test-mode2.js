// scratch/test-mode2.js — Node verification of Mode 2 batch logic.
//
// Re-implements mode2-batch-forward.js's status classification, parser, and
// CSV builders without the DOM, so we can verify badges + CSV output against
// the real RxNav resolver. Mode 1 logic (the row-expand) is exercised
// indirectly: each detail render relies on the same `convertRxcuiToAtc`
// result + `props` + `dfgs` + `ingredientATC` tuple we fetch here, so if all
// four resolve OK in this script, the browser-side row-expand will too.
//
// Usage: node scratch/test-mode2.js

const memStore = new Map();
globalThis.localStorage = {
  getItem: (k) => (memStore.has(k) ? memStore.get(k) : null),
  setItem: (k, v) => { memStore.set(k, String(v)); },
  removeItem: (k) => { memStore.delete(k); },
  clear: () => { memStore.clear(); },
  key: (i) => [...memStore.keys()][i] ?? null,
  get length() { return memStore.size; },
};

const { convertRxcuiToAtc } = await import("../js/atc-resolver.js");
const { getProperties, getDfgs, getIngredientAtcClasses } = await import("../js/rxnav-client.js");
const { resolveRoute, classifyAtcForRoute } = await import("../js/filter-engine.js");
const { detectCodeType } = await import("../js/code-detection.js");
const { rowsToCsv } = await import("../js/csv-export.js");

// ----- the 10-RXCUI test list -----
const INPUT_LIST = [
  "1797907",   // multi-route SCD — fluticasone nasal spray
  "2702393",   // multi-route SCD — timolol hemihydrate ophthalmic
  "311878",    // multi-route SCD — mupirocin 0.02 MG/MG Nasal Ointment
  "1737778",   // multi-route SCD — lidocaine 0.04 MG/MG Medicated Patch (topical)
  "617310",    // single-route SCD — atorvastatin oral
  "197361",    // single-route SCD — amlodipine oral
  "689",       // ingredient — aminophylline IN (single-route)
  "41126",     // ingredient — fluticasone IN (multi-route)
  "99999999",  // 8-digit, not in RxNav — exercises the "not found" path
  "asdf",      // invalid token
  "1797907",   // duplicate of #1
];

// ----- parsing + dedupe (mirrors parseTokens in mode2) -----
function parseTokens(tokens) {
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

// ----- per-row processing (mirrors processOne in mode2) -----
async function processOne(rxcui) {
  if (!isLikelyRxcui(rxcui)) {
    return {
      rxcui, status: "NEEDS_REVIEW", name: "", tty: "", route: "",
      kept: [], removed: 0,
      reason: "Token doesn't look like an RXCUI",
    };
  }

  let props, dfgs, ingredientATC, result;
  try {
    [props, dfgs, ingredientATC, result] = await Promise.all([
      getProperties(rxcui),
      getDfgs(rxcui),
      getIngredientAtcClasses(rxcui),
      convertRxcuiToAtc(rxcui),
    ]);
  } catch (e) {
    return {
      rxcui, status: "NEEDS_REVIEW", name: "", tty: "", route: "",
      kept: [], removed: 0, reason: "Network error reaching RxNav",
    };
  }

  if (!props || !props.found) {
    return {
      rxcui, status: "NEEDS_REVIEW", name: "", tty: "", route: "",
      kept: [], removed: 0, reason: `RXCUI ${rxcui} not found in RxNav`,
    };
  }

  const route = result.status === "INGREDIENT_LEVEL" ? "" : resolveRoute(dfgs);
  const routeOut = (route && route !== "unknown") ? route
                  : (result.status === "INGREDIENT_LEVEL" ? "ingredient" : "");

  let removed = 0;
  if (route && route !== "unknown" && Array.isArray(ingredientATC)) {
    for (const c of ingredientATC) {
      if ((c.classId || "").length !== 5) continue;
      const v = classifyAtcForRoute(c.classId, route);
      if (!v.kept) removed++;
    }
  }

  const keptL5 = (Array.isArray(result.codes) ? result.codes : [])
    .filter(c => (c.code || "").length === 7);

  let status, reason = "";
  if (result.status === "INGREDIENT_LEVEL") {
    if (keptL5.length === 0)      { status = "NEEDS_REVIEW"; reason = "No ATC mapping stored for this ingredient"; }
    else if (keptL5.length === 1) { status = "UNCHANGED"; }
    else                          { status = "LEGIT_MULTI"; }
  } else if (result.status === "KEEP") {
    if (keptL5.length === 0)      { status = "NEEDS_REVIEW"; reason = "Level 5 ATC could not be resolved (L4 fallback only)"; }
    else if (removed > 0)         { status = "CLEAN_FIX"; }
    else                          { status = "UNCHANGED"; }
  } else {
    status = "NEEDS_REVIEW";
    reason = "No ATC mapping available";
  }

  return {
    rxcui, status,
    name: props.name || "",
    tty: props.tty || "",
    route: routeOut,
    kept: keptL5,
    removed,
    reason,
  };
}

// ----- CSV builders (mirror downloadCleaned + downloadAudit) -----
function buildCleanedRows(records) {
  const rows = [["rxcui", "drug_name", "tty", "route", "kept_atc", "kept_atc_name"]];
  for (const rec of records) {
    if (rec.status === "NEEDS_REVIEW") continue;
    if (!rec.kept || rec.kept.length === 0) continue;
    for (const k of rec.kept) {
      rows.push([rec.rxcui, rec.name, rec.tty, rec.route, k.code, k.name || ""]);
    }
  }
  return rows;
}
function buildAuditRows(records, duplicates) {
  const rows = [[
    "rxcui", "status", "drug_name", "tty", "route",
    "kept_count", "kept_atcs", "kept_atc_names", "removed_count",
    "reason", "duplicate_in_input",
  ]];
  for (const rec of records) {
    rows.push([
      rec.rxcui, rec.status, rec.name, rec.tty, rec.route,
      String((rec.kept || []).length),
      (rec.kept || []).map(k => k.code).join(";"),
      (rec.kept || []).map(k => k.name || "").join(";"),
      String(rec.removed || 0),
      rec.reason || "",
      duplicates.has(rec.rxcui) ? "true" : "false",
    ]);
  }
  return rows;
}

// ----- run -----
console.log(`\nMode 2 verification — ${INPUT_LIST.length} input tokens\n`);
console.log(`Raw input list:\n  ${INPUT_LIST.join("\n  ")}\n`);

const { ordered, duplicates } = parseTokens(INPUT_LIST);
console.log(`After dedupe: ${ordered.length} unique tokens`);
console.log(`Duplicates removed: ${duplicates.size}  [${[...duplicates].join(", ")}]\n`);

const records = await Promise.all(ordered.map(processOne));

// ----- table dump -----
console.log("Results table:");
console.log("─".repeat(110));
console.log(["STATUS".padEnd(14), "RXCUI".padEnd(11), "DRUG".padEnd(34), "ROUTE".padEnd(12), "KEPT".padEnd(22), "REMOVED"].join(" │ "));
console.log("─".repeat(110));
for (const r of records) {
  const dupTag = duplicates.has(r.rxcui) ? " (dup)" : "";
  const kept = r.kept.length > 0 ? r.kept.map(k => k.code).join(",") : "—";
  const name = (r.name || r.reason || "—").slice(0, 32);
  console.log([
    r.status.padEnd(14),
    (r.rxcui + dupTag).padEnd(11),
    name.padEnd(34),
    (r.route || "—").padEnd(12),
    kept.padEnd(22),
    String(r.removed),
  ].join(" │ "));
}
console.log("─".repeat(110));

// ----- summary counts -----
const counts = { CLEAN_FIX: 0, UNCHANGED: 0, LEGIT_MULTI: 0, NEEDS_REVIEW: 0 };
for (const r of records) counts[r.status]++;
console.log("\nFilter chip counts:");
for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v}`);

// ----- CSV samples -----
const cleanedRows = buildCleanedRows(records);
const auditRows   = buildAuditRows(records, duplicates);

console.log(`\nCleaned CSV (${cleanedRows.length - 1} data rows total) — first 5:`);
console.log(rowsToCsv(cleanedRows.slice(0, 6)));

console.log(`\nAudit CSV (${auditRows.length - 1} data rows total) — first 10:`);
console.log(rowsToCsv(auditRows.slice(0, 11)));
