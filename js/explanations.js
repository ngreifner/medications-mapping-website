// explanations.js: all human-readable reason templates and clinical-context strings.
// Pure functions, no side effects. Every mode pulls from here; no inline strings elsewhere.

export const explainKept = (atc, route, prefix) =>
  `${atc} matches the ${route} route (allowed prefix: ${prefix}).`;

export const explainKeptExclude = (atc, route) =>
  `${atc} does not hit any prefix reserved for local routes; consistent with a ${route} product.`;

export const explainWrongRouteAllow = (atc, route, allowedPrefixes) =>
  `${atc} does not match the ${route} route. The ATC anatomical group for ${route} products is limited to ${allowedPrefixes.join(", ")}. This code likely came from the ingredient's use in a different formulation.`;

export const explainWrongRouteExclude = (atc, route, matchedPrefix) =>
  `${atc} starts with ${matchedPrefix}, which is reserved for local routes. A ${route} product should not have this code; it suggests ingredient-level pollution from a different formulation.`;

export const explainLevelNot5 = (atc) =>
  `${atc} is an ATC hierarchy ancestor, not a specific drug class. Only Level 5 codes (7 characters) are actionable.`;

export const explainIngredientLevel = (rxcui, name) =>
  `${rxcui}${name ? ` (${name})` : ""} is an ingredient-level concept with no specific dose form. The route cannot be determined from the RXCUI alone.`;

export const explainNoDfg = (rxcui, name) =>
  `${rxcui}${name ? ` (${name})` : ""} has no dose form group (DFG) returned by RxNav. Route cannot be determined.`;

export const explainUnknownDfg = (rxcui, dfgs) =>
  `${rxcui} returned dose form group(s) not in the route map: ${dfgs.join(", ")}. The route can't be classified.`;

export const explainRouteResolution = (route, dfg, allDfgs) => {
  if (!allDfgs || allDfgs.length <= 1) {
    return `Resolved route: ${route}. The drug's dose form group is "${dfg}".`;
  }
  return `Resolved route: ${route}. Selected "${dfg}" as the highest-priority DFG out of: ${allDfgs.join(", ")}. The most-specific local route wins over more general ones.`;
};

export const explainNdcObsolete = (ndc) =>
  `NDC ${ndc} is marked OBSOLETE by FDA. The product is no longer commercially available. Mappings still resolve but may not be appropriate for current claims data.`;

export const explainNdcNotFound = (ndc) =>
  `NDC ${ndc} is not in RxNorm's NDC index. This may be a newly registered product, a custom compound, or a non-standard format.`;

export const explainNoRxcuiMapped = (ndc) =>
  `NDC ${ndc} is in RxNorm's index but doesn't map to a clinical RXCUI. This is unusual, typically packaging-only entries.`;

export const explainRxcuiNotFound = (rxcui) =>
  `RXCUI ${rxcui} was not found in RxNav. It may be retired, from a different code system, or a typo.`;

// Clinical context keyed by `${route}_${ATC anatomical letter + first 2 digits}`.
// Looked up after a rejection to add a plain-English clinical reason.
// Optional; falls back to no clinical line if no match.
export const clinicalContext = {
  "nasal_R03":     "This ingredient is also formulated as an asthma inhaler, but a nasal spray treats allergies, not asthma.",
  "nasal_D07":     "This ingredient is also formulated as a skin cream, but a nasal spray is not for skin conditions.",
  "ophthalmic_H02":"This ingredient is also formulated as a systemic steroid pill, but an eye drop acts locally.",
  "ophthalmic_C07":"This ingredient is also formulated as a cardiac beta blocker, but eye drops for glaucoma act locally on the eye.",
  "ophthalmic_J01":"This ingredient is also formulated as a systemic antibiotic, but eye drops treat ocular infection locally.",
  "topical_C01":   "This ingredient is also formulated as a systemic cardiac drug, but a patch or cream acts locally.",
  "otic_J01":      "This ingredient is also formulated as a systemic antibiotic, but ear drops act locally.",
  "rectal_H02":    "This ingredient is also formulated as a systemic steroid, but a suppository or rectal foam acts locally.",
  "vaginal_G03":   "This ingredient is also used as systemic hormone replacement, but a vaginal preparation acts locally.",
};

// Build the clinical key from a route + ATC (first 3 chars, e.g. "R03").
export function clinicalContextKey(route, atc) {
  if (!route || !atc || atc.length < 3) return null;
  return `${route}_${atc.slice(0, 3).toUpperCase()}`;
}

export function getClinicalContext(route, atc) {
  const key = clinicalContextKey(route, atc);
  if (!key) return null;
  return clinicalContext[key] || null;
}

// ---------------- TTY descriptions + NDC explanations ----------------
//
// RxNorm only attaches NDCs to product-level concepts. Everything else
// (ingredients, brand names, dose forms, groupings) is by design NDC-less.
// These helpers + templates let Mode 4 / Mode 5 explain the distinction
// instead of showing the same generic "no NDCs" message everywhere.

export const TTY_DESCRIPTIONS = {
  IN:   "Ingredient",
  PIN:  "Precise Ingredient",
  MIN:  "Multiple Ingredients",
  BN:   "Brand Name",
  SCD:  "Semantic Clinical Drug",
  SBD:  "Semantic Branded Drug",
  BPCK: "Branded Pack",
  GPCK: "Generic Pack",
  SCDG: "Semantic Clinical Drug Group",
  SBDG: "Semantic Branded Drug Group",
  SCDC: "Semantic Clinical Drug Component",
  SBDC: "Semantic Branded Drug Component",
  SCDF: "Semantic Clinical Drug Form",
  SBDF: "Semantic Branded Drug Form",
  DF:   "Dose Form",
  DFG:  "Dose Form Group",
};

const PRODUCT_TTYS = new Set(["SCD", "SBD", "BPCK", "GPCK"]);

export function isProductTty(tty) {
  return PRODUCT_TTYS.has((tty || "").toUpperCase());
}

export function ttyDescription(tty) {
  if (!tty) return "concept";
  return TTY_DESCRIPTIONS[tty.toUpperCase()] || `TTY ${tty}`;
}

export function explainNoNdcsForNonProduct(name, tty) {
  const desc = ttyDescription(tty);
  const subject = name ? `${name} is a ${desc}` : `This is a ${desc}`;
  return `${subject} (TTY=${tty}). RxNorm only assigns NDCs to specific product concepts (SCD, SBD, BPCK, GPCK). ` +
    `To find NDCs, look up a specific formulation${name ? ` of ${name}` : ""}.`;
}

export function explainNoNdcsForProduct(name, tty) {
  const subject = name ? `${name}` : "This product";
  return `${subject} (TTY=${tty}) exists in RxNorm but has no active NDCs in the current release. ` +
    `Typical reasons: unmarketed in the US, recently retired, generic without independent marketing, or not yet indexed.`;
}

export function noNdcsTooltipForNonProduct(tty) {
  const desc = ttyDescription(tty);
  return `TTY=${tty} is not a product type (${desc}). RxNorm reserves NDCs for specific clinical drugs (SCD/SBD) ` +
    `or packaged products (BPCK/GPCK). To get NDCs, look up a specific formulation.`;
}

export function noNdcsTooltipForProduct(tty) {
  return `This product (TTY=${tty}) exists in RxNorm but has no active NDCs in the current release. ` +
    `Possible reasons: retired from market, generic without independent marketing, or international product not sold in the US.`;
}
