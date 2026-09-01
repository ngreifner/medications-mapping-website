import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RAW = JSON.parse(fs.readFileSync(path.join(REPO, "data/who-atc-full-index.json"), "utf8"));

// The index stores display names in `names` and/or `l5`; merge both, preferring a non-empty value.
const NAMES = new Map();
for (const src of [RAW.names, RAW.l5]) {
  if (!src) continue;
  for (const [code, val] of Object.entries(src)) {
    const name = typeof val === "string" ? val : (val && (val.name || val.className)) || "";
    if (name && !NAMES.get(code)) NAMES.set(code.toUpperCase(), name);
  }
}

export function getWhoName(code) {
  return NAMES.get(String(code).toUpperCase()) || null;
}

/**
 * A code is a combination when WHO's own published name says so.
 * Patterns observed across the 5,551 L5 entries:
 *   ", combinations"            -> "lidocaine, combinations"
 *   ", combinations excl. ..."  -> "paracetamol, combinations excl. psycholeptics"
 *   "X and Y"                   -> "hydrocodone and paracetamol"
 *   "combinations of X and Y"   -> "combinations of sulfonamides and trimethoprim"
 *   "X and diuretics" / "... and beta-lactamase inhibitor" (ingredient + drug class)
 * Deliberately name-driven: no hardcoded prefix list (spec R3).
 */
export function isCombinationCode(code) {
  const name = getWhoName(code);
  if (!name) return false;
  const n = name.toLowerCase();
  if (/,\s*combinations?\b/.test(n)) return true;
  if (/^combinations?\b/.test(n)) return true;
  if (/\bcombinations? (of|with)\b/.test(n)) return true;
  if (/\s+and\s+/.test(n)) return true;
  return false;
}

export function listL5sInL4(l4) {
  const prefix = String(l4).toUpperCase();
  const out = [];
  for (const code of NAMES.keys()) if (code.length === 7 && code.startsWith(prefix)) out.push(code);
  return out.sort();
}

export function listCombinationL5sInL4(l4) {
  return listL5sInL4(l4).filter(isCombinationCode);
}

/** Every combination-shaped L5 in the whole WHO index, regardless of L4. Used
 *  by combo-resolver.mjs's widened S5 fallback for cases where the product's
 *  *current* (possibly wrong-route/polluted) codes don't share an L4 with
 *  WHO's actual dedicated combination code -- see combo-resolver.mjs for why
 *  this is safe to search unrestricted. */
export function listAllCombinationL5s() {
  const out = [];
  for (const code of NAMES.keys()) if (code.length === 7 && isCombinationCode(code)) out.push(code);
  return out.sort();
}

/** Every L4 prefix (5-char code) that has at least one combination-shaped L5
 *  underneath it, across the *entire* WHO index — not just the L4s implied by
 *  some row's (possibly wrong) current codes. Used by combo-resolver.mjs's S4
 *  to make sure the candidate search space is never smaller than "every
 *  combination code WHO defines," so a correct answer under an L4 that a
 *  row's current mis-mapping never touched (e.g. N01BA for a product
 *  currently miscoded under C05AD/D04AB/R02AD) is still reachable. Cheap,
 *  pure, offline: ~921 L4s total in the index. */
export function listAllCombinationL4s() {
  const l4s = new Set();
  for (const code of NAMES.keys()) if (code.length === 5) l4s.add(code);
  const out = [];
  for (const l4 of l4s) if (listCombinationL5sInL4(l4).length > 0) out.push(l4);
  return out.sort();
}

export function indexStats() {
  let l4 = 0, l5 = 0;
  for (const c of NAMES.keys()) { if (c.length === 5) l4++; else if (c.length === 7) l5++; }
  return { l4, l5, total: NAMES.size };
}
