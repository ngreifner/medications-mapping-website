// scratch/test-pack-l5.js — verify single-ingredient packs and newer drugs
// no longer get false-positive'd as combinations and stripped to L4
// (Phase 2H Bucket C).
//
// Usage: node scratch/test-pack-l5.js

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
  // ─── Pack codes for single-ingredient drugs (the canonical bug) ──
  { label: "Humira GPCK pack (adalimumab)",          rxcui: "1855526", expect: "L04AB04" },
  { label: "Humira BPCK Pediatric Crohn pack",       rxcui: "1855527", expect: "L04AB04" },
  { label: "Humira Pen Psoriasis starter pack",      rxcui: "1872986", expect: "L04AB04" },

  // Lamictal titration pack (single-ingredient, two strengths)
  { label: "Lamictal XR titration kit",              rxcui: "900984",  expect: "N03AX09" },

  // Dimethyl fumarate (Tecfidera) titration pack
  { label: "Dimethyl fumarate titration pack",       rxcui: "1373497", expect: "L04AX07" },

  // Ozanimod (Zeposia) titration pack
  { label: "Ozanimod starter pack",                  rxcui: "2288432", expect: "L04AE02" },

  // ─── Regression: real combination products should still escalate ──
  // 3-ingredient OTC cold combo — no dedicated WHO L5; should escalate
  { label: "DXM + guaifenesin + phenylephrine (real combo)",
    rxcui: "1000502", expect: "R05FB", expectStatus: "COMBINATION_NO_DEDICATED_CODE" },

  // 2-ingredient combination with curated entry — should hit it
  { label: "HCTZ + valsartan (curated)",             rxcui: "200284",  expect: "C09DA03" },
];

let pass = 0, fail = 0;
for (const c of CASES) {
  const props = await getProperties(c.rxcui).catch(() => null);
  console.log(`\n========== ${c.label} ==========`);
  console.log(`RxCUI ${c.rxcui}  ${(props?.name || "?").slice(0, 80)} (TTY=${props?.tty})`);

  const result = await convertRxcuiToAtc(c.rxcui).catch(e => ({ status: "ERROR", error: String(e) }));
  const got = (result?.codes || []).map(x => x.code);

  console.log(`  status=${result?.status}  codes=[${got.join(", ")}]`);

  const ok = got.includes(c.expect) && (!c.expectStatus || result?.status === c.expectStatus);
  if (ok) { console.log(`  ✓ PASS  (expected ${c.expect}${c.expectStatus ? ", status=" + c.expectStatus : ""})`); pass++; }
  else    { console.log(`  ✗ FAIL  (expected ${c.expect}${c.expectStatus ? ", status=" + c.expectStatus : ""})`); fail++; }
}

console.log(`\n========== Summary ==========`);
console.log(`${pass} pass, ${fail} fail of ${CASES.length} cases`);
if (fail > 0) process.exit(1);
