// scratch/atc-repair/enrich.test.mjs
import assert from "node:assert/strict";
import { enrichRxcui, saveCache } from "./enrich.mjs";

// active product: dose form comes from the live endpoint
const active = await enrichRxcui("1146022"); // sodium chloride 20 MG/ML Nasal Spray
assert.equal(active.dfgSource, "live");
assert.ok(active.dfgs.includes("Nasal Product"));

// OBSOLETE product: live DFG is empty, history still carries the dose form.
// This is the cause-A bug the repair depends on.
const retired = await enrichRxcui("93370"); // clotrimazole 500 MG Vaginal Insert [Mycelex-G]
assert.equal(retired.dfgSource, "history");
assert.ok(retired.dfgs.includes("Vaginal Product"), "history dose form must be recovered");
assert.match(retired.status, /Obsolete/);

// combination product exposes >= 2 ingredient names
const combo = await enrichRxcui("1010755");
assert.ok(combo.ingredientNames.length >= 2, "expected >=2 INs");

saveCache();
console.log("enrich: all assertions passed");
