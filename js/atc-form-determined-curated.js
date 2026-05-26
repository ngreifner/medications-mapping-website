// atc-form-determined-curated.js — Navina-curated table for substances
// where WHO ATC assigns multiple Level-5 codes based on formulation, not
// anatomical route.
//
// Why this file exists: a handful of substances carry dual L5 codes that
// the standard route filter cannot distinguish, because both codes pass the
// same route's allow/exclude matrix. Methotrexate is the canonical case:
//
//   L01BA01 — antineoplastic     (vials, powder for injection, infusion)
//   L04AX03 — immunosuppressant  (auto-injector, prefilled pen/syringe, oral)
//
// Both pass the "injectable" route filter (neither L01 nor L04 is excluded
// for injectables), so the engine can't pick between them by route alone.
// ATCPROD also short-circuits — it returns L01BA only for every methotrexate
// product, regardless of dose form — which means SC auto-injectors (Rasuvo,
// Otrexup) lose L04AX03 even though that's the clinically correct code for
// rheumatoid arthritis / psoriasis indications.
//
// This table inverts the question: for substances we know carry dual ATCs,
// pick the L5(s) explicitly based on the RxNorm DF (Dose Form). The DF is
// the specific dose form name (e.g. "Auto-Injector", "Oral Tablet",
// "Injectable Solution") — finer-grained than the DFG (Dose Form Group)
// used elsewhere in the engine.
//
// How to add a substance: append an entry to FORM_DETERMINED_ATCS with the
// RxNorm IN name (lowercase) and the form rules. First-match-wins within
// formRules. If no rule matches the product's DF, defaultAtcs is used.

export const FORM_DETERMINED_ATCS = [
  {
    ingredient: "methotrexate",
    formRules: [
      {
        // Auto-injector, prefilled pen, and prefilled syringe — the WHO
        // L04AX03 carriers for self-administered subcutaneous methotrexate.
        forms: [
          "Auto-Injector",
          "Prefilled Syringe",
          "Pen Injector",
        ],
        atcs: [{ code: "L04AX03", name: "methotrexate" }],
        note: "Self-administered SC device — WHO L04AX03 (immunosuppressant)",
      },
      {
        // Oral methotrexate is the immunosuppressant for RA / psoriasis /
        // other autoimmune indications.
        forms: [
          "Oral Tablet",
          "Oral Capsule",
          "Oral Solution",
          "Disintegrating Oral Tablet",
        ],
        atcs: [{ code: "L04AX03", name: "methotrexate" }],
        note: "Oral methotrexate — WHO L04AX03 (immunosuppressant)",
      },
    ],
    // Default: vials, powder for injection, injectable solution, infusion —
    // the high-dose parenteral forms used in oncology.
    defaultAtcs: [{ code: "L01BA01", name: "methotrexate" }],
    defaultNote: "Vial / injectable solution / infusion — WHO L01BA01 (antineoplastic)",
  },
];

/**
 * Look up a substance's form-determined ATCs, if any.
 *
 * @param {string} ingredientName - RxNorm IN name (any case)
 * @param {string[]} doseForms    - Array of RxNorm DF names for the product
 * @returns {{
 *   atcs: Array<{code:string, name:string}>,
 *   note: string,
 *   ingredient: string,
 *   matchedForm: string|null,
 * } | null}  null if the ingredient isn't in the table.
 */
export function findFormDeterminedAtcs(ingredientName, doseForms) {
  if (!ingredientName) return null;
  const ing = String(ingredientName).trim().toLowerCase();
  const dfs = (Array.isArray(doseForms) ? doseForms : [])
    .map(d => String(d || "").trim())
    .filter(Boolean);

  for (const entry of FORM_DETERMINED_ATCS) {
    if (entry.ingredient.toLowerCase() !== ing) continue;
    for (const rule of entry.formRules) {
      const ruleForms = rule.forms.map(f => f.toLowerCase());
      const matchedForm = dfs.find(d => ruleForms.includes(d.toLowerCase()));
      if (matchedForm) {
        return {
          atcs: rule.atcs,
          note: rule.note || "",
          ingredient: entry.ingredient,
          matchedForm,
        };
      }
    }
    return {
      atcs: entry.defaultAtcs,
      note: entry.defaultNote || "",
      ingredient: entry.ingredient,
      matchedForm: null,
    };
  }
  return null;
}
