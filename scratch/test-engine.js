// scratch/test-engine.js — Node verification of the ported convertRxcuiToAtc.
//
// Usage:
//   node scratch/test-engine.js               # runs all three scenarios
//   node scratch/test-engine.js <RXCUI>       # runs a single RXCUI
//
// Requires Node 18+ (native fetch). rxnav-client.js uses localStorage; we
// install an in-memory shim before importing so the production module stays
// browser-pure.

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

async function runOne(label, rxcui) {
  console.log(`\n========== ${label} (RXCUI ${rxcui}) ==========`);
  const props = await getProperties(rxcui);
  if (props.found) console.log(`Drug: ${props.name}  (TTY=${props.tty})`);
  else console.log(`Drug: (RXCUI ${rxcui} not found in RxNav)`);

  const result = await convertRxcuiToAtc(rxcui);
  console.log("\nResult:", JSON.stringify(result, null, 2));
}

const arg = process.argv[2];
if (arg) {
  await runOne("Single", arg);
} else {
  // Three scenarios per the prompt:
  //   1. fluticasone nasal spray (1797907) — Strategy 2 hit, expects R01AD08
  //   2. atorvastatin 20 MG oral tablet (617310) — Strategy 1 ATCPROD hit
  //   3. a clearly broken RXCUI — expects null
  await runOne("aminophylline IN (INGREDIENT_LEVEL)", "689");
  await runOne("metformin IN (INGREDIENT_LEVEL)", "6809");
  await runOne("fluticasone IN (INGREDIENT_LEVEL, 3 codes)", "41126");
  await runOne("fluticasone nasal spray (Strategy 2)", "1797907");
  await runOne("atorvastatin oral tablet (Strategy 1 ATCPROD)", "617310");
  await runOne("timolol ophthalmic (Strategy 1 ATCPROD)", "2702393");
  await runOne("nonexistent RXCUI (last-resort path)", "999999999");
}
