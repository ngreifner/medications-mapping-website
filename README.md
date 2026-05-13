# MedCode Lookup

**Route-aware translation between RxNorm (RXCUI), WHO ATC, and FDA NDC drug codes.**

Standard drug code mappings return wrong codes by ignoring the dose form — a nasal spray gets tagged with skin-cream and asthma-inhaler codes from the same ingredient. MedCode Lookup resolves the actual administration route from RxNorm metadata, then filters out wrong-route ATC codes and explains why each code was kept or rejected.

Built by [Netanel Greifner, MD MHA](https://navina.ai) — an independent project, not endorsed by NIH, NLM, WHO, or FDA.

---

## What it does

The differentiator: other RXCUI→ATC tools exist, but none explain *why* a code was kept or rejected — both technically (the rule that matched) and clinically (the substance's alternative uses).

### Five modes

| # | Name | Input | Output |
|---|------|-------|--------|
| 1 | RXCUI → ATC | one RXCUI | route-filtered ATC codes with kept/rejected explanations + 5-level code anatomy |
| 2 | Batch RXCUI → ATC | up to 200 RXCUIs | scrollable table with per-row status (clean fix / unchanged / legit-multi / needs-review) |
| 3 | ATC → RXCUIs | one Level-5 ATC | all RxNorm members of that class, route-validated |
| 4 | RXCUI → NDCs | one RXCUI | full NDC list with labeler, packaging, marketing category, FDA approval |
| 5 | Batch RXCUI → NDCs | up to 20 RXCUIs | compact + exploded CSV exports for the whole batch |

---

## How it works

Every result is computed in the browser from public RxNav data — no backend, no patient data, no tracking.

The route-aware resolver runs a three-strategy orchestrator:

1. **ATCPROD** — NLM's curated product-level mapping (~97% of common drugs). If it returns Level-4 codes, the resolver promotes them to Level-5 via `classMembers` walk.
2. **DFG-filtered ingredient ATC** — fetches the drug's dose-form group, resolves a route (nasal, ophthalmic, topical, etc.), and filters ingredient-level ATC codes by an allow/exclude prefix matrix per route.
3. **Property API fallback** — last-resort lookup on the input RXCUI's own ATC property.

Ingredient-level RXCUIs (TTY = IN / MIN / PIN) skip route filtering entirely — there's no single route for a bare ingredient, so all its valid Level-5 ATCs are returned.

The 5-level ATC code anatomy is shown for every kept code, with class names enriched asynchronously from RxClass and a completeness bar showing how much of the 7-character code is filled in.

---

## Stack

- Vanilla JavaScript (ES modules), HTML, CSS
- **Zero build step, zero dependencies**
- Calls [RxNav](https://rxnav.nlm.nih.gov) directly from the browser (15 req/s rate limiter, 30-day localStorage cache)
- Deploys anywhere static — GitHub Pages, Vercel, Netlify, any static host

---

## Running locally

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

That's it — no install, no build.

---

## Architecture (short)

```
index.html
styles.css                  ← single design-system stylesheet (tokens, components, modes)
js/
  app.js                    ← controller (theme, tabs, URL state, paste-detect)
  filter-engine.js          ← pure logic: route resolution + matrix filter
  atc-resolver.js           ← 3-strategy orchestrator
  rxnav-client.js           ← all API calls + cache + rate-limit
  atc-anatomy.js            ← 5-level code anatomy renderer
  code-detection.js         ← auto-detect RXCUI / ATC / NDC
  explanations.js           ← human-readable reason templates
  ui-components.js          ← reusable DOM card renderers
  csv-export.js             ← shared CSV writer
  modes/                    ← one file per mode (mode1–mode5)
scratch/                    ← Node test harness + RXCUI fixture regen
```

**Process rules** (enforced):

- All `fetch()` calls go through `rxnav-client.js` — never inline.
- Filter logic only lives in `filter-engine.js` / `atc-resolver.js`.
- Human-readable strings only in `explanations.js` — no inline UI text.

---

## Disclaimer

**MedCode Lookup is a validation and exploration tool, not a clinical decision support system.** Results are derived from public RxNorm data and a curated route-classification heuristic. The mapping logic may produce false positives or false negatives, particularly for combination products, ingredient-level concepts, and drugs with legitimate cross-route ATC assignments. Always verify results against authoritative sources (WHO ATC, RxNorm, FDA NDC Directory) before use in production systems. **Not for use in patient care decisions.**

Data via [NIH RxNav](https://rxnav.nlm.nih.gov). Independent project, not endorsed by NIH, NLM, WHO, or FDA.

---

## License

MIT
