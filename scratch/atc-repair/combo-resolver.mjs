// scratch/atc-repair/combo-resolver.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getWhoName, isCombinationCode, listCombinationL5sInL4 } from "./who-full-index.mjs";
import { findCuratedCombination } from "../../js/atc-combinations-curated.js";
import { parseAtcL5Name, scoreL5Match } from "../../js/who-atc-index.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SYNONYMS = JSON.parse(fs.readFileSync(path.join(REPO, "data/who-inn-synonyms.json"), "utf8"));

/** Map a US/RxNorm ingredient name onto its INN spelling when one exists.
 *  data/who-inn-synonyms.json's real shape is `{ map: { "<us-name>": "<inn-name>", ... } }`
 *  (confirmed by reading the file — not a flat top-level map), so the direct
 *  top-level lookup below only ever hits the `.map` fallback in practice. Both
 *  are kept so this helper degrades gracefully if the file's shape ever changes.
 */
function normalizeIngredient(name) {
  const n = String(name).toLowerCase().trim();
  const direct = SYNONYMS[n] || (SYNONYMS.map && SYNONYMS.map[n]);
  if (typeof direct === "string") return direct.toLowerCase();
  return n;
}

function normSet(names) {
  return new Set(names.filter(Boolean).map(normalizeIngredient));
}

const MIN_SCORE = 80; // EXACT (100) and CLASS (80) accepted; WILDCARD (40) rejected
const SCORE_CLASS = 80;

/**
 * scoreL5Match's WILDCARD tier (40) exists for names like "combinations" with
 * no explicit ingredient at all, or where the explicit ingredient is a weak
 * signal on its own. But WHO also uses the identical wildcard SHAPE for names
 * like "lidocaine, combinations" (parseAtcL5Name -> {type:"wildcard",
 * explicit:["lidocaine"], wildcards:["combinations"]}) to mean "lidocaine plus
 * one or more other active substances, unspecified" — i.e. a genuine,
 * unambiguous single-ingredient anchor. When that anchor ingredient IS one of
 * our input ingredients, this is exactly as strong a signal as the generic
 * CLASS tier (an ingredient/class membership + wildcard). scoreL5Match itself
 * can't tell these two wildcard uses apart (it has no notion of "how strong is
 * this particular wildcard"), so this promotion lives here, at the call site,
 * rather than inside scoreL5Match's shared scoring behavior used elsewhere in
 * the live app.
 */
function scoreL5MatchForCombo(inputSet, parsed) {
  const base = scoreL5Match(inputSet, parsed);
  if (base >= SCORE_CLASS) return base;
  if (
    parsed &&
    parsed.type === "wildcard" &&
    parsed.explicit.length === 1 &&
    inputSet.has(parsed.explicit[0])
  ) {
    return SCORE_CLASS;
  }
  return base;
}

export function resolveComboCode({ ingredientNames = [], currentCodes = [], minAtcCodes = [] }) {
  const ings = (ingredientNames || []).filter(Boolean);
  if (ings.length < 2) return { code: null, provenance: "not_combination", candidates: [] };

  // S1 — the MIN concept's own ATC property. `minAtcCodes` is defined as
  // "codes attributed to the multi-ingredient concept's own RxNorm property
  // lookup" — by construction that's already the combined entity's WHO
  // classification, so a single hit is trusted outright (mirrors the live
  // resolver's Rule 2 / minProvenance path in js/atc-resolver.js, which has
  // no name-pattern filter either). isCombinationCode's name heuristic is
  // name-driven (no code text like "combinations"/"and" to key off of) and
  // misses real combinations whose L5 display name looks single-ingredient
  // shaped — e.g. A10AD05 "insulin aspart" is WHO's code for the biphasic
  // insulin-aspart/insulin-aspart-protamine premix; its own L5 name never
  // says "combination" even though its L4 (A10AD) is entirely a combination
  // class ("...intermediate- or long-acting combined with fast-acting").
  // Requiring isCombinationCode on a single minAtcCodes entry would silently
  // drop a case exactly like that. Only fall back to the name heuristic when
  // there's more than one candidate and we need to pick among them.
  //
  // Deliberate trust decision (documented for the record, not a gap we're
  // silently accepting): a MIN's own /property.json?propName=ATC could in
  // principle return a single code that is a genuine mono-ingredient
  // classification rather than the combination's own — NLM's curation of
  // MIN properties isn't exhaustively auditable from here. We accept this
  // risk rather than add new filtering, for two reasons. First, this exact
  // trust shape already ships in production: js/atc-resolver.js's
  // fetchMinAncestorL5 (~lines 131-151) takes the FIRST 7-character code
  // from a MIN's raw property list with no isCombinationCode/name filter at
  // all, so this resolver is already MORE conservative than what's live
  // today, not a widening of risk. Second, every row this strategy touches
  // is written to Task 5's pass1-changes.csv with provenance="min_property",
  // so any mono-shaped false positive is auditable by a human later rather
  // than trusted forever in silence. See scratch/atc-repair/combo-resolver.test.mjs
  // for the adversarial case (J01CA04 "amoxicillin") that makes this behavior
  // visible and intentional.
  const minCodes = (minAtcCodes || []).filter(Boolean);
  if (minCodes.length === 1) return { code: minCodes[0], provenance: "min_property", candidates: minCodes };
  const minCombo = minCodes.filter(isCombinationCode);
  if (minCombo.length === 1) return { code: minCombo[0], provenance: "min_property", candidates: minCombo };

  // S2 — a combination code already present in the current cell
  const presentCombo = (currentCodes || []).filter(isCombinationCode);
  if (presentCombo.length === 1) return { code: presentCombo[0], provenance: "current_cell", candidates: presentCombo };

  // S3 — hand-curated catalog (set equality on RxNorm IN names)
  const curated = findCuratedCombination(ings);
  if (curated && curated.l5) return { code: curated.l5, provenance: "curated", candidates: [curated.l5] };

  // S4 — WHO full-index name match, searching the L4s implied by the codes we already have
  const l4s = new Set();
  for (const c of [...currentCodes, ...minAtcCodes, ...minCombo]) {
    if (c && c.length >= 5) l4s.add(c.slice(0, 5).toUpperCase());
  }
  const inputSet = normSet(ings);
  const scored = [];
  for (const l4 of l4s) {
    for (const l5 of listCombinationL5sInL4(l4)) {
      const parsed = parseAtcL5Name(getWhoName(l5) || "");
      const score = scoreL5MatchForCombo(inputSet, parsed);
      if (score >= MIN_SCORE) scored.push({ code: l5, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const best = scored.filter((s) => s.score === (scored[0] && scored[0].score));
  if (best.length === 1) return { code: best[0].code, provenance: "who_index", candidates: scored.map((s) => s.code) };
  // ambiguous tie -> refuse to guess
  if (best.length > 1) return { code: null, provenance: "ambiguous", candidates: best.map((s) => s.code) };

  return { code: null, provenance: "none", candidates: [] };
}
