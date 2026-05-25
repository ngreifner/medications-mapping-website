// atc-active-moiety-curated.js — Curated mapping from a RxNorm IN/PIN to
// the active-moiety IN/PIN that RxClass uses for ATC L5 attribution.
//
// Why this file exists: WHO ATC attributes L5 codes to the active moiety
// (e.g., N05AN01 = "lithium", L04AA06 = "mycophenolic acid", N03AG01 =
// "valproic acid"). RxNorm, by contrast, often models the SCD/SBD's
// ingredient as the salt / ester / prodrug form ("lithium carbonate",
// "mycophenolate mofetil", "valproate"). The two graphs do not always meet
// — for some drugs there is no `/related.json` path between the RxNorm IN
// and the active-moiety RxCUI that classMembers attributes the L5 to. The
// resolver's Pass-1 (matchIds ∩ classMembers.rxcui) therefore misses, the
// L4→L5 promotion falls through, and the resolver returns only the L4.
//
// This file plugs that gap with a small hand-maintained alias table.
//
// How matching works: the resolver builds matchIds from
// {input, related INs, related PINs}. After that, it consults this table
// and adds any aliases to matchIds. Then Pass-1 proceeds as usual.
//
// License posture: the same posture as atc-combinations-curated.js — these
// are factual RxNorm RxCUI ↔ RxCUI mappings we (Navina) author from
// public RxNav data. Each entry should carry a `note` explaining why the
// pair needs an alias.
//
// How to add an entry: append to the array below. Keys are strings (RxCUIs
// are string-typed throughout the resolver to avoid integer-coercion
// surprises).
//
// Fields:
//   from   — RxNorm IN/PIN RxCUI as a string (the one RxNorm uses for the
//            product's ingredient)
//   to     — active-moiety IN/PIN RxCUI as a string (the one RxClass
//            attributes the L5 to)
//   note   — short free text for human reviewers

export const ACTIVE_MOIETY_ALIASES = [
  // ── Lithium salts → lithium cation (N05AN01) ────────────────────
  // RxClass attributes N05AN01 to RxCUI 6448 ("Lithium Cation"), but
  // RxNorm models lithium products with IN 42351 ("lithium carbonate").
  // No /related path bridges the two — they are sibling concepts.
  { from: "42351", to: "6448", note: "lithium carbonate IN → lithium cation IN (N05AN01)" },

  // ── Valproate / divalproex → valproic acid (N03AG01) ───────────
  // WHO N03AG01 is attributed to RxCUI 11118 ("valproic acid" PIN). The
  // valproate IN (40254) lists 11118 as a related PIN, but only one
  // direction away — getPinRxcuis on the product returns the salt PIN
  // ("divalproex sodium" / "sodium valproate") and not the parent acid
  // PIN. We bridge directly here for both the IN and the common salt PIN.
  { from: "40254",  to: "11118", note: "valproate IN → valproic acid PIN (N03AG01)" },
  { from: "266856", to: "11118", note: "divalproex sodium PIN → valproic acid PIN" },
  { from: "9919",   to: "11118", note: "sodium valproate PIN → valproic acid PIN" },
  { from: "1927",   to: "11118", note: "calcium valproate PIN → valproic acid PIN" },
  { from: "134422", to: "11118", note: "magnesium valproate PIN → valproic acid PIN" },

  // ── Mycophenolate mofetil → mycophenolic acid (L04AA06) ────────
  // WHO L04AA06 is attributed to RxCUI 7145 ("mycophenolic acid" IN).
  // RxNorm models the prodrug (MMF, RxCUI 68149) as a sibling IN with no
  // graph path to 7145. Same prodrug-to-active-moiety problem applies to
  // mycophenolate sodium products (which RxNorm sometimes models with
  // a separate IN).
  { from: "68149", to: "7145", note: "mycophenolate mofetil IN → mycophenolic acid IN (L04AA06)" },
];

// Build a O(1) lookup index keyed by `from`.
const ALIAS_INDEX = new Map();
for (const entry of ACTIVE_MOIETY_ALIASES) {
  const list = ALIAS_INDEX.get(entry.from) || [];
  list.push(entry.to);
  ALIAS_INDEX.set(entry.from, list);
}

/**
 * Expand a list of RxNorm RxCUIs with their curated active-moiety aliases.
 *
 * @param {Array<string|number>} rxcuis - source list (ingredient + related)
 * @returns {string[]} de-duplicated list including aliases
 */
export function expandWithActiveMoietyAliases(rxcuis) {
  if (!Array.isArray(rxcuis)) return [];
  const set = new Set(rxcuis.map(id => String(id)));
  for (const id of [...set]) {
    const aliases = ALIAS_INDEX.get(id);
    if (aliases) for (const a of aliases) set.add(a);
  }
  return [...set];
}
