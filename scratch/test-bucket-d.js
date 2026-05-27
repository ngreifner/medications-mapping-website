// scratch/test-bucket-d.js — verify Phase 2H Bucket D additions.
// Part A: direct findCuratedCombination unit tests (no network).
// Part B: end-to-end resolver tests against live active products.
//
// Usage: node scratch/test-bucket-d.js

const memStore = new Map();
globalThis.localStorage = {
  getItem: (k) => (memStore.has(k) ? memStore.get(k) : null),
  setItem: (k, v) => { memStore.set(k, String(v)); },
  removeItem: (k) => { memStore.delete(k); },
  clear: () => { memStore.clear(); },
  key: (i) => [...memStore.keys()][i] ?? null,
  get length() { return memStore.size; },
};

const { findCuratedCombination } = await import("../js/atc-combinations-curated.js");
const { convertRxcuiToAtc } = await import("../js/atc-resolver.js");
const { getProperties } = await import("../js/rxnav-client.js");

let pass = 0, fail = 0;
const fails = [];

// ---- Part A: direct catalog lookups ----
const UNIT = [
  { ings: ["salmeterol", "fluticasone"], l5: "R03AK06" },
  { ings: ["formoterol", "glycopyrronium"], l5: "R03AL07" },
  { ings: ["budesonide", "formoterol", "glycopyrronium"], l5: "R03AL11" },
  { ings: ["acetaminophen", "oxycodone"], l5: "N02AJ17" },
  { ings: ["aspirin", "oxycodone"], l5: "N02AJ18" },
  { ings: ["ibuprofen", "oxycodone"], l5: "N02AJ19" },
  { ings: ["amlodipine", "atorvastatin"], l5: "C10BX03" },
  { ings: ["lovastatin", "niacin"], l5: "C10BA01" },
  { ings: ["simvastatin", "sitagliptin"], l5: "A10BH51" },
  { ings: ["glimepiride", "rosiglitazone"], l5: "A10BD04" },
  { ings: ["hydralazine", "hydrochlorothiazide"], l5: "C02LG02" },
  { ings: ["amitriptyline", "perphenazine"], l5: "N06CA01" },
  { ings: ["amitriptyline", "chlordiazepoxide"], l5: "N06CA01" },
  { ings: ["dasabuvir", "ombitasvir", "paritaprevir", "ritonavir"], l5: "J05AP52" },
  // Macrogol family — 4/5/6 ingredient variants all → A06AD65
  { ings: ["polyethylene glycol 3350", "sodium bicarbonate", "potassium chloride", "sodium chloride"], l5: "A06AD65" },
  { ings: ["polyethylene glycol 3350", "sodium bicarbonate", "sodium sulfate", "potassium chloride", "sodium chloride"], l5: "A06AD65" },
  { ings: ["ascorbic acid", "polyethylene glycol 3350", "sodium ascorbate", "sodium sulfate", "potassium chloride", "sodium chloride"], l5: "A06AD65" },
];
console.log("=== Part A: direct catalog lookups ===");
for (const t of UNIT) {
  const hit = findCuratedCombination(t.ings);
  const got = hit ? hit.l5 : "(none)";
  const ok = got === t.l5;
  console.log(`  ${ok ? "✓" : "✗"} {${t.ings.join(", ").slice(0,50)}} → ${got} (want ${t.l5})`);
  if (ok) pass++; else { fail++; fails.push(`{${t.ings.join(",")}} got ${got} want ${t.l5}`); }
}

// Negative control: PEG + only 1 other (size 2) must NOT trigger the family rule
const solo = findCuratedCombination(["polyethylene glycol 3350", "water"]);
if (!solo) { pass++; console.log("  ✓ PEG + 1 component (size 2) correctly does NOT trigger family rule"); }
else { fail++; fails.push("PEG+1 wrongly matched family rule"); console.log("  ✗ PEG + 1 component wrongly matched"); }

// ---- Part B: end-to-end on active products ----
const E2E = [
  { label: "Advair Diskus 250/50", rxcui: "896212", expect: "R03AK06" },
  { label: "Bevespi Aerosphere", rxcui: "1790644", expect: "R03AL07" },
  { label: "Breztri Aerosphere", rxcui: "2387328", expect: "R03AL11" },
  { label: "Endocet 5/325 (oxycodone+APAP)", rxcui: "1049223", expect: "N02AJ17" },
  { label: "GoLYTELY (5-ingredient PEG)", rxcui: "966922", expect: "A06AD65" },
];
console.log("\n=== Part B: end-to-end resolver (live) ===");
for (const c of E2E) {
  const props = await getProperties(c.rxcui).catch(() => null);
  const result = await convertRxcuiToAtc(c.rxcui).catch(e => ({ status: "ERROR", error: String(e) }));
  const got = (result?.codes || []).map(x => x.code);
  const ok = got.includes(c.expect);
  console.log(`  ${ok ? "✓" : "✗"} ${c.label} [${c.rxcui}] → [${got.join(", ")}] (want ${c.expect}) status=${result?.status}`);
  if (ok) pass++; else { fail++; fails.push(`${c.label}: got [${got.join(",")}] want ${c.expect}`); }
}

console.log(`\n=== Summary: ${pass} pass, ${fail} fail ===`);
if (fails.length) { for (const f of fails) console.log(`  FAIL: ${f}`); process.exit(1); }
