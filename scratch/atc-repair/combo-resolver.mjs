// scratch/atc-repair/combo-resolver.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getWhoName, isCombinationCode, listAllCombinationL5s } from "./who-full-index.mjs";
import { findCuratedCombination } from "../../js/atc-combinations-curated.js";
import { parseAtcL5Name, scoreL5Match } from "../../js/who-atc-index.js";
import { resolveRoute, classifyAtcForRoute } from "../../js/filter-engine.js";

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
 * our input ingredients, this is a real signal — but it is NOT as strong as an
 * actual EXACT/CLASS match from scoreL5Match itself, because a bare single-
 * ingredient wildcard name can't tell "lidocaine + epinephrine" apart from
 * "lidocaine + literally anything else". Two different substances can each
 * carry their own "<substance>, combinations" wildcard entry under two
 * unrelated L4s (e.g. both "lidocaine, combinations" and "epinephrine,
 * combinations" match a lidocaine+epinephrine product), so this tier is kept
 * strictly SEPARATE from, and subordinate to, real EXACT/CLASS matches — see
 * `isPromotable` below and how the two tiers are used in resolveComboCode.
 */
// Restricted further to WHO's literal ", combinations" suffix shape
// (parsed.wildcards === ["combinations"]) — NOT the broader "X and other
// <descriptive phrase>" wildcard shape (e.g. R03AK01 "epinephrine and other
// drugs for obstructive airway diseases"). Both parse to `type: "wildcard"`
// with a single explicit ingredient, but only the bare ", combinations"
// suffix is WHO's generic "this substance plus something unspecified"
// bucket; a descriptive wildcard phrase names a specific *other* clinical
// context (asthma/COPD drugs) that has nothing to do with an arbitrary
// second ingredient the input happens to contain. Confirmed live: without
// this restriction, a lidocaine+epinephrine local-anesthetic product's
// promoted-tier search wrongly pulls in R03AK01 as a third tied candidate
// alongside the correct N01BB52 and the anatomically-wrong S01EA51, and
// R03AK01 also survives the injectable route tie-break (R03 isn't excluded
// under the injectable route matrix), leaving TWO candidates tied instead of
// resolving to the single correct one.
function isPromotable(inputSet, parsed) {
  return (
    parsed &&
    parsed.type === "wildcard" &&
    parsed.wildcards.length === 1 &&
    parsed.wildcards[0] === "combinations" &&
    parsed.explicit.length === 1 &&
    inputSet.has(parsed.explicit[0])
  );
}

export function resolveComboCode({ ingredientNames = [], currentCodes = [], minAtcCodes = [], dfgs = [], route = null }) {
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

  // S4 — WHO full-index name match. Always scores against the FULL universe
  // of WHO combination codes (listAllCombinationL5s(), memoized, ~cheap) —
  // NOT just the L4s implied by the row's own current codes. Restricting the
  // pool first was the bug: a row's *current* code is exactly the thing this
  // whole repair effort doesn't trust, so building the candidate search space
  // from it can hand a lone, non-tied, wrong-domain match a free pass with no
  // competing candidate to tie against. See the "strong vs promoted" split
  // below for how a wide pool is kept safe.
  const inputSet = normSet(ings);

  // Score every WHO combination L5 into two strictly separate tiers:
  //   - strong:   scoreL5Match's own EXACT (100) or CLASS (80) tiers — a real
  //     WHO-authored ingredient/class match, not a single-anchor promotion.
  //   - promoted: scoreL5Match's WILDCARD tier (40), promoted to 80 only when
  //     the wildcard's lone explicit ingredient is in the input (see
  //     isPromotable). This is a WEAKER signal than "strong" even though the
  //     promoted score number is the same 80 — a wildcard name like
  //     "morphine, combinations" matches ANY product containing morphine,
  //     regardless of what it's combined with, so two different substances in
  //     a combo can each surface their OWN unrelated "<substance>,
  //     combinations" entry under two different L4s (this is exactly how the
  //     morphine+naltrexone false positive happened: A07DA52 "morphine,
  //     combinations" — antidiarrheal domain — beat out nothing, because the
  //     row's own wrong current code (A07DA03) put A07DA in the search pool
  //     and no competing candidate was ever considered).
  //
  // A promoted candidate is NEVER allowed to compete or tie against a strong
  // one: if ANY strong candidate exists anywhere in the wide universe, the
  // promoted tier is not even consulted. Promoted candidates only compete
  // against EACH OTHER (and then via the route tie-break) when the strong
  // tier is completely empty.
  function scoreAll(l5List) {
    const strong = [];
    const promoted = [];
    for (const l5 of l5List) {
      const parsed = parseAtcL5Name(getWhoName(l5) || "");
      if (!parsed) continue;
      const base = scoreL5Match(inputSet, parsed);
      if (base >= MIN_SCORE) {
        strong.push({ code: l5, score: base });
      } else if (isPromotable(inputSet, parsed)) {
        promoted.push({ code: l5, score: SCORE_CLASS });
      }
    }
    strong.sort((a, b) => b.score - a.score);
    promoted.sort((a, b) => b.score - a.score);
    return { strong, promoted };
  }

  // Tie-break a same-score group by route when possible: a wildcard match like
  // "epinephrine, combinations" (S01EA51, ophthalmic) and "lidocaine,
  // combinations" (N01BB52, local anesthetic) can tie at the same score for an
  // injectable local-anesthetic-with-epinephrine product whose *current*
  // (wrong-route) codes carry both ingredients' unrelated formulations. Route
  // is real evidence here, not a guess: an injectable product's WHO
  // combination code cannot be an ophthalmic-only entry (S01 = WHO's
  // "Sensory organs" anatomical class). `route` is the caller's resolved
  // route string (e.g. "injectable", "topical") and takes priority; `dfgs`
  // (raw DFG names) is kept for backward compatibility with callers that
  // haven't been updated to pass `route` directly yet and is resolved via
  // resolveRoute() only when `route` itself wasn't supplied. classifyAtcForRoute
  // is applied per-candidate (not the bulk filterAtcByRoute helper) so a
  // single anatomically-incompatible candidate can be dropped from a tie
  // without any of filterAtcByRoute's "never return empty" bulk-safety
  // fallback muddying a tie-break decision that's really about ONE bad
  // candidate, not the whole list.
  function pickFrom(scored, provenance) {
    if (!scored.length) return null;
    const topScore = scored[0].score;
    let tied = scored.filter((s) => s.score === topScore);
    if (tied.length > 1) {
      const effectiveRoute = route || (dfgs && dfgs.length ? resolveRoute(dfgs) : null);
      if (effectiveRoute) {
        const routeOk = tied.filter((s) => classifyAtcForRoute(s.code, effectiveRoute).kept);
        if (routeOk.length >= 1 && routeOk.length < tied.length) tied = routeOk;
      }
    }
    if (tied.length === 1) {
      return { code: tied[0].code, provenance, candidates: scored.map((s) => s.code) };
    }
    // still tied after route tie-break (or no route to try) -> refuse to guess
    return { code: null, provenance: "ambiguous", candidates: tied.map((s) => s.code) };
  }

  // S4 — score against the full universe, then dispatch by tier. `strong`
  // (real EXACT/CLASS matches) always wins outright when non-empty; the
  // `promoted` wildcard tier is only ever consulted as a fallback when
  // `strong` is completely empty, and even then only competes against other
  // promoted candidates (never against a strong one, because there isn't
  // one at this point).
  const { strong, promoted } = scoreAll(listAllCombinationL5s());
  if (strong.length) return pickFrom(strong, "who_index");
  if (promoted.length) return pickFrom(promoted, "who_index_wildcard");

  return { code: null, provenance: "none", candidates: [] };
}
