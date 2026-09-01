// scratch/atc-repair/combo-resolver.test.mjs
import assert from "node:assert/strict";
import { resolveComboCode } from "./combo-resolver.mjs";

// S1 — the MIN concept's own ATC property already carries the combination code
let r = resolveComboCode({
  ingredientNames: ["insulin aspart", "insulin aspart protamine"],
  currentCodes: ["A10AB05", "A10AD05"],
  minAtcCodes: ["A10AD05"],
});
assert.equal(r.code, "A10AD05");
assert.equal(r.provenance, "min_property");

// S2 — a combination code already sitting in the current cell wins over the mono codes
r = resolveComboCode({
  ingredientNames: ["lidocaine", "epinephrine"],
  currentCodes: ["C01CA24", "D04AB01", "N01BB02", "R02AD02", "S01EA01"],
  minAtcCodes: [],
});
// none of the current codes is a combination code, so this must fall through to S4
assert.notEqual(r.provenance, "current_cell");

// S3 — curated catalog
r = resolveComboCode({
  ingredientNames: ["hydrochlorothiazide", "valsartan"],
  currentCodes: ["C03AA03", "C09CA03"],
  minAtcCodes: [],
});
assert.equal(r.code, "C09DA03");
assert.equal(r.provenance, "curated");

// S4 — WHO full-index name match within the L4s implied by the mono codes
r = resolveComboCode({
  ingredientNames: ["lidocaine", "epinephrine"],
  currentCodes: ["C01CA24", "N01BB02"],
  minAtcCodes: [],
});
assert.equal(r.code, "N01BB52");             // "lidocaine, combinations"
assert.equal(r.provenance, "who_index");

// S4 extension — WHO names a single-ingredient "combinations" wildcard bucket
// (e.g. "lidocaine, combinations") rather than spelling out both ingredients.
// scoreL5Match's WILDCARD tier (40) is below MIN_SCORE (80) by design (it's meant
// to be a last-resort, low-confidence tier for cases with no other signal). But
// when the wildcard's single explicit ingredient IS one of the input ingredients,
// that's actually a solid, unambiguous signal — WHO is saying "lidocaine plus
// something else" and our input genuinely is "lidocaine plus something else".
// This assertion is the same case as the one above, made explicit: confirm the
// promotion to CLASS-tier (80) is what lets N01BB52 clear the bar, and that it's
// the sole candidate (no other N01BB or C01CA combination entry also matches).
assert.deepEqual(r.candidates, ["N01BB52"]);

// no dedicated code exists -> null, never a guess
r = resolveComboCode({
  ingredientNames: ["chondroitin sulfates", "glucosamine"],
  currentCodes: ["M01AX05", "M01AX25"],
  minAtcCodes: [],
});
assert.equal(r.code, null);
assert.equal(r.provenance, "none");

// a single-ingredient input is not this resolver's business
r = resolveComboCode({ ingredientNames: ["lidocaine"], currentCodes: ["N01BB02"], minAtcCodes: [] });
assert.equal(r.code, null);
assert.equal(r.provenance, "not_combination");

console.log("combo-resolver: all assertions passed");
