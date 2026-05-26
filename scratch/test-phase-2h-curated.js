// scratch/test-phase-2h-curated.js — verify the 14 new Phase 2H curated
// combination entries against live RxNav products.
//
// Usage: node scratch/test-phase-2h-curated.js

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
const { getProperties } = await import("../js/rxnav-client.js");

const CASES = [
  // R03AL — LABA + LAMA combinations
  { label: "Combivent (albuterol+ipratropium)",       rxcui: "1190225", expect: ["R03AL02"] },
  { label: "Stiolto Respimat (olodaterol+tiotropium)", rxcui: "1651266", expect: ["R03AL06"] },
  { label: "Trelegy Ellipta (FF/UMEC/VI)",            rxcui: "1945039", expect: ["R03AL08"] },

  // C09DX — ARBs other combinations
  { label: "Byvalson (nebivolol+valsartan)",          rxcui: "1798287", expect: ["C09DX05"] },

  // N06CA — antidepressants + psycholeptics
  { label: "Symbyax-shape fluoxetine+olanzapine",     rxcui: "403969",  expect: ["N06CA03"] },

  // N07BC — buprenorphine combinations
  { label: "Suboxone film 2/0.5",                     rxcui: "1010600", expect: ["N07BC51"] },

  // C03EA — HCTZ + potassium-sparing
  { label: "Aldactazide-shape HCTZ+spironolactone",   rxcui: "198224",  expect: ["C03EA01"] },

  // A03CA — clidinium + psycholeptics
  { label: "Librax (chlordiazepoxide+clidinium)",     rxcui: "889616",  expect: ["A03CA02"] },

  // A10BD — metformin + sulfonylurea
  { label: "Metaglip-shape metformin+glipizide",      rxcui: "861736",  expect: ["A10BD02"] },
];

let pass = 0, fail = 0;
const failures = [];

for (const c of CASES) {
  const props = await getProperties(c.rxcui).catch(() => null);
  const drugLabel = props?.name ? `${props.name} (TTY=${props.tty})` : `(not found)`;
  console.log(`\n========== ${c.label} ==========`);
  console.log(`RxCUI ${c.rxcui}  ${drugLabel}`);

  const result = await convertRxcuiToAtc(c.rxcui).catch(e => ({ status: "ERROR", error: String(e) }));
  const got = (result?.codes || []).map(x => x.code).sort();
  const want = [...c.expect].sort();
  const ok = got.length === want.length && got.every((v, i) => v === want[i]);

  console.log(`  status=${result?.status}`);
  console.log(`  codes (got):  [${got.join(", ")}]`);
  console.log(`  codes (want): [${want.join(", ")}]`);
  if (result?.curatedProvenance) {
    console.log(`  curated: ${result.curatedProvenance.code} (${result.curatedProvenance.name})`);
  } else if (result?.whoProvenance) {
    console.log(`  WHO snapshot: ${result.whoProvenance.code} (match=${result.whoProvenance.match_type}, score=${result.whoProvenance.score})`);
  } else if (result?.minProvenance) {
    console.log(`  MIN-property: ${result.minProvenance.code} via MIN ${result.minProvenance.minRxcui}`);
  }
  if (ok) { console.log(`  ✓ PASS`); pass++; }
  else    { console.log(`  ✗ FAIL`); fail++; failures.push({...c, got}); }
}

console.log(`\n========== Summary ==========`);
console.log(`${pass} pass, ${fail} fail of ${CASES.length} cases`);
if (failures.length) {
  console.log(`\nFailures:`);
  for (const f of failures) {
    console.log(`  - ${f.label} (${f.rxcui}): got [${f.got.join(", ")}], want [${f.expect.join(", ")}]`);
  }
  process.exit(1);
}
