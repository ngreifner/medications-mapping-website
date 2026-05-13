// scratch/regen-fixtures.js — resolve a hardcoded list of drug NAMES to their
// current RXCUIs via /drugs.json, and print a test-fixtures.js source body.
// Run: node scratch/regen-fixtures.js  →  copy output into js/test-fixtures.js

const memStore = new Map();
globalThis.localStorage = {
  getItem: (k) => (memStore.has(k) ? memStore.get(k) : null),
  setItem: (k, v) => { memStore.set(k, String(v)); },
  removeItem: (k) => { memStore.delete(k); },
  clear: () => { memStore.clear(); },
  key: (i) => [...memStore.keys()][i] ?? null,
  get length() { return memStore.size; },
};

const { findRxcuiByName } = await import("../js/rxnav-client.js");

// Curated by drug NAME (not RXCUI). RxNav's /drugs.json returns the current
// canonical RXCUI for each. We pick SCD preferentially in findRxcuiByName.
const CASES = [
  // CLEAN_FIX expected — multiple ATCs in, route filter keeps one
  { name: "fluticasone propionate 0.05 MG/ACTUAT Metered Dose Nasal Spray", expectedRoute: "nasal",      expectedKeptStartsWith: "R01" },
  { name: "timolol 0.5 % Ophthalmic Solution",                             expectedRoute: "ophthalmic", expectedKeptStartsWith: "S01" },
  { name: "brimonidine tartrate 1 MG/ML Ophthalmic Solution",              expectedRoute: "ophthalmic", expectedKeptStartsWith: "S01" },
  { name: "lidocaine 50 MG/ML Topical Patch",                              expectedRoute: "topical",    expectedKeptStartsWith: "D"   },
  { name: "hydrocortisone 25 MG Rectal Suppository",                       expectedRoute: "rectal",     expectedKeptStartsWith: "C05" },
  { name: "miconazole 100 MG Vaginal Suppository",                         expectedRoute: "vaginal",    expectedKeptStartsWith: "G01" },
  { name: "budesonide 0.05 MG/ACTUAT Metered Dose Nasal Spray",            expectedRoute: "nasal",      expectedKeptStartsWith: "R01" },
  { name: "ciprofloxacin 0.3 % Otic Solution",                             expectedRoute: "otic",       expectedKeptStartsWith: "S02" },

  // UNCHANGED expected — single oral systemic mapping
  { name: "atorvastatin 20 MG Oral Tablet",                                expectedRoute: "oral",       expectedKeptStartsWith: "C10" },
  { name: "lisinopril 10 MG Oral Tablet",                                  expectedRoute: "oral",       expectedKeptStartsWith: "C09" },
  { name: "amlodipine 5 MG Oral Tablet",                                   expectedRoute: "oral",       expectedKeptStartsWith: "C08" },

  // Inhalation
  { name: "albuterol 0.83 MG/ML Inhalation Solution",                      expectedRoute: "inhalant",   expectedKeptStartsWith: "R03" },

  // Injectable
  { name: "ondansetron 2 MG/ML Injectable Solution",                       expectedRoute: "injectable" },

  // INGREDIENT_LEVEL — these are TTY=IN, no route resolvable
  { name: "fluticasone",                                                   expectedVerdict: "INGREDIENT_LEVEL" },
  { name: "timolol",                                                       expectedVerdict: "INGREDIENT_LEVEL" },
];

const resolved = [];
for (const c of CASES) {
  const r = await findRxcuiByName(c.name);
  if (r.found) {
    resolved.push({ ...c, rxcui: r.rxcui, resolvedName: r.resolvedName, resolvedTty: r.tty });
    console.log(`  ✓ ${r.rxcui.padStart(8)}  ${r.tty.padEnd(4)}  ${c.name}`);
  } else {
    console.log(`  ✗ (not found)  ${c.name}`);
  }
}

console.log("\n--- paste into js/test-fixtures.js ---\n");
console.log(`export const TEST_CASES_RXCUI = [`);
for (const c of resolved) {
  const parts = [`rxcui: "${c.rxcui}"`, `name: ${JSON.stringify(c.resolvedName)}`];
  if (c.expectedRoute) parts.push(`expectedRoute: "${c.expectedRoute}"`);
  if (c.expectedKeptStartsWith) parts.push(`expectedKeptStartsWith: "${c.expectedKeptStartsWith}"`);
  if (c.expectedVerdict) parts.push(`expectedVerdict: "${c.expectedVerdict}"`);
  console.log(`  { ${parts.join(", ")} },`);
}
console.log(`];`);
