// scratch/test-strength-determined.js — verify the strength-determined ATC
// override (Phase 2I) for everolimus / finasteride / sildenafil.
//
// Usage: node scratch/test-strength-determined.js

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
const { parseMgStrength } = await import("../js/atc-strength-determined-curated.js");

// Unit tests for the strength parser
console.log("=== strength parser ===");
const PARSE = [
  ["everolimus 0.5 MG Oral Tablet", 0.5],
  ["sildenafil 20 MG Oral Tablet", 20],
  ["finasteride 5 MG Oral Tablet", 5],
  ["sildenafil 10 MG/ML Oral Suspension", null],
  ["fluticasone furoate 0.1 MG/ACTUAT Dry Powder Inhaler", null],
];
let pass = 0, fail = 0;
for (const [n, want] of PARSE) {
  const got = parseMgStrength(n);
  const ok = got === want;
  console.log(`  ${ok ? "✓" : "✗"} "${n.slice(0,42)}" → ${got} (want ${want})`);
  if (ok) pass++; else fail++;
}

// End-to-end
const CASES = [
  { label: "Zortress 0.5 MG (immunosuppressant)", rxcui: "977436", expect: "L04AH02", forbid: "L01EG02" },
  { label: "Afinitor 5 MG (oncology)",            rxcui: "845518", expect: "L01EG02", forbid: "L04AH02" },
  { label: "Propecia 1 MG (alopecia)",            rxcui: "213178", expect: "D11AX10", forbid: "G04CB01" },
  { label: "Proscar 5 MG (BPH)",                  rxcui: "201961", expect: "G04CB01", forbid: "D11AX10" },
  { label: "Revatio 20 MG (PAH)",                 rxcui: "581645", expect: "C02KX01", forbid: "G04BE03" },
  { label: "Viagra 50 MG (ED)",                   rxcui: "213270", expect: "G04BE03", forbid: "C02KX01" },
];
console.log("\n=== end-to-end resolver ===");
for (const c of CASES) {
  const props = await getProperties(c.rxcui).catch(() => null);
  const result = await convertRxcuiToAtc(c.rxcui).catch(e => ({ status: "ERR", error: String(e) }));
  const got = (result?.codes || []).map(x => x.code);
  const ok = got.includes(c.expect) && !got.includes(c.forbid);
  console.log(`  ${ok ? "✓" : "✗"} ${c.label} [${c.rxcui}] → [${got.join(", ")}] (want ${c.expect}, not ${c.forbid})`);
  if (ok) pass++; else fail++;
}

console.log(`\n=== ${pass} pass, ${fail} fail ===`);
if (fail > 0) process.exit(1);
