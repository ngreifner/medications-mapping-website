// atc-combinations-curated.js, Navina-curated combination-product ATC L5s.
//
// Why this file exists: WHO ATC defines dedicated Level 5 codes for many
// combination products (e.g. C09DA03 "valsartan and diuretics" for HCTZ +
// valsartan), but those codes are not reachable through any of RxNav's
// public surfaces — not classMembers, not byRxcui, not byId, not
// property.json, not classTree. This file fills the gap with a small,
// hand-curated mapping that we (Navina) author from products our clinical
// workflows actually see.
//
// License posture: every entry below is an original mapping that we author
// based on inspecting the product's ingredient set and looking up the
// corresponding WHO ATC L5 code. Individual ATC codes are not
// copyrightable (they're short identifiers — facts). The class names
// associated with each code are short factual descriptions paraphrased
// from WHO's catalog. This is consistent with the project's
// "stay on public APIs and surface their limits honestly" principle: we
// own this small file outright instead of vendoring WHO's catalog under
// its restrictive license.
//
// How matching works: the resolver passes the input drug's IN-ingredient
// names (lowercase) as a Set. We scan this array for the first entry
// whose `ingredients` set equals the input set exactly (set equality, not
// subset). When matched, the resolver returns { code, name } with
// provenance "curated combination catalog".
//
// How to add an entry: append to the array below. The fields are:
//   l5           — the WHO ATC Level 5 code (7 chars, e.g. "C09DA03")
//   name         — short class name, lowercase, free of WHO formatting
//                  artifacts (we don't need to match WHO exactly here;
//                  this is what we show on the kept card)
//   ingredients  — array of RxNorm IN ingredient names (lowercase, in
//                  any order, set semantics on match). Use the canonical
//                  RxNorm spelling (e.g. "hydrochlorothiazide" not "HCTZ",
//                  "acetaminophen" not "paracetamol" — RxNorm's US INN
//                  spellings, since that's what `combinationIngredients`
//                  carries).
//   note         — optional free text shown in the kept-card provenance
//
// Multiple entries can map to the same L5 (e.g. N04BA02 covers both
// carbidopa+levodopa and benserazide+levodopa — two distinct ingredient
// sets, one WHO code).

export const CURATED_COMBINATIONS = [
  // ─── C09BA — ACE inhibitors + diuretics ──────────────────────────
  { l5: "C09BA02", name: "enalapril and diuretics",   ingredients: ["enalapril", "hydrochlorothiazide"] },
  { l5: "C09BA03", name: "lisinopril and diuretics",  ingredients: ["lisinopril", "hydrochlorothiazide"] },
  { l5: "C09BA04", name: "perindopril and diuretics", ingredients: ["perindopril", "indapamide"] },
  { l5: "C09BA05", name: "ramipril and diuretics",    ingredients: ["ramipril", "hydrochlorothiazide"] },
  { l5: "C09BA06", name: "quinapril and diuretics",   ingredients: ["quinapril", "hydrochlorothiazide"] },
  { l5: "C09BA07", name: "benazepril and diuretics",  ingredients: ["benazepril", "hydrochlorothiazide"] },
  { l5: "C09BA09", name: "fosinopril and diuretics",  ingredients: ["fosinopril", "hydrochlorothiazide"] },
  { l5: "C09BA13", name: "moexipril and diuretics",   ingredients: ["moexipril", "hydrochlorothiazide"] },

  // ─── C09BB — ACE inhibitors + calcium channel blockers ───────────
  { l5: "C09BB03", name: "lisinopril and amlodipine", ingredients: ["lisinopril", "amlodipine"] },
  { l5: "C09BB04", name: "perindopril and amlodipine", ingredients: ["perindopril", "amlodipine"] },
  { l5: "C09BB07", name: "ramipril and amlodipine",   ingredients: ["ramipril", "amlodipine"] },
  { l5: "C09BB10", name: "trandolapril and verapamil", ingredients: ["trandolapril", "verapamil"] },

  // ─── C09DA — ARBs + diuretics ────────────────────────────────────
  { l5: "C09DA01", name: "losartan and diuretics",    ingredients: ["losartan", "hydrochlorothiazide"] },
  { l5: "C09DA02", name: "eprosartan and diuretics",  ingredients: ["eprosartan", "hydrochlorothiazide"] },
  { l5: "C09DA03", name: "valsartan and diuretics",   ingredients: ["valsartan", "hydrochlorothiazide"] },
  { l5: "C09DA04", name: "irbesartan and diuretics",  ingredients: ["irbesartan", "hydrochlorothiazide"] },
  { l5: "C09DA06", name: "candesartan and diuretics", ingredients: ["candesartan", "hydrochlorothiazide"] },
  { l5: "C09DA07", name: "telmisartan and diuretics", ingredients: ["telmisartan", "hydrochlorothiazide"] },
  { l5: "C09DA08", name: "olmesartan and diuretics",  ingredients: ["olmesartan", "hydrochlorothiazide"] },
  { l5: "C09DA09", name: "azilsartan and diuretics",  ingredients: ["azilsartan", "hydrochlorothiazide"] },

  // ─── C09DB — ARBs + amlodipine ───────────────────────────────────
  { l5: "C09DB01", name: "valsartan and amlodipine",  ingredients: ["valsartan", "amlodipine"] },
  { l5: "C09DB02", name: "olmesartan and amlodipine", ingredients: ["olmesartan", "amlodipine"] },
  { l5: "C09DB04", name: "telmisartan and amlodipine", ingredients: ["telmisartan", "amlodipine"] },
  { l5: "C09DB05", name: "irbesartan and amlodipine", ingredients: ["irbesartan", "amlodipine"] },
  { l5: "C09DB06", name: "losartan and amlodipine",   ingredients: ["losartan", "amlodipine"] },
  { l5: "C09DB07", name: "candesartan and amlodipine", ingredients: ["candesartan", "amlodipine"] },

  // ─── C09DX — three-component ARB combinations ────────────────────
  { l5: "C09DX01", name: "valsartan, amlodipine and hydrochlorothiazide",
    ingredients: ["valsartan", "amlodipine", "hydrochlorothiazide"] },
  { l5: "C09DX03", name: "olmesartan medoxomil, amlodipine and hydrochlorothiazide",
    ingredients: ["olmesartan", "amlodipine", "hydrochlorothiazide"] },

  // ─── C07BB — selective beta-blockers + thiazides ─────────────────
  { l5: "C07BB02", name: "metoprolol and thiazides", ingredients: ["metoprolol", "hydrochlorothiazide"] },
  { l5: "C07BB07", name: "bisoprolol and thiazides", ingredients: ["bisoprolol", "hydrochlorothiazide"] },

  // ─── A06AD — osmotic laxative combinations ───────────────────────
  // Macrogol (PEG 3350) + electrolytes for colonoscopy prep (Gavilyte-H,
  // MoviPrep, GoLYTELY etc.). WHO models this as a single combination L5;
  // RxNorm explodes the formulation into 4–5 separate ingredients.
  { l5: "A06AD15", name: "macrogol, combinations",
    ingredients: ["polyethylene glycol 3350", "potassium chloride", "sodium bicarbonate", "sodium chloride"] },

  // ─── N04BA — dopa and decarboxylase inhibitors ───────────────────
  { l5: "N04BA02", name: "levodopa and decarboxylase inhibitor",
    ingredients: ["carbidopa", "levodopa"] },
  { l5: "N04BA02", name: "levodopa and decarboxylase inhibitor",
    ingredients: ["benserazide", "levodopa"] },
  { l5: "N04BA03", name: "levodopa, decarboxylase inhibitor and COMT inhibitor",
    ingredients: ["carbidopa", "levodopa", "entacapone"] },
];

/**
 * Look up a curated combination match. Returns { l5, name, ingredients } if
 * the input ingredient set equals any entry's ingredient set exactly, or
 * null otherwise. Set equality (not subset) — a 2-ingredient input must
 * not match a 3-ingredient entry.
 *
 * @param {string[]} ingredientNames - RxNorm IN names, free-cased; we
 *                                     lowercase + trim before matching.
 * @returns {{ l5: string, name: string, ingredients: string[] } | null}
 */
export function findCuratedCombination(ingredientNames) {
  if (!Array.isArray(ingredientNames) || ingredientNames.length < 2) return null;
  const inputSet = new Set(
    ingredientNames
      .map(n => String(n || "").trim().toLowerCase())
      .filter(Boolean)
  );
  if (inputSet.size < 2) return null;

  for (const entry of CURATED_COMBINATIONS) {
    const entrySet = new Set(entry.ingredients.map(s => s.toLowerCase()));
    if (entrySet.size !== inputSet.size) continue;
    let equal = true;
    for (const ing of inputSet) {
      if (!entrySet.has(ing)) { equal = false; break; }
    }
    if (equal) return entry;
  }
  return null;
}
