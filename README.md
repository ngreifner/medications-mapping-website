# MedCode Lookup

**Route-aware translation between RxNorm (RXCUI), WHO ATC, and FDA NDC drug codes — with first-class handling of combination products.**

Standard drug code mappings return wrong codes by ignoring the dose form — a nasal spray gets tagged with skin-cream and asthma-inhaler codes from the same ingredient — and silently drop combination products whose dedicated WHO Level-5 code isn't exposed through RxNav. MedCode Lookup resolves the actual administration route from RxNorm metadata, escalates partial-coverage answers honestly, and reaches the dedicated combination L5 through four fallback layers before giving up.

Built by [Netanel Greifner, MD MHA](https://navina.ai) — an independent project, not endorsed by NIH, NLM, WHO, or FDA.

---

## What it does

The differentiator: other RXCUI→ATC tools exist, but none explain *why* a code was kept or rejected — both technically (the rule that matched) and clinically (the substance's alternative uses) — and most silently return a misleading mono-ingredient code for combination drugs.

### Seven modes

| # | Name | Input | Output |
|---|------|-------|--------|
| 1 | RXCUI → ATC | one RXCUI | route-filtered ATC codes with kept/rejected explanations + 5-level code anatomy + combination-aware resolution |
| 2 | Batch RXCUI → ATC | up to 200 RXCUIs | scrollable table with per-row status (clean fix / unchanged / legit-multi / needs-review) |
| 3 | ATC → RxCUIs | one Level-4 or Level-5 ATC | every RxCUI in the class, route-validated, three-status verdict (KEPT / ROUTE_MISMATCH / NEEDS_REVIEW), optional NDC drill-down |
| 4 | RXCUI → NDCs | one RXCUI | full NDC list with labeler, packaging, marketing category, FDA approval |
| 5 | Batch RXCUI → NDCs | up to 200 RXCUIs | flat NDC table across all inputs + per-RxCUI grouping toggle |
| 6 | Batch NDC → FDA details | up to 200 NDCs | brand / generic / labeler / dosage form / route / strength / marketing dates via OpenFDA |
| 7 | Batch NDC → RxCUI | up to 200 NDCs | parent RxCUI + drug name + RxNorm status + marketing-range history via RxNav `/ndcstatus` |

---

## Combination drug resolution (the part most tools get wrong)

The hardest mapping question in pharmacy informatics is: **what's the right ATC code for a combination product?** WHO ATC defines dedicated Level-5 codes for combinations (e.g. `C09DA03` for HCTZ + valsartan), but these codes aren't always reachable through RxNav. Other tools either silently return one ingredient's mono code (wrong) or refuse to map the combination at all (unhelpful). MedCode Lookup runs the input through six ordered rules:

1. **Not a combination?** → standard single-ingredient resolution (route filter + 3-strategy orchestrator).
2. **MIN-property bypass** — query the input's MIN ancestor's `/property.json?propName=ATC`. Catches Epclusa (`J05AP55`), Bactrim (`J01EE01`), Glyxambi (`A10BD19`), Janumet (`A10BD07`), Symbicort (`R03AK07`), Biktarvy (`J05AR20`).
3. **Navina-curated combination catalog** ([js/atc-combinations-curated.js](js/atc-combinations-curated.js)) — small hand-authored table of `(RxNorm IN set → WHO L5)` pairs for DxCapture-relevant combinations. Set equality on lowercase RxNorm IN names. Catches HCTZ+valsartan (`C09DA03`), Sinemet (`N04BA02`), Stalevo (`N04BA03`), lisinopril+HCTZ (`C09BA03`), 3-ingredient ARB combos (`C09DX03`).
3.5. **WHO ATC index snapshot** ([data/who-atc-snapshots/](data/who-atc-snapshots/)) — committed snapshots of the official WHO ATC index pages, refreshed by [scripts/refresh-who-snapshots.js](scripts/refresh-who-snapshots.js). The runtime resolver parses each L5 name into ingredients (with synonym normalization for WHO↔RxNorm spelling and prodrug suffix stripping) and scores against the input ingredient set. Three match tiers: EXACT, CLASS (drug-class membership), WILDCARD. Catches Norco (`N02AJ22`), Percocet (`N02AJ17`), Avycaz (`J01DD52`), Augmentin (`J01CR02`).
4. **L4-only or NO_ATC** → escalate to `COMBINATION_NO_DEDICATED_CODE`. Surfaces the L4 combination class + each ingredient's mono ATC, with an honest banner: *"WHO defines a dedicated L5 but no public source carries it; the L4 is the best reachable answer."*
5. **Partial-coverage discriminator** — when the engine resolved a single L5 that is actually just one ingredient's monotherapy code, escalate to `COMBINATION_NO_DEDICATED_CODE`. Prevents misleading green-badge KEPTs on combinations like Advil PM.
6. **Safety net** — true MIN-equality combinations stay KEPT.

Every kept code carries explicit provenance on the result card — *"Reached via the MIN concept's RxNorm property API"*, *"…the Navina-curated combination catalog"*, *"…the WHO ATC index snapshot"*, or the standard route-match line — so it's always defensible.

---

## How it works (route filtering)

Every result is computed in the browser from public RxNav data — no backend, no patient data, no tracking. For single-ingredient drugs (the most common case), the route-aware resolver runs a three-strategy orchestrator:

1. **ATCPROD** — NLM's curated product-level mapping (~97% of common drugs). If it returns Level-4 codes, the resolver promotes them to Level-5 via a `classMembers` walk with three passes (single-ingredient match, MIN-equality match for combos, fallback through ingredient ATC classes).
2. **DFG-filtered ingredient ATC** — fetches the drug's dose-form group, resolves a route (nasal, ophthalmic, topical, etc.), and filters ingredient-level ATC codes by an allow/exclude prefix matrix per route.
3. **Property API fallback** — last-resort lookup on the input RXCUI's own ATC property.

Ingredient-level RXCUIs (TTY = IN / MIN / PIN) skip route filtering entirely — there's no single route for a bare ingredient, so all its valid Level-5 ATCs are returned with status `INGREDIENT_LEVEL`.

The 5-level ATC code anatomy is shown for every kept code, with class names enriched asynchronously from RxClass and a staggered reveal animation showing how the code decomposes (Level 1 anatomical → Level 5 substance).

---

## Stack

- Vanilla JavaScript (ES modules), HTML, CSS
- **Zero build step, zero runtime dependencies**
- Calls [RxNav](https://rxnav.nlm.nih.gov) and [OpenFDA](https://api.fda.gov) directly from the browser (15 req/s rate limiter for RxNav, 4 req/s for OpenFDA, 30-day localStorage cache)
- WHO ATC snapshots refreshed offline by a Node script — no network calls to `atcddd.fhi.no` at runtime (their site doesn't send CORS headers anyway)
- Apple Liquid Glass design layer (sliding tab indicator, frosted cards, refined typography pairing Instrument Serif + Geist + Geist Mono)
- Deploys anywhere static — GitHub Pages, Vercel, Netlify, any static host

---

## Running locally

```bash
python3 -m http.server 8765
# then open http://localhost:8765
```

That's it — no install, no build.

### Refreshing the WHO ATC snapshots

```bash
node scripts/refresh-who-snapshots.js
```

Fetches the configured L4 pages from `atcddd.fhi.no`, parses them, and writes:
- `data/who-atc-snapshots/{L4}.json` — canonical artifact, one per L4, human-reviewable
- `data/who-atc-snapshots/_manifest.json` — registry with timestamps + entry counts
- `js/who-atc-snapshots-bundle.js` — auto-generated runtime bundle

Plan a re-run after each annual WHO release (January). To add a new L4 to the snapshot set, append to `L4_CODES` in the script.

---

## Architecture

```
index.html                        ← seven tabs, dark-default theme
styles.css                        ← design-system tokens + components
glass.css                         ← Apple Liquid Glass overlay (cursor sheen, sliding tab indicator)
js/
  app.js                          ← controller (theme, tabs, URL state, paste-detect)
  filter-engine.js                ← pure logic: route resolution + matrix filter
  atc-resolver.js                 ← 3-strategy orchestrator + 6-rule combination cascade
  atc-combinations-curated.js     ← hand-authored ingredient-set → L5 mapping (Phase 2C)
  who-atc-index.js                ← runtime name parser + scorer for WHO snapshots (Phase 2D)
  who-atc-snapshots-bundle.js     ← AUTO-GENERATED snapshot data, do not edit
  rxnav-client.js                 ← all RxNav API calls + cache + rate-limit
  openfda-client.js               ← all OpenFDA API calls (Mode 6)
  atc-anatomy.js                  ← 5-level code anatomy renderer + family pill
  code-detection.js               ← auto-detect RXCUI / ATC / NDC input
  explanations.js                 ← human-readable reason templates
  ui-components.js                ← reusable DOM card renderers
  csv-export.js                   ← shared CSV writer
  glass-shimmer.js                ← cursor-tracking + sliding tab indicator
  modes/                          ← one file per mode (mode1–mode7)
data/
  who-atc-snapshots/              ← committed WHO ATC L5 snapshots, one JSON per L4
scripts/
  refresh-who-snapshots.js        ← node refresher for the WHO snapshots
scratch/
  test-engine.js                  ← Node verification harness
  test-mode*.js                   ← per-mode test scripts
```

**Process rules** (enforced):

- All RxNav `fetch()` calls go through `rxnav-client.js`; all OpenFDA calls through `openfda-client.js`. Never inline.
- Filter logic only lives in `filter-engine.js` / `atc-resolver.js`.
- Combination resolution logic lives in `atc-resolver.js` (orchestration), `atc-combinations-curated.js` (curated table), `who-atc-index.js` (WHO snapshot lookup).
- Human-readable strings only in `explanations.js` or as `reason` props on cards. No inline UI text.
- WHO snapshot data is NEVER fetched at runtime. Refresh happens offline via the Node script.

---

## Disclaimer

**MedCode Lookup is a validation and exploration tool, not a clinical decision support system.** Results are derived from public RxNorm and OpenFDA data and a route-classification heuristic, supplemented by a hand-curated combination catalog and offline snapshots of the WHO ATC index. The mapping logic may produce false positives or false negatives, particularly for combination products WHO hasn't yet catalogued, ingredient-level concepts, and drugs with legitimate cross-route ATC assignments. Always verify results against authoritative sources (WHO ATC, RxNorm, FDA NDC Directory) before use in production systems. **Not for use in patient care decisions.**

Data via [NIH RxNav](https://rxnav.nlm.nih.gov), [OpenFDA](https://open.fda.gov), and the [WHO ATC/DDD Index](https://atcddd.fhi.no/atc_ddd_index/) (the latter accessed offline via the snapshot refresher; see `scripts/refresh-who-snapshots.js`). Independent project, not endorsed by NIH, NLM, WHO, or FDA.

---

## License

MIT
