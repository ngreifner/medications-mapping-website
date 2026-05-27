// atc-strength-determined-curated.js — Navina-curated table for substances
// where WHO ATC assigns multiple L5 codes based on DOSE STRENGTH (which
// tracks the clinical indication), not route or dose form.
//
// This is the third leg of the dual-code family, after:
//   - route       → ROUTE_ATC_MATRIX in filter-engine.js
//   - dose form    → atc-form-determined-curated.js (Phase 2G, methotrexate)
//   - dose strength → THIS FILE (Phase 2I)
//
// Canonical cases:
//   everolimus   ≤1 mg  → L04AH02 (transplant immunosuppressant, Zortress)
//                >1 mg  → L01EG02 (antineoplastic mTOR inhibitor, Afinitor)
//   finasteride   1 mg  → D11AX10 (androgenetic alopecia, Propecia)
//                ≥5 mg  → G04CB01 (benign prostatic hyperplasia, Proscar)
//   sildenafil   ≤20 mg → C02KX01 (pulmonary arterial hypertension, Revatio)
//                >20 mg → G04BE03 (erectile dysfunction, Viagra)
//
// Why a curated table rather than data-driven: the route filter cannot pick
// between these (finasteride's two codes span D and G; everolimus's span L01
// and L04 — both pass the oral matrix), and RxNorm does not expose the
// strength→code split. For sildenafil RxNorm doesn't even carry the PAH code
// C02KX01 at all, so it must be supplied here.
//
// Strength is read from the product's RxNorm name (e.g. "everolimus 0.5 MG
// Oral Tablet"). Only plain-MG strengths are honored; concentration forms
// (MG/ML, MG/ACTUAT) and unparseable names return no match so the resolver
// falls back to its normal answer rather than risk a wrong call.
//
// How to add a substance: append an entry with the RxNorm IN name, the unit,
// an ordered `rules` list (first match wins) using maxStrength / minStrength
// bounds, and a defaultAtcs for strengths no rule covers.

export const STRENGTH_DETERMINED_ATCS = [
  {
    ingredient: "everolimus",
    unit: "MG",
    rules: [
      { maxStrength: 1, atcs: [{ code: "L04AH02", name: "everolimus" }],
        note: "≤1 mg oral — transplant immunosuppressant (Zortress)" },
    ],
    defaultAtcs: [{ code: "L01EG02", name: "everolimus" }],
    defaultNote: ">1 mg oral — antineoplastic mTOR inhibitor (Afinitor)",
  },
  {
    ingredient: "finasteride",
    unit: "MG",
    rules: [
      { maxStrength: 1, atcs: [{ code: "D11AX10", name: "finasteride" }],
        note: "1 mg — androgenetic alopecia (Propecia)" },
    ],
    defaultAtcs: [{ code: "G04CB01", name: "finasteride" }],
    defaultNote: "≥5 mg — benign prostatic hyperplasia (Proscar)",
  },
  {
    ingredient: "sildenafil",
    unit: "MG",
    rules: [
      { maxStrength: 20, atcs: [{ code: "C02KX01", name: "sildenafil" }],
        note: "≤20 mg — pulmonary arterial hypertension (Revatio)" },
    ],
    defaultAtcs: [{ code: "G04BE03", name: "sildenafil" }],
    defaultNote: ">20 mg — erectile dysfunction (Viagra)",
  },
];

/**
 * Extract a plain-MG strength from an RxNorm product name. Returns the
 * numeric milligram value, or null when the name has no plain-MG strength
 * (e.g. a MG/ML concentration, MG/ACTUAT metered dose, or no strength).
 *
 * "everolimus 0.5 MG Oral Tablet"        → 0.5
 * "sildenafil 20 MG Oral Tablet"         → 20
 * "sildenafil 10 MG/ML Oral Suspension"  → null  (concentration, skip)
 * "fluticasone 0.1 MG/ACTUAT ..."        → null  (metered, skip)
 */
export function parseMgStrength(productName) {
  const name = String(productName || "");
  // number + MG, but NOT followed by "/" (MG/ML) or a letter (MG/ACTUAT etc.)
  const m = name.match(/(\d+(?:\.\d+)?)\s*MG(?![/A-Za-z])/i);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return Number.isFinite(v) ? v : null;
}

/**
 * Look up a substance's strength-determined ATCs.
 *
 * @param {string} ingredientName - RxNorm IN name (any case)
 * @param {string} productName    - RxNorm product name (carries the strength)
 * @returns {{ atcs: Array<{code,name}>, note: string, ingredient: string,
 *             matchedStrength: number|null, unit: string } | null}
 *          null if the ingredient isn't in the table OR the strength can't be
 *          parsed (so the resolver keeps its normal answer).
 */
export function findStrengthDeterminedAtcs(ingredientName, productName) {
  if (!ingredientName) return null;
  const ing = String(ingredientName).trim().toLowerCase();
  const entry = STRENGTH_DETERMINED_ATCS.find(e => e.ingredient.toLowerCase() === ing);
  if (!entry) return null;

  const strength = parseMgStrength(productName);
  if (strength == null) return null; // unparseable strength → don't override

  for (const rule of entry.rules) {
    const okMax = rule.maxStrength == null || strength <= rule.maxStrength;
    const okMin = rule.minStrength == null || strength >= rule.minStrength;
    if (okMax && okMin) {
      return { atcs: rule.atcs, note: rule.note || "", ingredient: entry.ingredient,
               matchedStrength: strength, unit: entry.unit || "" };
    }
  }
  return { atcs: entry.defaultAtcs, note: entry.defaultNote || "", ingredient: entry.ingredient,
           matchedStrength: strength, unit: entry.unit || "" };
}
