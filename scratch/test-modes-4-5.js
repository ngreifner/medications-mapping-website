// scratch/test-modes-4-5.js — Node verification of Modes 4 + 5.

const memStore = new Map();
globalThis.localStorage = {
  getItem: (k) => (memStore.has(k) ? memStore.get(k) : null),
  setItem: (k, v) => { memStore.set(k, String(v)); },
  removeItem: (k) => { memStore.delete(k); },
  clear: () => { memStore.clear(); },
  key: (i) => [...memStore.keys()][i] ?? null,
  get length() { return memStore.size; },
};

const { detectCodeType } = await import("../js/code-detection.js");
const { getProperties, getNdcPropertiesForRxcui } = await import("../js/rxnav-client.js");
const { rowsToCsv } = await import("../js/csv-export.js");

// ---------------- Mode 4 simulation ----------------
async function simulateMode4(rxcui) {
  console.log(`\n${"─".repeat(74)}`);
  console.log(`MODE 4 — RXCUI ${rxcui}`);
  console.log(`${"─".repeat(74)}`);

  if (detectCodeType(rxcui).type !== "RXCUI") {
    console.log("  → invalid format, amber error card, no fetch");
    return;
  }

  const [props, entries] = await Promise.all([getProperties(rxcui), getNdcPropertiesForRxcui(rxcui)]);
  if (!props.found) {
    console.log("  → RXCUI not found, red error card");
    return;
  }
  console.log(`  Drug: ${props.name}  (TTY=${props.tty})`);
  if (entries.length === 0) {
    const isIngredient = ["IN", "MIN", "PIN"].includes(props.tty);
    console.log(`  → 0 active NDCs ${isIngredient ? "(ingredient note shown)" : "(generic info card)"}`);
    return;
  }
  console.log(`  Active NDCs: ${entries.length}`);

  // Show first 3 sorted by labeler ASC (default)
  const sorted = [...entries].sort((a, b) => (a.labeler || "").localeCompare(b.labeler || ""));
  console.log("  First 3 by labeler:");
  for (const e of sorted.slice(0, 3)) {
    console.log(`    ${e.ndc11}  ${e.ndc10}  ${(e.labeler || "—").slice(0, 28).padEnd(28)}  ${(e.packaging || "—").slice(0, 32)}  ${e.marketingCategory}`);
  }

  // Build a small CSV sample
  const csvRows = [["rxcui", "tty", "drug_name", "ndc_code", "ndc_10", "labeler", "packaging", "marketing_category", "fda_approval_number"]];
  for (const e of sorted.slice(0, 3)) {
    csvRows.push([rxcui, props.tty, props.name, e.ndc11, e.ndc10, e.labeler, e.packaging, e.marketingCategory, e.fdaApprovalNumber]);
  }
  console.log("  CSV preview (first 3 rows):");
  console.log(rowsToCsv(csvRows));
}

// ---------------- Mode 5 simulation ----------------
async function simulateMode5(rxcuis) {
  console.log(`\n${"═".repeat(74)}`);
  console.log(`MODE 5 — Batch of ${rxcuis.length} RXCUIs`);
  console.log(`${"═".repeat(74)}`);

  // Dedupe
  const seen = new Set();
  const ordered = [];
  for (const r of rxcuis) {
    if (seen.has(r)) continue;
    seen.add(r); ordered.push(r);
  }
  console.log(`Input: ${rxcuis.join(", ")}`);
  console.log(`After dedupe: ${ordered.length}`);

  // Per-RXCUI processing
  const records = await Promise.all(ordered.map(async (rxcui) => {
    const rec = { rxcui, status: "PENDING", tty: "", name: "", entries: [], reason: "" };
    if (detectCodeType(rxcui).type !== "RXCUI") {
      rec.status = "NEEDS_REVIEW"; rec.reason = "Not an RXCUI"; return rec;
    }
    const [props, entries] = await Promise.all([getProperties(rxcui), getNdcPropertiesForRxcui(rxcui)]);
    if (!props.found) {
      rec.status = "NEEDS_REVIEW"; rec.reason = "Not in RxNav"; return rec;
    }
    rec.tty = props.tty; rec.name = props.name; rec.entries = entries;
    rec.status = entries.length === 0 ? "NO_NDCS" : "OK";
    return rec;
  }));

  // Table
  console.log("\nResults table:");
  console.log("─".repeat(110));
  console.log(["STATUS", "RXCUI", "TTY", "DRUG", "NDCs"].map(s => s.padEnd(15)).join(""));
  for (const r of records) {
    const flag = { OK: "🟢", NO_NDCS: "🔵", NEEDS_REVIEW: "🟡" }[r.status] || "?";
    console.log(`  ${flag} ${r.status.padEnd(14)} ${String(r.rxcui).padEnd(11)} ${(r.tty || "—").padEnd(5)} ${(r.name || r.reason || "—").slice(0, 50).padEnd(52)} ${String(r.entries.length || 0)}`);
  }
  console.log("─".repeat(110));

  // Status counts
  const counts = { OK: 0, NO_NDCS: 0, NEEDS_REVIEW: 0 };
  let totalNdcs = 0;
  for (const r of records) {
    counts[r.status]++;
    if (r.status === "OK") totalNdcs += r.entries.length;
  }
  console.log(`Summary: ${counts.OK} OK · ${counts.NO_NDCS} no NDCs · ${counts.NEEDS_REVIEW} need review · ${totalNdcs} total NDCs`);

  // Compact CSV sample
  const compact = [["rxcui", "tty", "drug_name", "active_ndc_count", "status"]];
  for (const r of records) compact.push([r.rxcui, r.tty, r.name, String(r.entries.length), r.status]);
  console.log("\nCompact CSV (first 5 rows):");
  console.log(rowsToCsv(compact.slice(0, 6)));

  // Exploded CSV sample
  const exploded = [["rxcui", "tty", "drug_name", "ndc_code", "ndc_10", "labeler", "packaging", "marketing_category", "fda_approval_number"]];
  for (const r of records) {
    if (r.status !== "OK") continue;
    for (const e of r.entries) {
      exploded.push([r.rxcui, r.tty, r.name, e.ndc11, e.ndc10, e.labeler, e.packaging, e.marketingCategory, e.fdaApprovalNumber]);
    }
  }
  console.log(`\nExploded CSV: ${exploded.length - 1} data rows total. First 3:`);
  console.log(rowsToCsv(exploded.slice(0, 4)));
}

// ---------------- run ----------------
await simulateMode4("259255");    // atorvastatin 80 MG — many NDCs
await simulateMode4("1797907");   // fluticasone nasal spray — smaller
await simulateMode4("689");       // aminophylline IN — expect 0 NDCs
await simulateMode4("99999999");  // not found

await simulateMode5(["259255", "617310", "1797907", "689", "99999999"]);
