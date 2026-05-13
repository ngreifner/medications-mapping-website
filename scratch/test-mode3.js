// scratch/test-mode3.js — Node verification of Mode 3 logic.
// Mirrors the rewritten mode3-atc-to-rxcuis.js: fetches the L4 parent's
// members (ATCPROD primary, ATC fallback), verifies each via the resolver,
// then for L5 queries filters to matched/unresolved rows; for L4 queries
// groups by the resolver's first kept L5 code.

const memStore = new Map();
globalThis.localStorage = {
  getItem: (k) => (memStore.has(k) ? memStore.get(k) : null),
  setItem: (k, v) => { memStore.set(k, String(v)); },
  removeItem: (k) => { memStore.delete(k); },
  clear: () => { memStore.clear(); },
  key: (i) => [...memStore.keys()][i] ?? null,
  get length() { return memStore.size; },
};

const { detectCodeType, atcLevel } = await import("../js/code-detection.js");
const { atcLevelCodes, ATC_LEVEL1 } = await import("../js/atc-anatomy.js");
const {
  getClassMembers,
  getAtcClassName,
  getProperties,
  getDfgs,
} = await import("../js/rxnav-client.js");
const { convertRxcuiToAtc } = await import("../js/atc-resolver.js");
const { resolveRoute } = await import("../js/filter-engine.js");
const { rowsToCsv } = await import("../js/csv-export.js");

async function buildBreadcrumb(atc) {
  const prefixes = atcLevelCodes(atc);
  const out = [];
  for (let i = 0; i < prefixes.length; i++) {
    const p = prefixes[i];
    let name = "";
    if (i === 0) {
      name = (ATC_LEVEL1[p] || {}).title || "";
    } else {
      try { name = (await getAtcClassName(p)) || ""; } catch {}
    }
    out.push({ atc: p, name });
  }
  return out;
}

async function verifyMember(atc, level, member) {
  let result, props, dfgs;
  try {
    [result, props, dfgs] = await Promise.all([
      convertRxcuiToAtc(member.rxcui),
      getProperties(member.rxcui),
      getDfgs(member.rxcui),
    ]);
  } catch {
    return { rxcui: member.rxcui, status: "NEEDS_REVIEW", reason: "Network error", keptL5: [], ndcs: [], name: "", tty: member.tty || "", route: "", resolvedAtc: "", resolvedAtcName: "" };
  }
  const keptL5 = ((result && result.codes) || []).filter(c => (c.code || "").length === 7);
  let status, reason = "";
  if (!props || !props.found) { status = "NEEDS_REVIEW"; reason = "RXCUI not found"; }
  else if (keptL5.length === 0) { status = "NEEDS_REVIEW"; reason = "No L5 resolved"; }
  else {
    const matches = keptL5.some(c => level === 5 ? c.code === atc : c.code.startsWith(atc));
    status = matches ? "KEPT" : "ROUTE_MISMATCH";
    if (!matches) reason = `resolver returned ${keptL5.map(c => c.code).join(",")}`;
  }
  const matchedCode = keptL5.find(c => level === 5 ? c.code === atc : c.code.startsWith(atc));
  const primaryCode = matchedCode || keptL5[0] || null;

  let route = "";
  if (result && result.status === "INGREDIENT_LEVEL") route = "ingredient";
  else { const r = resolveRoute(dfgs); route = (r && r !== "unknown") ? r : ""; }

  let groupKey;
  if (status === "KEPT") groupKey = matchedCode ? matchedCode.code : primaryCode ? primaryCode.code : "(unresolved)";
  else if (status === "ROUTE_MISMATCH") groupKey = primaryCode ? primaryCode.code : "(unresolved)";
  else groupKey = "(unresolved)";

  return {
    rxcui: member.rxcui,
    sourceId: member.sourceId, sourceName: member.sourceName,
    name: (props && props.name) || "",
    tty: (props && props.tty) || member.tty || "",
    status, reason, keptL5, groupKey, route,
    resolvedAtc: primaryCode ? primaryCode.code : "",
    resolvedAtcName: primaryCode ? (primaryCode.name || "") : "",
  };
}

async function runQuery(atc) {
  console.log(`\n${"═".repeat(74)}`);
  console.log(`QUERY: ${atc}`);
  console.log(`${"═".repeat(74)}`);

  const upper = String(atc || "").trim().toUpperCase();
  const detected = detectCodeType(upper);
  if (detected.type !== "ATC") {
    console.log(`  ✗ Validation: not a valid ATC format → amber error in UI, no fetch.`);
    return;
  }
  const lvl = atcLevel(upper);
  if (lvl !== 4 && lvl !== 5) {
    console.log(`  ✗ Validation: Level ${lvl} — Mode 3 requires Level 4 or 5.`);
    return;
  }

  const crumbs = await buildBreadcrumb(upper);
  console.log("  Breadcrumb:");
  console.log("    " + crumbs.map(c => `${c.atc} (${c.name || "?"})`).join(" › "));

  const fetchClassId = lvl === 5 ? upper.slice(0, 5) : upper;
  let members = await getClassMembers(fetchClassId, "ATCPROD").catch(() => []);
  let source = "ATCPROD";
  if (members.length === 0) {
    const fb = await getClassMembers(fetchClassId, "ATC").catch(() => []);
    if (fb.length > 0) { members = fb; source = "ATC"; }
  }
  console.log(`  Fetched ${members.length} members for ${fetchClassId} via ${source}`);
  if (members.length === 0) { console.log("  ✗ No members."); return; }

  if (lvl === 4) console.log(`  ℹ L4 gate would show: "${upper} has ${members.length} members — Continue?"`);

  // Verify every member
  const records = await Promise.all(members.map(m => verifyMember(upper, lvl, m)));

  // After Enhancement 1: all members are visible (no L5-specific filter).
  const visible = records;

  console.log(`  Verified: ${records.length}; visible: ${visible.length}`);

  if (visible.length === 0) {
    console.log(`  ⚠ No members resolved to ${upper}.`);
    return;
  }

  if (lvl === 4) {
    const groups = new Map();
    for (const r of visible) {
      if (!groups.has(r.groupKey)) groups.set(r.groupKey, []);
      groups.get(r.groupKey).push(r);
    }
    const keys = [...groups.keys()].sort((a, b) => {
      const aIn = a.startsWith(upper);
      const bIn = b.startsWith(upper);
      if (aIn !== bIn) return aIn ? -1 : 1;
      if (a === "(unresolved)") return 1;
      if (b === "(unresolved)") return -1;
      return a.localeCompare(b);
    });
    console.log(`\n  Grouped by resolver's L5 (default for L4) — ${keys.length} groups:`);
    for (const key of keys) {
      const rs = groups.get(key);
      const kept = rs.filter(r => r.status === "KEPT").length;
      const inClass = key.startsWith(upper) || key === "(unresolved)" ? "" : "  ⚠ out-of-class";
      console.log(`    ▼ ${key}${inClass} — ${kept}/${rs.length} kept`);
      const sample = rs.slice(0, 3);
      for (const r of sample) {
        const flag = { KEPT: "🟢", ROUTE_MISMATCH: "🔴", NEEDS_REVIEW: "🟡" }[r.status];
        console.log(`        ${flag} ${r.status.padEnd(14)} ${r.rxcui.padEnd(9)} ${(r.tty || "—").padEnd(5)} ${(r.name || r.reason || "—").slice(0, 50)}  NDCs: ${(r.ndcs || []).length}`);
      }
      if (rs.length > 3) console.log(`        … (${rs.length - 3} more)`);
    }
  } else {
    console.log(`\n  Members table (L5 query):`);
    for (const r of visible) {
      const flag = { KEPT: "🟢", ROUTE_MISMATCH: "🔴", NEEDS_REVIEW: "🟡" }[r.status];
      console.log(`    ${flag} ${r.status.padEnd(14)} ${r.rxcui.padEnd(9)} ${(r.tty || "—").padEnd(5)} ${(r.name || r.reason || "—").slice(0, 60)}  NDCs: ${(r.ndcs || []).length}`);
    }
  }

  // Summary
  let kept = 0, mismatch = 0, review = 0, totalNdcs = 0;
  for (const r of visible) {
    if (r.status === "KEPT") kept++;
    else if (r.status === "ROUTE_MISMATCH") mismatch++;
    else review++;
    totalNdcs += (r.ndcs || []).length;
  }
  const className = (crumbs[crumbs.length - 1] || {}).name || "";
  console.log(`\n  Summary:`);
  console.log(`    ${upper}${className ? ` (${className})` : ""} — ${visible.length} of ${members.length} members match · ${kept} kept · ${mismatch} mismatch · ${review} need review · ${totalNdcs} active NDCs. Source: ${source}.`);
}

// ----- CSV-shape builders (mirror mode3-atc-to-rxcuis.js exports) -----
function buildCompactCsv(records, queriedClassName) {
  const rows = [["rxcui", "tty", "drug_name", "route", "resolved_atc", "atc_class_name", "ndc_count"]];
  for (const rec of records) {
    if (rec.status !== "KEPT") continue;
    rows.push([rec.rxcui, rec.tty || "", rec.name || "", rec.route || "", rec.resolvedAtc || "", rec.resolvedAtcName || queriedClassName || "", String((rec.ndcs || []).length)]);
  }
  return rows;
}
function buildExplodedCsv(records, queriedClassName) {
  const rows = [["rxcui", "tty", "drug_name", "route", "resolved_atc", "atc_class_name", "ndc_code", "ndc_status"]];
  for (const rec of records) {
    if (rec.status !== "KEPT") continue;
    const base = [rec.rxcui, rec.tty || "", rec.name || "", rec.route || "", rec.resolvedAtc || "", rec.resolvedAtcName || queriedClassName || ""];
    const ndcs = Array.isArray(rec.ndcs) ? rec.ndcs : [];
    if (ndcs.length === 0) rows.push([...base, "", "no_active_ndcs"]);
    else for (const ndc of ndcs) rows.push([...base, ndc, "active"]);
  }
  return rows;
}
function buildAuditCsv(records, queriedAtc) {
  const rows = [["rxcui", "status", "tty", "drug_name", "route", "queried_atc", "resolved_atc", "ndc_count", "reason"]];
  for (const rec of records) {
    rows.push([rec.rxcui, rec.status, rec.tty || "", rec.name || "", rec.route || "", queriedAtc, rec.resolvedAtc || "", String(Array.isArray(rec.ndcs) ? rec.ndcs.length : 0), rec.reason || ""]);
  }
  return rows;
}

async function runCsvSizingTest(atc) {
  console.log(`\n${"━".repeat(74)}`);
  console.log(`CSV SIZING — ${atc}`);
  console.log(`${"━".repeat(74)}`);
  const upper = String(atc).toUpperCase();
  const lvl = atcLevel(upper);
  const fetchClassId = lvl === 5 ? upper.slice(0, 5) : upper;
  let members = await getClassMembers(fetchClassId, "ATCPROD").catch(() => []);
  if (members.length === 0) {
    const fb = await getClassMembers(fetchClassId, "ATC").catch(() => []);
    if (fb.length > 0) members = fb;
  }
  const records = await Promise.all(members.map(m => verifyMember(upper, lvl, m)));
  const queriedClassName = (await buildBreadcrumb(upper))[atcLevelCodes(upper).length - 1]?.name || "";

  const compact = buildCompactCsv(records, queriedClassName);
  const exploded = buildExplodedCsv(records, queriedClassName);
  const audit = buildAuditCsv(records, upper);

  const counts = { KEPT: 0, ROUTE_MISMATCH: 0, NEEDS_REVIEW: 0 };
  for (const r of records) counts[r.status]++;
  console.log(`  Members: ${records.length} (KEPT=${counts.KEPT}, ROUTE_MISMATCH=${counts.ROUTE_MISMATCH}, NEEDS_REVIEW=${counts.NEEDS_REVIEW})`);
  console.log(`  Compact CSV:  ${compact.length - 1} data rows (KEPT only)`);
  console.log(`  Exploded CSV: ${exploded.length - 1} data rows (KEPT × NDCs)`);
  console.log(`  Audit CSV:    ${audit.length - 1} data rows (all members)`);

  // Sample first 3 rows of each
  console.log(`\n  --- Compact, first 3 data rows ---`);
  console.log(rowsToCsv(compact.slice(0, 4)));
  console.log(`\n  --- Exploded, first 3 data rows ---`);
  console.log(rowsToCsv(exploded.slice(0, 4)));
  console.log(`\n  --- Audit, first 5 data rows (showing mix of statuses) ---`);
  console.log(rowsToCsv([audit[0], ...audit.slice(1).sort((a, b) => {
    // Sort to surface a mix: KEPT first, then non-KEPT
    const aStat = a[1], bStat = b[1];
    if (aStat === bStat) return 0;
    return aStat === "KEPT" ? -1 : 1;
  }).slice(0, 5)]));

  // Cross-check: pick first KEPT row, verify its NDC list size matches the
  // count in the compact row, matches the row count contribution in exploded.
  const firstKept = records.find(r => r.status === "KEPT" && (r.ndcs || []).length > 0);
  if (firstKept) {
    const ndcs = firstKept.ndcs;
    const explodedForThisRxcui = exploded.slice(1).filter(r => r[0] === firstKept.rxcui).length;
    console.log(`\n  Cross-check (RXCUI ${firstKept.rxcui}):`);
    console.log(`    Mode 3 detail-view would show: ${ndcs.length} NDCs`);
    console.log(`    Compact CSV ndc_count column:   ${ndcs.length}`);
    console.log(`    Exploded CSV row count:         ${explodedForThisRxcui}`);
    console.log(`    Match: ${ndcs.length === explodedForThisRxcui ? "✓" : "✗"}`);
    console.log(`    First 3 NDCs in detail view:    ${ndcs.slice(0, 3).join(", ")}`);
  }
}

// ----- run -----
const arg = process.argv[2];
if (arg === "--csv") {
  // Just the CSV sizing test on C10AA05 (per the verification spec)
  await runCsvSizingTest("C10AA05");
} else if (arg) {
  await runQuery(arg);
} else {
  await runCsvSizingTest("C10AA05");  // primary CSV verification target
}
