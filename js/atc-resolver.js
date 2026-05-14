// atc-resolver.js, RXCUI → ATC conversion orchestrator.
//
// Ported verbatim (modulo our caching/rate-limiting layer in rxnav-client)
// from the user's working browser app. Strategy order, fallback paths, and
// console.log statements all match the source, this file's Node test output
// is intended to match the browser console line-by-line for the same RXCUI.
//
// Three strategies fire in priority order, with all four endpoints fetched in
// parallel up front so a slow tier doesn't block faster ones:
//   1. ATCPROD product-level mapping (preferred when populated)
//   2. Ingredient-level ATC + DFG route filter
//   3. Property API (last resort)
//   Last-resort: ATCPROD's Level 4 codes if every Level 5 path failed
//
// Where ATCPROD returns Level 4 codes only, they double as a prefix whitelist
// that constrains downstream strategies, preventing combination drugs (e.g.
// R03AL) from being replaced by unrelated single-ingredient codes (e.g. R03BA02).

import {
  getProperties,
  getDfgs,
  getIngredientRxcuis,
  getPinRxcuis,
  getAtcprodClasses,
  getIngredientAtcClasses,
  getAtcPropertyValues,
  getClassMembers,
} from "./rxnav-client.js";
import { resolveRoute, filterAtcByRoute, classifyAtcForRoute } from "./filter-engine.js";

const INGREDIENT_TTYS = new Set(["IN", "MIN", "PIN"]);

/**
 * Given (input RXCUI, list of Level 4 ATC class IDs), promote to Level 5 by
 * walking ATC class members and matching against the input's ingredient
 * RXCUIs. Returns array of {code, name} on success, or null if no Level 5
 * could be resolved.
 *
 * The walk has three matching passes per Level 4 class. The first hit wins:
 *
 *   1. Single-ingredient direct match, member's RXCUI is in the input's
 *      ingredient set. Handles the common case (e.g. fluticasone nasal SCD
 *      → R01AD08 because R01AD's members include fluticasone IN).
 *
 *   2. MIN-equality match, RxClass returns Multiple Ingredient (TTY=MIN)
 *      members for combination L4 classes (e.g. J01EE returns six MIN
 *      concepts, one per WHO L5 combo). Pass 1 fails for combos because
 *      the MIN's RXCUI is its own (e.g. 10831 for sulfamethoxazole/
 *      trimethoprim), which is NOT in a Bactrim product's ingredient set
 *      ({sulfamethoxazole, trimethoprim}). Pass 2 resolves this: for each
 *      MIN member, compare the input's ingredient set to the MIN's
 *      ingredient set; on equality, take the MIN's sourceId as the L5.
 *
 *      This is the clinically correct rule, a combination product
 *      belongs to the multi-ingredient concept that combines exactly the
 *      same ingredients, not to any one ingredient's standalone class.
 *
 *      Skipped for single-ingredient inputs (no benefit + can't false-
 *      positive into a wider MIN).
 *
 *   3. (Bottom-of-function fallback) Walk each ingredient's ATC classes
 *      and pick Level 5 codes whose value starts with one of the target
 *      Level 4 prefixes. Only fires when both Pass 1 and Pass 2 fail for
 *      every L4 in the input.
 */
export async function resolveLevel5FromClassMembers(rxcui, level4ClassIds) {
  // matchIds is the set of RxCUIs we accept as "this drug" when walking
  // class members in Pass 1. We pull both IN and PIN forms in parallel so
  // we can match members whose L5 SourceId is attributed at the salt
  // (PIN) level — e.g. clorazepate dipotassium PIN 2607 carries N05BA05
  // while the bare clorazepate IN 2353 carries only L4 N05BA.
  const [inIds, pinIds] = await Promise.all([
    getIngredientRxcuis(rxcui),
    getPinRxcuis(rxcui),
  ]);
  const matchIds = Array.from(new Set([...inIds, ...pinIds]));
  const selfId = String(rxcui);
  // Pass 2's "is this a combo?" check uses the IN count only — adding the
  // PIN form shouldn't make a single-ingredient salt product look like a
  // multi-ingredient combo.
  const inputIngredients = new Set(inIds.filter(id => id !== selfId));
  const level5List = [];

  for (const classId of level4ClassIds) {
    if (classId.length !== 5) continue;
    const members = await getClassMembers(classId).catch(() => []);

    // Pass 1: single-ingredient direct match.
    let hit = null;
    for (const member of members) {
      if (!member.rxcui || !matchIds.includes(member.rxcui)) continue;
      if (member.sourceId && member.sourceId.length === 7) {
        hit = { code: member.sourceId, name: member.sourceName || "Name not available" };
        break;
      }
    }

    // Pass 2: MIN-equality match for combination products. Only meaningful
    // when the input has at least two ingredients, otherwise there's no
    // combo to match against.
    if (!hit && inputIngredients.size >= 2) {
      for (const member of members) {
        if (!member.rxcui || member.tty !== "MIN") continue;
        if (!member.sourceId || member.sourceId.length !== 7) continue;
        const minRelated = await getIngredientRxcuis(member.rxcui).catch(() => null);
        if (!minRelated) continue;
        const minIngredients = new Set(minRelated.filter(id => id !== String(member.rxcui)));
        if (minIngredients.size !== inputIngredients.size) continue;
        let equal = true;
        for (const id of inputIngredients) if (!minIngredients.has(id)) { equal = false; break; }
        if (equal) {
          hit = { code: member.sourceId, name: member.sourceName || "Name not available" };
          console.log(`[RxCUI→ATC] MIN-equality match for ${rxcui} under ${classId}: ingredients=${[...inputIngredients].join(",")} → ${hit.code}`);
          break;
        }
      }
    }

    if (hit) level5List.push(hit);
  }
  if (level5List.length > 0) return level5List;

  // Fallback: query each ingredient RXCUI for its ATC classes and pick Level
  // 5 codes that fall under the known Level 4 prefixes.
  const seen5 = new Set();
  for (const id of matchIds) {
    try {
      const classes = await getIngredientAtcClasses(id);
      for (const c of classes) {
        const cid = c.classId;
        if (!cid || cid.length !== 7 || seen5.has(cid)) continue;
        if (level4ClassIds.some(l4 => cid.toUpperCase().startsWith(l4.toUpperCase()))) {
          seen5.add(cid);
          level5List.push({ code: cid, name: c.className || "Name not available" });
        }
      }
    } catch (_) {}
  }
  return level5List.length > 0 ? level5List : null;
}

/**
 * Fetch ATC names for a list of Level 5 codes via the property fallback path,
 * matching the working code's behavior. We look each up through the
 * ingredient-class endpoint to get a className.
 */
async function attachAtcNames(codes) {
  console.log("[RxCUI→ATC] Getting names for", codes.length, "codes:", codes);
  const out = await Promise.all(codes.map(async (code) => {
    try {
      // Cheapest way to look up an ATC class name is via byRxcui; but here we
      // have a classId, not a rxcui. Without a dedicated byId helper in the
      // resolver, fall back to "Name not available", the browser app does
      // the same when the property path is reached without a richer source.
      return { code: String(code), name: "Name not available" };
    } catch {
      return { code: String(code), name: "Name not available" };
    }
  }));
  return out;
}

/**
 * Wrap a Strategy 1 (ATCPROD) keep-result with an optional `routeOverride`
 * flag. We compare each kept Level-5 code against the route filter; if at
 * least one kept code WOULD have been rejected by the matrix, we mark the
 * result so the UI can surface a small explanation that NLM's product-level
 * mapping intentionally crosses anatomical groups for clinical-intent reasons
 * (e.g. inhaled levodopa → N04 nervous-system class, not respiratory).
 *
 * Returned shape:
 *   { status: "KEEP", codes, routeOverride?: { route, codes: [{code, name, verdict}, ...] } }
 */
function buildAtcprodKeep(level5, route) {
  if (!route || route === "unknown") return { status: "KEEP", codes: level5 };
  const overrideCodes = [];
  for (const c of level5) {
    const v = classifyAtcForRoute(c.code, route);
    if (!v.kept) overrideCodes.push({ code: c.code, name: c.name, verdict: v });
  }
  if (overrideCodes.length === 0) return { status: "KEEP", codes: level5 };
  console.log(
    `[RxCUI→ATC] Route override detected: ATCPROD kept ${overrideCodes.map(o => o.code).join(", ")} ` +
    `which the route filter would have rejected for "${route}" route`
  );
  return { status: "KEEP", codes: level5, routeOverride: { route, codes: overrideCodes } };
}

/**
 * Main entry: RXCUI → Level 5 ATC codes.
 *
 * Returns a discriminated result:
 *   { status: "KEEP",             codes: [{code, name}, ...] }
 *   { status: "INGREDIENT_LEVEL", tty }
 *   { status: "NO_ATC" }
 *
 * The "codes" array may include the Level 4 ATCPROD fallback as a last
 * resort. Callers should filter for length 7 (Level 5) before displaying.
 */
export async function convertRxcuiToAtc(rxcui) {
  console.log("[RxCUI→ATC] === Starting RxCUI to ATC conversion ===");
  console.log("[RxCUI→ATC] Input RxCUI:", rxcui);

  try {
    // ============================================================
    //  GUARD: ingredient-level inputs have no specific dose form.
    //  Their DFGs aggregate every product they appear in, so route
    //  resolution is meaningless. Pull canonical Level 5 ATC codes
    //  directly from the RXCUI property and return them all, no
    //  route filtering since there is no route to filter by.
    // ============================================================
    const props = await getProperties(rxcui).catch(() => null);
    if (props && props.found && INGREDIENT_TTYS.has(props.tty)) {
      console.log(`[RxCUI→ATC] TTY=${props.tty}, skipping route filter; returning all ingredient ATCs`);
      const propertyCodes = await getAtcPropertyValues(rxcui).catch(() => []);
      const codes = propertyCodes
        .filter(c => (c || "").length === 7)
        .map(code => ({ code, name: props.name || null }));
      return { status: "INGREDIENT_LEVEL", tty: props.tty, codes, rejectedL4: [] };
    }

    // Fire all data sources in parallel; per-endpoint failures degrade
    // gracefully (one tier failing doesn't kill the resolution).
    const [atcprodClasses, dfgNames, ingredientClasses, propertyCodes] = await Promise.all([
      getAtcprodClasses(rxcui).catch(() => []),
      getDfgs(rxcui).catch(() => []),
      getIngredientAtcClasses(rxcui).catch(() => []),
      getAtcPropertyValues(rxcui).catch(() => []),
    ]);

    // Resolve route once, used by Strategy 2/3 AND by Strategy 1's
    // route-override detection (we want to flag when ATCPROD keeps a
    // code that our matrix would have rejected).
    const route = resolveRoute(dfgNames);

    // Single source of truth for the route filter's rejection list.
    // After the engine produces a result, finalize() enriches it with
    // `rejectedL4`, the set of L4 ATC subgroups that the route matrix
    // rejected for this drug AND were NOT overridden by ATCPROD or
    // already kept. Both Mode 1 (renders these as rejected cards after
    // L4→L5 promotion) and Mode 2 (counts them for the "removed" column
    // + status classification) read from this array.
    const finalize = (result) => {
      if (!result || !route || route === "unknown" || !Array.isArray(ingredientClasses)) {
        return { ...result, rejectedL4: [] };
      }
      const exempt = new Set();
      if (result.routeOverride && Array.isArray(result.routeOverride.codes)) {
        for (const o of result.routeOverride.codes) {
          if (o.code && o.code.length >= 5) exempt.add(o.code.slice(0, 5).toUpperCase());
        }
      }
      // Any L4 prefix of a kept L5 is exempt, the route filter and the
      // engine already agree on that prefix; no point listing it as rejected.
      for (const c of (Array.isArray(result.codes) ? result.codes : [])) {
        const code = (c.code || "").toUpperCase();
        if (code.length >= 5) exempt.add(code.slice(0, 5));
      }
      const rejected = [];
      const seen = new Set();
      for (const c of ingredientClasses) {
        const cid = (c.classId || "").toUpperCase();
        if (cid.length !== 5 || seen.has(cid) || exempt.has(cid)) continue;
        const v = classifyAtcForRoute(cid, route);
        if (!v.kept) {
          rejected.push({ classId: cid, className: c.className || "Name not available", verdict: v });
          seen.add(cid);
        }
      }
      return { ...result, rejectedL4: rejected };
    };

    // ============================================================
    //  STRATEGY 1: ATCPROD, direct product-level ATC mapping
    // ============================================================
    let atcprodFallback = null;
    let atcprodPrefixes = null;
    if (atcprodClasses.length > 0) {
      // Surface as {code, name} for downstream consumers.
      const uniqueClasses = atcprodClasses.map(c => ({ code: c.classId, name: c.className || "Name not available" }));
      console.log("[RxCUI→ATC] ATCPROD hit:", uniqueClasses.map(c => c.code).join(", "));

      // ATCPROD returns Level 4 codes, promote each to Level 5.
      const level4Ids = uniqueClasses.map(c => c.code).filter(c => c.length >= 4 && c.length <= 5);
      if (level4Ids.length > 0) {
        const level5 = await resolveLevel5FromClassMembers(rxcui, level4Ids);
        if (level5 && level5.length > 0) return finalize(buildAtcprodKeep(level5, route));
      }

      // Direct Level 5 codes from ATCPROD (rare but possible).
      const level5Direct = uniqueClasses.filter(c => c.code.length === 7);
      if (level5Direct.length > 0) return finalize(buildAtcprodKeep(level5Direct, route));

      // Save Level 4 codes as fallback AND as a prefix whitelist for
      // downstream tiers. This prevents combo drugs (e.g. R03AL) from
      // being replaced by unrelated single-ingredient codes (e.g. R03BA02).
      atcprodFallback = uniqueClasses;
      atcprodPrefixes = level4Ids;
      console.log("[RxCUI→ATC] ATCPROD returned Level 4 only → trying ingredient ATC for Level 5 children");
    }

    const atcprodPrefixFilter = (atcprodPrefixes && atcprodPrefixes.length > 0)
      ? (items) => items.filter(item => {
          const c = (typeof item === "string" ? item : item.code || "").toUpperCase();
          return atcprodPrefixes.some(p => c.startsWith(p.toUpperCase()));
        })
      : (items) => items;
    if (!atcprodFallback) console.log("[RxCUI→ATC] ATCPROD returned no data, falling back to ingredient ATC + DFG filter");

    // ============================================================
    //  STRATEGY 2: Ingredient-level ATC + DFG route filter
    // ============================================================
    console.log("[RxCUI→ATC] DFG:", dfgNames, "→ Route:", route);

    if (ingredientClasses.length > 0) {
      const atcList = ingredientClasses.map(c => ({
        code: c.classId,
        name: c.className || "Name not available",
      }));

      const level5 = filterAtcByRoute(
        atcprodPrefixFilter(atcList.filter(item => item.code.length === 7)),
        route,
      );
      if (level5.length > 0) return finalize({ status: "KEEP", codes: level5 });

      if (!atcprodFallback) {
        const level4Ids = filterAtcByRoute(
          atcList.map(item => item.code).filter(c => c.length === 5),
          route,
        );
        console.log("[RxCUI→ATC] Level 4 codes after route filter:", level4Ids);
        if (level4Ids.length > 0) {
          const promoted = await resolveLevel5FromClassMembers(rxcui, level4Ids);
          if (promoted) return finalize({ status: "KEEP", codes: promoted });
        }
      }
    }

    // ============================================================
    //  STRATEGY 3: Property API (last resort)
    // ============================================================
    if (propertyCodes.length > 0) {
      const level5Codes = filterAtcByRoute(
        atcprodPrefixFilter(propertyCodes.filter(c => c.length === 7)),
        route,
      );
      if (level5Codes.length > 0) {
        const named = await attachAtcNames(level5Codes);
        return finalize({ status: "KEEP", codes: named });
      }

      if (!atcprodFallback) {
        const level4Codes = filterAtcByRoute(
          propertyCodes.filter(c => c.length === 5),
          route,
        );
        if (level4Codes.length > 0) {
          const promoted = await resolveLevel5FromClassMembers(rxcui, level4Codes);
          if (promoted) return finalize({ status: "KEEP", codes: promoted });
        }
      }
    }

    // Last resort, return ATCPROD's Level 4 codes if nothing else resolved.
    if (atcprodFallback) {
      console.log("[RxCUI→ATC] Returning ATCPROD Level 4 fallback:", atcprodFallback.map(c => c.code).join(", "));
      return finalize({ status: "KEEP", codes: atcprodFallback });
    }
    return { status: "NO_ATC", rejectedL4: [] };
  } catch (e) {
    console.error("[RxCUI→ATC] Error:", e);
    throw e;
  }
}
