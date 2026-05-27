// scratch/test-pin-specific-l5.js — verify the general "prefer PIN-specific
// L5" fix: fluticasone furoate products resolve to the furoate codes, while
// propionate products and other PIN-attributed drugs are unchanged.
//
// Usage: node scratch/test-pin-specific-l5.js

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
  // FUROATE — the fix: must now resolve to furoate-specific codes
  { label: "Arnuity Ellipta (fluticasone furoate inhaled)", rxcui: "1547660", expect: "R03BA09", forbid: "R03BA05" },
  { label: "Flonase Sensimist (fluticasone furoate nasal)", rxcui: "1869712", expect: "R01AD12", forbid: "R01AD08" },

  // PROPIONATE — must stay on the propionate codes (PIN isn't a distinct member)
  { label: "Flovent HFA (fluticasone propionate inhaled)", rxcui: "896001", expect: "R03BA05", forbid: "R03BA09" },
  { label: "fluticasone propionate nasal spray (fixture)", rxcui: "1797907", expect: "R01AD08", forbid: "R01AD12" },

  // PIN-attributed regression (existing behavior must hold)
  { label: "clorazepate dipotassium oral tablet", rxcui: "197464", expect: "N05BA05", forbid: null },
];

let pass = 0, fail = 0;
for (const c of CASES) {
  const props = await getProperties(c.rxcui).catch(() => null);
  const result = await convertRxcuiToAtc(c.rxcui).catch(e => ({ status: "ERROR", error: String(e) }));
  const got = (result?.codes || []).map(x => x.code);
  const hasExpect = got.includes(c.expect);
  const hasForbidden = c.forbid && got.includes(c.forbid);
  const ok = hasExpect && !hasForbidden;
  console.log(`${ok ? "✓" : "✗"} ${c.label}`);
  console.log(`    [${c.rxcui}] ${(props?.name||"?").slice(0,60)}`);
  console.log(`    got=[${got.join(", ")}]  want ${c.expect}${c.forbid ? `, NOT ${c.forbid}` : ""}  status=${result?.status}`);
  if (ok) pass++; else fail++;
}
console.log(`\n=== ${pass} pass, ${fail} fail of ${CASES.length} ===`);
if (fail > 0) process.exit(1);
