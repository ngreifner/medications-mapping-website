// scratch/atc-repair/combo-resolver.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getWhoName, isCombinationCode, listCombinationL5sInL4, listAllCombinationL4s } from "./who-full-index.mjs";
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

  // S4 — WHO full-index name match, searching the L4s implied by the codes we already have
  const inputSet = normSet(ings);

  function scoreCandidates(l5List) {
    const scored = [];
    for (const l5 of l5List) {
      const parsed = parseAtcL5Name(getWhoName(l5) || "");
      const score = scoreL5MatchForCombo(inputSet, parsed);
      if (score >= MIN_SCORE) scored.push({ code: l5, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored;
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

  // S4 — WHO full-index name match, searching the L4s implied by the codes
  // we already have. Deliberately narrow first: this is a free, zero-cost
  // signal when the row's current (possibly wrong-route) codes happen to
  // already share an L4 with the real answer, and keeping it narrow avoids
  // pulling in unrelated combination entries that would otherwise create
  // spurious ties for common single-anchor wildcard names (e.g. searching
  // the entire index for "epinephrine" pulls in R03AK01 "epinephrine and
  // other drugs for obstructive airway diseases" alongside the correct
  // local-anesthetic answer, even though the row has nothing to do with
  // asthma inhalers).
  const narrowL4s = new Set();
  for (const c of [...currentCodes, ...minAtcCodes, ...minCombo]) {
    if (c && c.length >= 5) narrowL4s.add(c.slice(0, 5).toUpperCase());
  }
  const narrowCandidates = [];
  for (const l4 of narrowL4s) narrowCandidates.push(...listCombinationL5sInL4(l4));
  const narrowScored = scoreCandidates(narrowCandidates);
  if (narrowScored.length) return pickFrom(narrowScored, "who_index");

  // S5 — widen to EVERY L4 in WHO's index that has at least one
  // combination-shaped L5 underneath it (listAllCombinationL4s(), ~921 L4s
  // total, cheap/offline). Only reached when the narrow search above found
  // nothing at all -- i.e. the product's *current* codes (which may
  // themselves be wrong-route pollution -- the exact defect this sweep
  // exists to fix) don't share an L4 with WHO's real dedicated combination
  // code at all. Example: a topical/oral-anesthetic combo (benzocaine +
  // butamben + tetracaine) currently miscoded under C05AD/D04AB/R02AD,
  // whose actual WHO code (N01BA53 "tetracaine, combinations") lives under
  // N01BA -- never reachable from those L4s. Safe to widen because
  // scoreL5MatchForCombo keys on the real RxNorm ingredient names, which are
  // substance-specific: a wildcard/class/exact match anywhere else in the
  // index is WHO's own dedicated code for that substance, not a
  // cross-domain false positive. Gating this behind "narrow search found
  // nothing" (rather than always searching wide) keeps the narrow search's
  // tighter, less tie-prone candidate set as the default path whenever it
  // has any signal at all.
  const wideCandidates = [];
  for (const l4 of listAllCombinationL4s()) wideCandidates.push(...listCombinationL5sInL4(l4));
  const wideScored = scoreCandidates(wideCandidates);
  if (wideScored.length) return pickFrom(wideScored, "who_index_wide");

  return { code: null, provenance: "none", candidates: [] };
}
