// scratch/test-form-determined.js — verify the form-determined ATC override
// (Phase 2G) for methotrexate, the canonical case of a substance whose WHO
// L5 is form-dependent rather than route-dependent.
//
// Usage: node scratch/test-form-determined.js
//
// Expected:
//   - Auto-injector / prefilled syringe / oral tablet / oral solution
//     → L04AX03 only (WHO immunosuppressant)
//   - Injectable Solution / Injection (vials, infusion)
//     → L01BA01 only (WHO antineoplastic)
//   - Methotrexate IN itself (ingredient-level query)
//     → both L01BA01 + L04AX03 (unchanged behavior, no override applied)

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
  { label: "Rasuvo auto-injector",          rxcui: "1544396", expect: ["L04AX03"] },
  { label: "Otrexup auto-injector",         rxcui: "1441407", expect: ["L04AX03"] },
  { label: "Reditrex prefilled syringe",    rxcui: "2377338", expect: ["L04AX03"] },
  { label: "Trexall 5 MG oral tablet",      rxcui: "284592",  expect: ["L04AX03"] },
  { label: "Xatmep 2.5 MG/ML oral solution", rxcui: "1921598", expect: ["L04AX03"] },
  { label: "Methotrexate injectable solution (vial)", rxcui: "105589",  expect: ["L01BA01"] },
  { label: "Methotrexate 25 MG/ML Injection",         rxcui: "1655956", expect: ["L01BA01"] },
  { label: "Methotrexate IN (ingredient query)",      rxcui: "6851",    expect: ["L01BA01", "L04AX03"] },
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
  if (result?.formDeterminedProvenance) {
    console.log(`  override: matched "${result.formDeterminedProvenance.matchedForm || "(default)"}", note="${result.formDeterminedProvenance.note}"`);
  }
  if (ok) {
    console.log(`  ✓ PASS`);
    pass++;
  } else {
    console.log(`  ✗ FAIL`);
    fail++;
    failures.push({ label: c.label, rxcui: c.rxcui, got, want });
  }
}

console.log(`\n========== Summary ==========`);
console.log(`${pass} pass, ${fail} fail of ${CASES.length} cases`);
if (failures.length) {
  console.log(`\nFailures:`);
  for (const f of failures) {
    console.log(`  - ${f.label} (${f.rxcui}): got [${f.got.join(", ")}], want [${f.want.join(", ")}]`);
  }
  process.exit(1);
}
