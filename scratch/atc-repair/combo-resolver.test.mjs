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

// S1 adversarial — a MIN's own property lookup returns exactly one code, but that
// code is genuinely NOT combination-shaped by name (J01CA04 = "amoxicillin" per WHO,
// confirmed via getWhoName; isCombinationCode("J01CA04") === false). S1's current
// logic trusts any single minAtcCodes entry outright (see the comment above S1 in
// combo-resolver.mjs), so this asserts the CURRENT, ACCEPTED behavior: the resolver
// still returns it as min_property. This makes the residual risk (a MIN's single ATC
// property could in principle be a mono-ingredient code rather than the combination's
// own classification) visible and intentional rather than an untested assumption. See
// task-3-report.md "Fix round 1" for the accepted-risk rationale and mitigation.
r = resolveComboCode({
  ingredientNames: ["amoxicillin", "clavulanate"],
  currentCodes: ["J01CA04", "J01CR02"],
  minAtcCodes: ["J01CA04"],
});
assert.equal(r.code, "J01CA04");
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

// S4 (redesigned, round 3) — WHO full-index name match now ALWAYS scores
// against the full universe of WHO combination codes, not just the L4s
// implied by the row's (possibly wrong) current codes. Without a route, a
// lidocaine+epinephrine product genuinely ties between two equally-valid
// single-anchor wildcard entries under two DIFFERENT L4s — N01BB52
// ("lidocaine, combinations", local anesthetic) and S01EA51 ("epinephrine,
// combinations", WHO's ophthalmic "Sensory organs" class) — because both
// entries only name ONE of the two ingredients and say nothing about what
// they're combined with. currentCodes here (C01CA24, N01BB02 — no S01EA01)
// used to hide S01EA51 from consideration entirely under the old
// narrow-first design; that was the bug (see the Critical review finding
// re: morphine+naltrexone below). The redesigned resolver correctly refuses
// to guess when no route is available to break the tie.
r = resolveComboCode({
  ingredientNames: ["lidocaine", "epinephrine"],
  currentCodes: ["C01CA24", "N01BB02"],
  minAtcCodes: [],
});
assert.equal(r.code, null);
assert.equal(r.provenance, "ambiguous");
assert.deepEqual(r.candidates, ["N01BB52", "S01EA51"]);

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

// Bug 1+2 fix: route-aware tie-break rejects the anatomically wrong candidate
r = resolveComboCode({
  ingredientNames: ["lidocaine", "epinephrine"],
  currentCodes: ["C01CA24", "D04AB01", "N01BB02", "R02AD02", "S01EA01"],
  minAtcCodes: [],
  route: "injectable",
});
assert.equal(r.code, "N01BB52");

// Bug 2 fix: correct L4 not implied by current wrong codes must still be found
r = resolveComboCode({
  ingredientNames: ["tetracaine", "benzocaine", "butamben"],
  currentCodes: ["C05AD03", "D04AB04", "R02AD01"],
  minAtcCodes: [],
  route: "topical",
});
assert.equal(r.code, "N01BA53");

// Round-3 Critical fix regression test: morphine + naltrexone (Embeda-shape
// abuse-deterrent opioid analgesic), currently miscoded under A07DA03
// ("morphine" in the antidiarrheal/antipropulsive A07D class — itself a
// row-level mis-mapping, exactly the kind of wrong-current-code case this
// whole repair effort targets). Live-verified via getWhoName against the WHO
// full index (scratch/atc-repair/who-full-index.mjs):
//   - A07DA52 = "morphine, combinations"  (antidiarrheal domain, A07DA)
//   - N02AA51 = "morphine, combinations"  (analgesic domain, N02AA)
//   - No WHO L5 anywhere names "morphine and naltrexone" explicitly, and no
//     class-tier entry covers this pair either (confirmed: grepping the raw
//     WHO index for "naltrexone" surfaces only A06AH01 methylnaltrexone,
//     A08AA62 bupropion+naltrexone, N02AA56 oxycodone+naltrexone, and the
//     bare N07BB04 naltrexone entry — none of which name morphine).
// Under the OLD narrow-first design, A07DA03 being in currentCodes put A07DA
// in the (only) search pool; A07DA52's wildcard-promoted "morphine,
// combinations" was the LONE match found there, so it was returned outright
// as a confident (and WRONG) answer — a real WHO domain mismatch, not a
// route problem (A07 isn't excluded under the oral route matrix, so route
// filtering could never have caught this).
// Under the redesigned resolver, the search is always wide: A07DA52 and
// N02AA51 are BOTH found (same WHO display name, same promoted score), and
// since neither is anatomically excluded from the oral route, they remain
// tied. The resolver correctly refuses to guess between the two rather than
// returning either one — this is the specific case the Critical finding
// asked to be closed.
r = resolveComboCode({
  ingredientNames: ["morphine", "naltrexone"],
  currentCodes: ["A07DA03"],
  minAtcCodes: [],
  route: "oral",
});
assert.notEqual(r.code, "A07DA52");
assert.equal(r.code, null);
assert.equal(r.provenance, "ambiguous");
assert.deepEqual(r.candidates, ["A07DA52", "N02AA51"]);

console.log("combo-resolver: all assertions passed");
