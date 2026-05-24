// js/who-atc-index.js — runtime resolution of combination L5 codes against
// WHO ATC snapshots.
//
// Data source: data/who-atc-snapshots/*.json, refreshed via
// scripts/refresh-who-snapshots.js. The browser runtime imports the
// pre-bundled aggregate (js/who-atc-snapshots-bundle.js) so no network
// calls to WHO happen at query time.
//
// Public API:
//   resolveCombinationViaWHO(l4Code, ingredientNames)
//       → { code, name, score, source_url, refreshed_at, matchType } | null
//   listSnapshottedL4s() → string[]
//   getSnapshotMetadata(l4Code) → { l4_name, source_url, refreshed_at } | null
//
// Algorithm: for the given L4, parse each L5 child's name into a
// structured representation (explicit ingredients + drug-class wildcards),
// then score each candidate against the input ingredient set. The
// highest-scoring unambiguous match above the threshold wins. If two L5s
// tie at the same score, we return null — better to fall back to L4 than
// to pick wrong.

import { WHO_ATC_SNAPSHOTS } from "./who-atc-snapshots-bundle.js";

// ----------------------------------------------------------------
// Normalization
// ----------------------------------------------------------------

// WHO uses INNs (British English); RxNorm uses USAN (American English).
// We normalize WHO → RxNorm spelling so the matcher can compare to the
// ingredient set the resolver fetched from RxNav. Only entries that we've
// actually observed in WHO L5 names are listed.
const WHO_TO_RXNORM_SYNONYMS = {
  "paracetamol": "acetaminophen",
  "acetylsalicylic acid": "aspirin",
  "salbutamol": "albuterol",
  "frusemide": "furosemide",
  "lignocaine": "lidocaine",
};

// Prodrug / ester / salt suffixes WHO sometimes appends that RxNorm strips
// when reducing to the IN concept. "olmesartan medoxomil" must match
// RxNorm's "olmesartan"; same for "azilsartan medoxomil", etc.
const PRODRUG_SUFFIXES = [
  "medoxomil", "mofetil", "cilexetil", "axetil", "pivoxil",
  "tromethamine", "etabonate", "fumarate", "phosphate",
];
const SALT_SUFFIXES = [
  "hydrochloride", "hcl", "sulfate", "sulphate", "tartrate",
  "succinate", "maleate", "mesylate", "citrate", "tosylate",
  "besylate", "sodium", "potassium", "calcium", "magnesium",
  "dihydrate", "monohydrate", "hydrate",
];

function normalizeIngredient(rawName) {
  let s = String(rawName || "").toLowerCase().trim();
  if (!s) return "";
  // Strip prodrug suffixes (only at end of name).
  for (const suffix of PRODRUG_SUFFIXES) {
    s = s.replace(new RegExp(`\\s+${suffix}$`), "");
  }
  // Strip salt suffixes (only at end of name).
  for (const suffix of SALT_SUFFIXES) {
    s = s.replace(new RegExp(`\\s+${suffix}$`), "");
  }
  s = s.trim();
  return WHO_TO_RXNORM_SYNONYMS[s] || s;
}

// ----------------------------------------------------------------
// Drug class membership
// ----------------------------------------------------------------

// WHO L5 names sometimes refer to a constituent ingredient by drug class
// rather than by name (e.g. "valsartan and diuretics", "ceftazidime and
// beta-lactamase inhibitor"). We resolve these by looking up the class
// members against RxNorm IN names that the resolver passes in.
//
// Each class key is the lowercase WHO phrasing exactly as it appears in
// L5 names. Members are normalized RxNorm IN names (lowercase).
const DRUG_CLASSES = {
  "diuretics": [
    "hydrochlorothiazide", "chlorthalidone", "indapamide",
    "bendroflumethiazide", "hydroflumethiazide", "chlorothiazide",
    "methyclothiazide", "metolazone", "amiloride", "triamterene",
  ],
  "decarboxylase inhibitor": ["carbidopa", "benserazide"],
  "beta-lactamase inhibitor": [
    "avibactam", "tazobactam", "sulbactam", "clavulanic acid",
    "clavulanate", "vaborbactam", "relebactam", "durlobactam",
  ],
  "comt inhibitor": ["entacapone", "tolcapone", "opicapone"],
};

// "and other [X]" or ", combinations" — wildcard markers WHO uses when no
// specific L5 fits. We match these only as a last-resort tier (LOW score).
const WILDCARD_PHRASES = new Set([
  "other non-opioid analgesics",
  "other non-narcotic analgesics",
  "combinations",
]);

function isWildcardPhrase(part) {
  return WILDCARD_PHRASES.has(part) || part.startsWith("other ");
}

// ----------------------------------------------------------------
// Name parser
// ----------------------------------------------------------------

/**
 * Parse a WHO L5 name into a structured representation.
 *
 *   "codeine and paracetamol"
 *     → { type: "explicit", explicit: ["codeine", "acetaminophen"], classes: [], wildcards: [] }
 *
 *   "valsartan and diuretics"
 *     → { type: "class",    explicit: ["valsartan"],                classes: ["diuretics"], wildcards: [] }
 *
 *   "levodopa, decarboxylase inhibitor and COMT inhibitor"
 *     → { type: "class",    explicit: ["levodopa"],                 classes: ["decarboxylase inhibitor", "comt inhibitor"], wildcards: [] }
 *
 *   "codeine and other non-opioid analgesics"
 *     → { type: "wildcard", explicit: ["codeine"],                  classes: [], wildcards: ["other non-opioid analgesics"] }
 *
 *   "ceftriaxone, combinations"
 *     → { type: "wildcard", explicit: ["ceftriaxone"],              classes: [], wildcards: ["combinations"] }
 *
 * Returns null when the name doesn't parse as a combination (e.g. a
 * single-ingredient L5 like "levodopa" — we just skip these in matching).
 */
export function parseAtcL5Name(name) {
  const lower = String(name || "").toLowerCase().trim();
  if (!lower) return null;

  // PATTERN: trailing ", combinations" — wildcard
  if (lower.endsWith(", combinations")) {
    const base = lower.slice(0, -", combinations".length).trim();
    return {
      type: "wildcard",
      explicit: [normalizeIngredient(base)],
      classes: [],
      wildcards: ["combinations"],
    };
  }

  // Split on the LAST " and " — handles "X and Y" and "X, Y and Z" alike.
  const andIdx = lower.lastIndexOf(" and ");
  if (andIdx === -1) return null;

  const before = lower.slice(0, andIdx).trim();
  const after = lower.slice(andIdx + 5).trim();
  if (!before || !after) return null;

  // before may contain commas — split into parts.
  const beforeParts = before.split(",").map(s => s.trim()).filter(Boolean);
  const allParts = [...beforeParts, after];

  const explicit = [];
  const classes = [];
  const wildcards = [];

  for (const part of allParts) {
    if (Object.prototype.hasOwnProperty.call(DRUG_CLASSES, part)) {
      classes.push(part);
    } else if (isWildcardPhrase(part)) {
      wildcards.push(part);
    } else {
      explicit.push(normalizeIngredient(part));
    }
  }

  // Must have at least one explicit ingredient — otherwise the L5 isn't
  // actionable for any RxCUI we'd resolve.
  if (explicit.length === 0) return null;

  const type = wildcards.length > 0
    ? "wildcard"
    : classes.length > 0 ? "class" : "explicit";

  return { type, explicit, classes, wildcards };
}

// ----------------------------------------------------------------
// Match scoring
// ----------------------------------------------------------------

const SCORE_EXACT = 100;
const SCORE_CLASS = 80;
const SCORE_WILDCARD = 40;
const MIN_ACCEPTANCE_SCORE = 80;

/**
 * Score a parsed L5 name against the input ingredient set (normalized).
 * Returns 0 when there is no defensible match.
 *
 * Rules:
 *   - explicit: input set must equal the parsed explicit set exactly →
 *     SCORE_EXACT.
 *   - class:    every explicit ingredient must appear in the input, and
 *     every parsed class must have at least one member among the
 *     remaining input ingredients; input size must equal
 *     (explicit + classes) size → SCORE_CLASS.
 *   - wildcard: every explicit ingredient must appear in the input; the
 *     remaining input ingredients are unconstrained → SCORE_WILDCARD.
 */
export function scoreL5Match(inputSet, parsed) {
  if (!parsed || !(inputSet instanceof Set) || inputSet.size === 0) return 0;

  if (parsed.type === "explicit") {
    if (inputSet.size !== parsed.explicit.length) return 0;
    for (const ing of parsed.explicit) {
      if (!inputSet.has(ing)) return 0;
    }
    return SCORE_EXACT;
  }

  if (parsed.type === "class") {
    const expectedSize = parsed.explicit.length + parsed.classes.length;
    if (inputSet.size !== expectedSize) return 0;
    const used = new Set();
    for (const ing of parsed.explicit) {
      if (!inputSet.has(ing)) return 0;
      used.add(ing);
    }
    // For each parsed class, find a remaining ingredient that is a member.
    const remaining = [];
    for (const ing of inputSet) if (!used.has(ing)) remaining.push(ing);
    const remPool = [...remaining];
    for (const cls of parsed.classes) {
      const members = DRUG_CLASSES[cls];
      if (!members) return 0;
      const idx = remPool.findIndex(r => members.includes(r));
      if (idx === -1) return 0;
      remPool.splice(idx, 1);
    }
    return SCORE_CLASS;
  }

  if (parsed.type === "wildcard") {
    if (parsed.explicit.length === 0) return 0;
    if (inputSet.size < parsed.explicit.length) return 0;
    for (const ing of parsed.explicit) {
      if (!inputSet.has(ing)) return 0;
    }
    return SCORE_WILDCARD;
  }

  return 0;
}

// ----------------------------------------------------------------
// Public API
// ----------------------------------------------------------------

export function listSnapshottedL4s() {
  return Object.keys(WHO_ATC_SNAPSHOTS).sort();
}

export function getSnapshotMetadata(l4Code) {
  const snap = WHO_ATC_SNAPSHOTS[String(l4Code).toUpperCase()];
  if (!snap) return null;
  return {
    l4_name: snap.l4_name || "",
    source_url: snap.source_url,
    refreshed_at: snap.refreshed_at,
  };
}

/**
 * Resolve a combination to its dedicated WHO L5 by name-matching against
 * the snapshot for `l4Code`. Returns the matching L5 + provenance, or
 * null if no defensible match is found.
 *
 * @param {string}   l4Code           L4 ATC code (5 chars, e.g. "C09DA")
 * @param {string[]} ingredientNames  RxNorm IN names of the input drug's
 *                                    ingredients; case-insensitive
 * @returns {{ code, name, score, matchType, source_url, refreshed_at } | null}
 */
export function resolveCombinationViaWHO(l4Code, ingredientNames) {
  const l4 = String(l4Code || "").toUpperCase().trim();
  if (!l4) return null;
  const snap = WHO_ATC_SNAPSHOTS[l4];
  if (!snap) return null;
  if (!Array.isArray(ingredientNames) || ingredientNames.length < 2) return null;

  const inputSet = new Set(
    ingredientNames
      .map(normalizeIngredient)
      .filter(Boolean),
  );
  if (inputSet.size < 2) return null;

  let best = null;
  let bestScore = 0;
  let bestMatchType = null;
  let tiedAtBest = false;

  for (const entry of snap.children) {
    const parsed = parseAtcL5Name(entry.name);
    if (!parsed) continue;
    const score = scoreL5Match(inputSet, parsed);
    if (score < MIN_ACCEPTANCE_SCORE) continue;
    if (score > bestScore) {
      best = entry;
      bestScore = score;
      bestMatchType = parsed.type;
      tiedAtBest = false;
    } else if (score === bestScore && best && entry.code !== best.code) {
      tiedAtBest = true;
    }
  }

  if (!best || tiedAtBest) return null;
  return {
    code: best.code,
    name: best.name,
    score: bestScore,
    matchType: bestMatchType,
    source_url: snap.source_url,
    refreshed_at: snap.refreshed_at,
  };
}
