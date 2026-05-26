// scratch/test-r05fa-fix.js — verify the R05FA → R05FB correction for
// DXM-containing combos that ATCPROD mis-files under "Opium derivatives
// and expectorants" (Bucket B of the independent audit).
//
// Usage: node scratch/test-r05fa-fix.js

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
  // 2-ingredient DXM+guaifenesin — should hit Bucket A curated entry → R05FB02
  { label: "DXM + guaifenesin 2-combo (curated → R05FB02)",
    rxcui: "996520", expectCodes: ["R05FB02"], expectStatus: "KEEP" },

  // 3-ingredient DXM+guaifenesin+phenylephrine — Bucket B fix: L4 escalation should
  // surface R05FB (not R05FA) on the combination class card
  { label: "DXM + guaifenesin + phenylephrine (escalation → R05FB L4)",
    rxcui: "1000502", expectCodes: ["R05FB"], expectStatus: "COMBINATION_NO_DEDICATED_CODE" },

  // 3-ingredient DXM+guaifenesin+pseudoephedrine — same escalation path
  { label: "DXM + guaifenesin + pseudoephedrine (escalation → R05FB L4)",
    rxcui: "1090468", expectCodes: ["R05FB"], expectStatus: "COMBINATION_NO_DEDICATED_CODE" },
];

let pass = 0, fail = 0;
for (const c of CASES) {
  const props = await getProperties(c.rxcui).catch(() => null);
  console.log(`\n========== ${c.label} ==========`);
  console.log(`RxCUI ${c.rxcui}  ${props?.name || "(?)"} (TTY=${props?.tty})`);

  const result = await convertRxcuiToAtc(c.rxcui).catch(e => ({ status: "ERROR", error: String(e) }));
  const got = (result?.codes || []).map(x => x.code).sort();

  console.log(`  status=${result?.status}`);
  console.log(`  codes (got): [${got.join(", ")}]`);

  let ok = false;
  if (c.expectCodes) {
    const want = [...c.expectCodes].sort();
    ok = got.length === want.length && got.every((v, i) => v === want[i]);
    if (c.expectStatus && result?.status !== c.expectStatus) ok = false;
    console.log(`  expected codes: [${want.join(", ")}], status=${c.expectStatus}`);
  } else if (c.expectAtLeastOneOf) {
    ok = c.expectAtLeastOneOf.some(code => got.includes(code));
    console.log(`  expected at least one of: [${c.expectAtLeastOneOf.join(", ")}]`);
  }

  if (ok) { console.log("  ✓ PASS"); pass++; }
  else    { console.log("  ✗ FAIL"); fail++; }
}

console.log(`\n========== Summary ==========`);
console.log(`${pass} pass, ${fail} fail of ${CASES.length} cases`);
if (fail > 0) process.exit(1);
