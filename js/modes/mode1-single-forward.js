// modes/mode1-single-forward.js, Mode 1 UI logic.
// Owns the input → engine → render flow for a single RXCUI.
//
// Mode files are thin: validate, call client/resolver, render via ui-components.
// No fetch() here; no filter logic here; no inline reason strings.

import { detectCodeType } from "../code-detection.js";
import {
  getProperties,
  getDfgs,
} from "../rxnav-client.js";
import {
  resolveRoute,
  classifyAtcForRoute,
} from "../filter-engine.js";
import { convertRxcuiToAtc, resolveLevel5FromClassMembers } from "../atc-resolver.js";
import { buildAtcAnatomyElement, enrichAtcAnatomy } from "../atc-anatomy.js";
import {
  drugIdentityCard,
  routeCard,
  keptAtcCard,
  rejectedAtcCard,
  errorCard,
  skeletonCard,
  codeDetectionBanner,
  actionBarCard,
  combinationBanner,
  combinationClassCard,
  ingredientAtcBlock,
} from "../ui-components.js";
import {
  explainWrongRouteAllow,
  explainWrongRouteExclude,
  explainRxcuiNotFound,
  explainIngredientLevel,
  getClinicalContext,
  suggestCombinationFamilyExpansion,
  noteCombinationL4Reachable,
  noteL4OnlyReachable,
} from "../explanations.js";

const MODE_LABEL = {
  ATC:   "ATC → RXCUI",
  NDC:   "NDC → ATC",
  RXCUI: "RXCUI → ATC",
};

let currentToken = 0;

/** Render an empty state into the result area. */
export function reset(resultEl) {
  resultEl.innerHTML = "";
}

/** Validate, then either show a detection banner or run the lookup. */
export async function submit({ rxcui, resultEl, bannerEl, onSwitchMode }) {
  currentToken++;
  const token = currentToken;
  resultEl.innerHTML = "";
  bannerEl.innerHTML = "";

  const trimmed = (rxcui || "").trim();
  if (!trimmed) {
    resultEl.appendChild(errorCard({
      title: "Enter an RXCUI",
      body: "Type or paste an RxNorm Concept Unique Identifier (RXCUI) to look up.",
      variant: "info",
    }));
    return;
  }

  // Code detection on the raw input. ATC → switch banner to Mode 3.
  // NDC → passive notice (no input mode accepts NDCs in this build).
  const detected = detectCodeType(trimmed);
  if (detected.type === "ATC") {
    bannerEl.appendChild(codeDetectionBanner({
      detectedType: "ATC code",
      value: detected.value,
      suggestedModeLabel: MODE_LABEL.ATC,
      onSwitch: () => onSwitchMode && onSwitchMode(detected),
      onContinue: () => bannerEl.innerHTML = "",
    }));
    return;
  }
  if (detected.type === "NDC") {
    bannerEl.appendChild(errorCard({
      title: `"${trimmed}" looks like an NDC code`,
      body: "MedCode Lookup currently has no NDC-input mode. To find the active NDCs for a drug, look up its RXCUI in Mode 4 (RXCUI → NDCs). To map an NDC back to an RXCUI, use RxNav directly.",
      variant: "info",
    }));
    return;
  }
  if (detected.type !== "RXCUI") {
    resultEl.appendChild(errorCard({
      title: `"${trimmed}" doesn't look like an RXCUI`,
      body: "RXCUIs are numeric (e.g., 1797907). Search for one on RxNav.",
      actions: [
        { label: "Open RxNav", primary: false, onClick: () => window.open("https://mor.nlm.nih.gov/RxNav/", "_blank", "noopener") },
      ],
      variant: "warning",
    }));
    return;
  }

  // Loading state, three skeleton cards mirroring the result shape.
  resultEl.appendChild(skeletonCard());
  resultEl.appendChild(skeletonCard());
  resultEl.appendChild(skeletonCard());

  await _renderResultsFor({
    rxcui: trimmed,
    resultEl,
    cancelled: () => token !== currentToken,
    onLookupAnother: () => clearMode1State(resultEl, bannerEl),
    onRetry: () => submit({ rxcui: trimmed, resultEl, bannerEl, onSwitchMode }),
  });
}

/**
 * Render the same Mode 1 card stack into an arbitrary container, skipping the
 * input validation + cancellation-token plumbing that the page-level mode
 * needs. Used by Mode 2's row-expand so each batch row gets the full Mode 1
 * detail view without interfering with sibling row renders.
 *
 * Assumes `rxcui` is already validated as a numeric RXCUI.
 */
export async function renderInto({ rxcui, resultEl }) {
  resultEl.innerHTML = "";
  resultEl.appendChild(skeletonCard());
  resultEl.appendChild(skeletonCard());
  await _renderResultsFor({
    rxcui,
    resultEl,
    cancelled: () => false,
    onLookupAnother: null,
    onRetry: () => renderInto({ rxcui, resultEl }),
  });
}

// ---------------- private: shared fetch + render path ----------------

async function _renderResultsFor({ rxcui, resultEl, cancelled, onLookupAnother, onRetry }) {
  const trimmed = rxcui;

  let props, dfgs, result;
  try {
    [props, dfgs, result] = await Promise.all([
      getProperties(trimmed),
      getDfgs(trimmed),
      convertRxcuiToAtc(trimmed),
    ]);
  } catch (err) {
    if (cancelled()) return;
    resultEl.innerHTML = "";
    resultEl.appendChild(errorCard({
      title: "Couldn't reach RxNav",
      body: "The NIH API isn't responding. Check your connection and try again.",
      actions: [
        { label: "Retry", primary: true, onClick: onRetry },
      ],
      variant: "error",
    }));
    return;
  }
  if (cancelled()) return;

  resultEl.innerHTML = "";

  if (!props.found) {
    resultEl.appendChild(errorCard({
      title: `RXCUI ${trimmed} not found`,
      body: explainRxcuiNotFound(trimmed),
      actions: [
        { label: "Verify on RxNav", primary: false, onClick: () => window.open(`https://mor.nlm.nih.gov/RxNav/search?searchBy=RXCUI&searchTerm=${trimmed}`, "_blank", "noopener") },
      ],
      variant: "error",
    }));
    return;
  }

  // 1. Drug identity. Pass the first resolvable ATC so the card can
  // surface the anatomical family pill (e.g. "🫁 Respiratory · R") right
  // next to the RxCUI — the user sees the family before scrolling.
  // Preference order: L5 from engine codes → L4 from engine codes → first
  // ingredient's L5 (so combination products like 200284 still get a pill).
  const primaryAtc = (result && Array.isArray(result.codes) && result.codes.find(c => (c.code || "").length === 7)?.code)
    || (result && Array.isArray(result.codes) && result.codes.find(c => (c.code || "").length === 5)?.code)
    || (result && Array.isArray(result.combinationIngredients) && result.combinationIngredients.find(ing => (ing.codes || []).length > 0)?.codes?.[0]?.code)
    || null;
  resultEl.appendChild(drugIdentityCard({
    rxcui: props.rxcui,
    name: props.name,
    tty: props.tty,
    primaryAtc,
  }));

  // 2. Ingredient-level inputs: skip route resolution and route filtering.
  if (result && result.status === "INGREDIENT_LEVEL") {
    resultEl.appendChild(errorCard({
      title: "Ingredient-level lookup, no route filtering",
      body: "Showing the canonical Level 5 ATC code(s) for this substance. No route filter was applied since no specific dose form was given. For a route-validated mapping, look up a specific clinical drug (SCD or SBD).",
      variant: "info",
    }));

    const codes = Array.isArray(result.codes)
      ? result.codes.filter(c => (c.code || "").length === 7)
      : [];
    if (codes.length === 0) {
      resultEl.appendChild(errorCard({
        title: `No ATC mapped for ${props.name || `RXCUI ${props.rxcui}`}`,
        body: "RxNorm has no ATC property stored for this ingredient.",
        variant: "warning",
      }));
    } else {
      for (const k of codes) {
        resultEl.appendChild(keptAtcCard({
          atc: k.code,
          name: k.name,
        }));
        appendAnatomyCard(resultEl, k.code, k.name);
      }
    }

    resultEl.appendChild(actionBarCard({
      onCopyJson: () => copyResultAsJson({ rxcui: trimmed, props, status: "INGREDIENT_LEVEL", codes }),
      onLookupAnother,
    }));
    setPageTitle(trimmed, codes[0]?.code);
    return;
  }

  // 3. Route resolution card
  const route = resolveRoute(dfgs);
  const chosenDfg = pickChosenDfg(dfgs, route);
  resultEl.appendChild(routeCard({
    route,
    dfgs,
    chosenDfg,
  }));

  // 4. Kept ATCs.
  //
  // Two channels feed the kept list:
  //   - L5 codes (length 7) — render as the standard keptAtcCard
  //   - L4 codes (length 5) — render as a combinationClassCard (L4 fallback
  //     case, including the COMBINATION_NO_DEDICATED_CODE path). The L4
  //     branch is intentional, not a degraded state: it's surfaced because
  //     L5 was not reachable through any RxNav source, and the L4 is the
  //     most specific reachable answer.
  const codesEnvelope = (result && (result.status === "KEEP" || result.status === "COMBINATION_NO_DEDICATED_CODE") && Array.isArray(result.codes))
    ? result.codes
    : [];
  const keptCodes = codesEnvelope.filter(c => (c.code || "").length === 7);
  const keptL4Codes = codesEnvelope.filter(c => (c.code || "").length === 5);

  const isCombination = result && (
    result.status === "COMBINATION_NO_DEDICATED_CODE" ||
    (Array.isArray(result.combinationIngredients) && result.combinationIngredients.length > 0)
  );
  const combinationIngredients = (result && Array.isArray(result.combinationIngredients))
    ? result.combinationIngredients
    : [];

  // 5. Rejected ATCs, read the deduped L4 list from the engine (single
  // source of truth; same array Mode 2 counts for its "removed" column).
  // Then promote each to its Level 5 equivalent for the same ingredient.
  // L4 codes never appear in the UI as REJECTED — only on the kept side
  // when no L5 was reachable (see above).
  const rejectedL4 = Array.isArray(result && result.rejectedL4) ? result.rejectedL4 : [];
  const rejectedRows = [];
  if (rejectedL4.length > 0) {
    const promotedLists = await Promise.all(rejectedL4.map(async (r) => {
      try {
        const promoted = await resolveLevel5FromClassMembers(trimmed, [r.classId]);
        if (!promoted || promoted.length === 0) return [];
        return promoted
          .filter(p => (p.code || "").length === 7)
          .map(p => ({ atc: p.code, name: p.name, l4: r.classId, verdict: r.verdict }));
      } catch {
        return [];
      }
    }));
    if (cancelled()) return;
    for (const row of promotedLists.flat()) {
      const reason = row.verdict.mode === "exclude"
        ? explainWrongRouteExclude(row.atc, route, row.verdict.matchedPrefix)
        : explainWrongRouteAllow(row.atc, route, row.verdict.allowedPrefixes || []);
      const clinical = getClinicalContext(route, row.atc);
      rejectedRows.push({ atc: row.atc, name: row.name, reason, clinical, l4: row.l4 });
    }
  }

  // Route-override note: if the engine flagged a kept code as having been
  // anatomically-unusual for this route (i.e., ATCPROD overrode our matrix),
  // attach a small explanation to that code's kept card.
  const overrideByCode = new Map();
  if (result && result.routeOverride && Array.isArray(result.routeOverride.codes)) {
    for (const o of result.routeOverride.codes) overrideByCode.set(o.code, o);
  }

  // Combination banner — when the resolver flagged the input as a combo,
  // render the banner once, BEFORE kept cards. Tone depends on whether the
  // engine reached the dedicated combination L5:
  //   COMBINATION_NO_DEDICATED_CODE → "no-dedicated" (amber, with L4 fallback)
  //   KEEP + combinationIngredients → "resolved" (informational; the L5 IS
  //                                   the combination class via MIN-equality)
  if (isCombination) {
    const primaryL4 = keptL4Codes[0] || null;
    const bannerTone = (result.status === "COMBINATION_NO_DEDICATED_CODE") ? "no-dedicated" : "resolved";
    resultEl.appendChild(combinationBanner({
      tone: bannerTone,
      ingredientCount: combinationIngredients.length,
      l4Code: primaryL4 ? primaryL4.code : null,
      l4Name: primaryL4 ? primaryL4.name : "",
      suggestion: (bannerTone === "no-dedicated" && primaryL4)
        ? suggestCombinationFamilyExpansion(primaryL4.code)
        : null,
    }));
  }

  // Render kept L5 cards (the standard happy path)
  for (const k of keptCodes) {
    const ov = overrideByCode.get(k.code);
    resultEl.appendChild(keptAtcCard({
      atc: k.code,
      name: k.name,
      reason: keptReasonFor(k.code, route),
      overrideNote: ov ? routeOverrideNote(k.code, route) : null,
    }));
    appendAnatomyCard(resultEl, k.code, k.name);
  }

  // Render L4-only kept cards. For combinations, the note explains the
  // RxClass classMembers limitation; for non-combinations it's a generic
  // L4-only note.
  for (const k of keptL4Codes) {
    resultEl.appendChild(combinationClassCard({
      atc: k.code,
      name: k.name,
      note: isCombination ? noteCombinationL4Reachable(k.code) : noteL4OnlyReachable(k.code),
    }));
  }

  // Ingredient breakdown — only when combination context is present. Always
  // rendered AFTER the kept cards so the user reads top-down: combination
  // banner → primary kept code(s) → per-ingredient detail.
  for (const ing of combinationIngredients) {
    resultEl.appendChild(ingredientAtcBlock({
      ingredientName: ing.name,
      ingredientRxcui: ing.rxcui,
      tty: ing.tty || "IN",
      atcs: Array.isArray(ing.codes) ? ing.codes : [],
    }));
  }

  // Truly empty result — no L5, no L4, no combination signal. Only happens
  // for drugs that have a valid RxCUI but are entirely outside WHO ATC and
  // aren't combinations either. When combination context fired, the banner
  // already explains the situation, so we don't add a redundant info card.
  const renderedAnyAtc = keptCodes.length + keptL4Codes.length + combinationIngredients.reduce((a, b) => a + ((b.codes || []).length), 0) > 0;
  if (!renderedAnyAtc && !isCombination) {
    resultEl.appendChild(errorCard({
      title: `RXCUI ${trimmed} found but no ATC mapped`,
      body: "Common reasons: US-only drugs not in WHO's ATC index, recently-approved or investigational drugs, or compounded formulations.",
      variant: "info",
    }));
  }

  for (const r of rejectedRows) {
    resultEl.appendChild(rejectedAtcCard(r));
  }

  // 6. Action bar
  resultEl.appendChild(actionBarCard({
    onCopyJson: () => copyResultAsJson({
      rxcui: trimmed, props, route, dfgs,
      status: result && result.status,
      kept: keptCodes,
      keptL4: keptL4Codes,
      combinationIngredients,
      rejected: rejectedRows,
      routeOverride: result && result.routeOverride ? result.routeOverride : null,
    }),
    onLookupAnother,
  }));

  // Page title prefers an L5 kept code; falls back to L4, then to any
  // ingredient L5 — so combination products still get an informative title.
  const titleAtc = keptCodes[0]?.code
    || keptL4Codes[0]?.code
    || combinationIngredients.find(ing => (ing.codes || []).length > 0)?.codes?.[0]?.code
    || null;
  setPageTitle(trimmed, titleAtc);
}

// ATC Level 1 letter → human-readable anatomical class for the override note.
const ATC_L1_PURPOSE = {
  A: "alimentary tract & metabolism",
  B: "blood & blood-forming organs",
  C: "cardiovascular system",
  D: "dermatological / skin",
  G: "genito-urinary system & sex hormones",
  H: "systemic hormonal preparations",
  J: "anti-infectives",
  L: "antineoplastic & immunomodulating",
  M: "musculoskeletal system",
  N: "nervous system",
  P: "antiparasitic",
  R: "respiratory system",
  S: "sensory organs",
  V: "various",
};
const ROUTE_EXPECTED_CLASS = {
  inhalant:    "respiratory (R03/R07)",
  nasal:       "nasal (R01)",
  ophthalmic:  "ophthalmic (S01/S03)",
  otic:        "otic (S02/S03)",
  oral:        "the systemic ATC class for this drug",
  injectable:  "the systemic ATC class for this drug",
  topical:     "dermatological (D)",
  transdermal: "dermatological (D)",
  rectal:      "rectal-route ATC group",
  vaginal:     "gynecological (G)",
  buccal:      "stomatological (A01) or pharyngeal (R02)",
  sublingual:  "stomatological (A01), pharyngeal (R02) or cardiac (C01)",
  mucosal:     "the appropriate mucosal class",
};

function routeOverrideNote(atc, route) {
  const l1 = (atc || "").charAt(0).toUpperCase();
  const codeClass = ATC_L1_PURPOSE[l1] || "this anatomical group";
  const expected = ROUTE_EXPECTED_CLASS[route] || "the route's expected anatomical group";
  return `Note: ${l1} codes are anatomically for the ${codeClass}, not ${expected}. ` +
    `NLM's ATCPROD mapping explicitly assigns this product to ${atc} because the clinical ` +
    `intent of the medication (${codeClass}) overrides the formulation's route.`;
}

// Update the browser tab title so a result is identifiable in tab strips.
function setPageTitle(rxcui, atc) {
  document.title = atc
    ? `MedCode · ${rxcui} → ${atc}`
    : "MedCode Lookup, Route-aware drug code translator";
}

function appendAnatomyCard(resultEl, atcCode, hintName) {
  const card = buildAtcAnatomyElement(atcCode, hintName || "");
  if (!card) return;
  resultEl.appendChild(card);
  // Fire enrichment after the card is in the DOM so the patched titles can
  // transition. .catch() to keep one bad lookup from breaking the page.
  enrichAtcAnatomy(card, atcCode).catch(() => {});
}

function clearMode1State(resultEl, bannerEl) {
  const input = document.getElementById("mode1-input");
  if (input) { input.value = ""; input.focus(); }
  resultEl.innerHTML = "";
  bannerEl.innerHTML = "";
  setPageTitle(null, null);
  const url = new URL(window.location.href);
  url.search = "?mode=1";
  window.history.pushState({}, "", url);
}

function pickChosenDfg(dfgs, route) {
  // routeCard wants to highlight the DFG the resolver chose. We re-pick it
  // here using the same DFG_PRIORITY logic in resolveRoute, but resolveRoute
  // returns just the route. Recompute the DFG by route-mapping each DFG and
  // picking the first one whose route matches.
  if (!route || route === "unknown" || !Array.isArray(dfgs)) return null;
  for (const d of dfgs) {
    if (resolveRoute([d]) === route) return d;
  }
  return null;
}

function keptReasonFor(atc, route) {
  if (!route || route === "unknown") return null;
  const v = classifyAtcForRoute(atc, route);
  if (!v.kept) return null;
  if (v.mode === "allow" && v.matchedPrefix) {
    return `${atc} matches the ${route} route (allowed prefix: ${v.matchedPrefix}).`;
  }
  if (v.mode === "exclude") {
    return `${atc} is consistent with the ${route} route (no excluded prefix matched).`;
  }
  return null;
}

function copyResultAsJson(payload) {
  const json = JSON.stringify(payload, null, 2);
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(json).catch(() => {});
  } else {
    const ta = document.createElement("textarea");
    ta.value = json;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch {}
    document.body.removeChild(ta);
  }
}
