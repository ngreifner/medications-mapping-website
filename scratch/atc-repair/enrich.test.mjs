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

// Bug 3 fix: RxCUI 1360383 (NovoLog Mix, insulin aspart protamine / insulin
// aspart) never reaches the combo-resolver without >=2 recovered ingredient
// names. Live RxNav exposes zero IN AND zero PIN relations for this
// obsolete concept, so the fix that actually recovers names here is the
// pre-existing historystatus/ingredientAndStrength(baseName) fallback, not
// the new PIN-union step (PIN union is a genuine no-op for this specific
// RxCUI since PIN is empty too) -- see task-3-report.md for the full trace.
// The PIN-union code stays in place as a general mechanism for other
// RxCUIs where IN is empty but PIN carries real data (the documented
// insulin-analog / salt-form pattern from CLAUDE.md).
const novologMix = await enrichRxcui("1360383");
assert.ok(novologMix.ingredientNames.length >= 2, "expected >=2 ingredient names for RxCUI 1360383");
assert.ok(novologMix.ingredientNames.includes("insulin aspart protamine, human"));
assert.ok(novologMix.ingredientNames.includes("insulin aspart, human"));

saveCache();
console.log("enrich: all assertions passed");
