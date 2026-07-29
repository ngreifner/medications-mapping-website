# Design — `rxcui_to_atc` Source-of-Truth Rebuild

- **Date:** 2026-07-27
- **Status:** Approved (design), pending implementation plan
- **Owner:** Netanel Greifner, MD MHA — Navina.ai
- **Author (assistant):** Claude Code

---

## 1. Context & problem

Navina maps drugs to WHO ATC therapeutic codes through a `rxcui_to_atc` table. That
table is the upstream source of truth: the NDC-level table derives its ATCs from it,
and downstream logic uses ATC codes to suggest diagnoses. Errors here cause **false
diagnosis suggestions** (e.g. a topical steroid tagged with a systemic code, an oral
decongestant losing its correct oral code).

The current production table (`navina current mapping/rxcui to atc 26.7.26.tsv`,
uploaded 2026-07-26) contains **30,869 unique RXCUIs**. It is byte-for-byte the same
data as the July 15 export (re-serialized as TSV) — meaning **none of our prior
corrections were ever applied to production**. Some rows are even empty (unmapped).

We have prior corrected work in `reports/navina-unified-mapping-FINAL.csv` (30,633
RXCUIs, 10,163 changed from Navina's values), produced in two quality tiers:

- **`dx-v7` (7,950 rows):** in-scope set, corrected with the full route-aware resolver
  + combination handling + WHO ATC snapshots. High confidence.
- **`oos-v6` (22,683 rows):** out-of-scope set, corrected with a blanket route→ATC
  matrix + adversarial validation. ~96% correct with documented systematic holes.

## 2. Goal

Produce **one brand-new corrected `RXCUI → ATC` table** that replaces Navina's
production table and becomes the source of truth.

The correctness bar is: **every row is validated against WHO ground truth; everything
the source data can adjudicate is corrected; the irreducible remainder is explicitly
flagged for human review — never shipped silently wrong.**

### What "100% correct" honestly means here

Literal 100% cannot be *guaranteed* by any automated tool, because the public data
itself has gaps: WHO/RxNorm sometimes do not expose a code a drug should carry
(documented cases: `N04BA02` Sinemet, salt/PIN-attributed L5s, combination products
with no MIN concept in RxClass). For those, no tool can synthesize ground truth. The
deliverable is therefore **"correct wherever the source data is determinate, with zero
silent errors"** — the indeterminate cases are surfaced in a review file, not buried.

## 3. Non-goals

- Not rebuilding the NDC-level table (`ndc to rxcui to atc`) in this task. That is a
  separate downstream job once `rxcui_to_atc` is final.
- Not changing the app (`js/*`) or its resolver logic. We *use* the resolver as the
  validation engine; we do not modify it.
- Not applying the fix to Navina's production database. We produce the corrected
  table + audit; deployment is Navina's.

## 4. Inputs

| Input | Path | Role |
|---|---|---|
| New production table | `navina current mapping/rxcui to atc 26.7.26.tsv` | The 30,869-RXCUI universe + baseline values to validate/correct |
| Prior corrected work | `reports/navina-unified-mapping-FINAL.csv` | Our previous certified values (seed; still re-validated) |
| Validation engine | `js/atc-resolver.js` via `scratch/audit-batch.js` harness | The route-aware resolver (Phase 2B–2I) |
| WHO ground truth | `data/who-atc-snapshots/*.json` + WHO ATC index (atcddd.fhi.no) | Cross-check for every new/contradicted/third-answer code |
| RxNav API | `https://rxnav.nlm.nih.gov/REST` | Live enrichment (TTY, DFG, DF, classMembers, property) |

**RXCUI universe of the output:** the 30,869 production RXCUIs **∪** our 31 validated
extras = ~30,900 rows. The 31 extras are kept (valid RXCUIs we already resolved;
harmless additional coverage), provenance-tagged.

## 5. Validation tool

The app's full route-aware resolver, `js/atc-resolver.js`, driven by the existing
`scratch/audit-batch.js` batch harness (the same engine that produced the prior audit).
It includes the complete Phase 2B–2I logic: combination detection, MIN-property L5,
curated combination catalog, WHO-snapshot name matching, form-determined and
strength-determined overrides. This is the most capable validator available and is
preferred over the simpler route-matrix Python script (`meds-atc-filter` Mode A).

Sandbox note: **Python `urllib` network is blocked; use `curl` or Node `fetch`.** The
resolver harness is Node-based (uses `fetch`), so it runs natively. RxNav calls go
through the client's 15 req/s limiter + 30-day cache; the full run is ~2–3 hours in
resumable background batches.

## 6. Algorithm — per RXCUI

For each of the ~30,900 RXCUIs:

1. **Resolve** the RXCUI through `atc-resolver.js` → `resolver_atcs` (+ verdict state:
   KEEP / INGREDIENT_LEVEL / COMBINATION_NO_DEDICATED_CODE / NO_ATC, and provenance).
2. **Compare** three values: `production_atcs`, `our_prior_atcs` (prior certified, if
   any), `resolver_atcs`.
3. **WHO ground-truth cross-check** on every code that is new or in dispute (i.e.
   whenever `resolver_atcs` ≠ `production_atcs`, or the resolver returns only an L4 /
   NO_ATC). Look up the code's L4 in the WHO snapshot / index; confirm the substance
   and route match.
4. **Assign the row's value + verdict:**
   - **CORRECT** — resolver = production, WHO consistent → keep value.
   - **CORRECTED** — resolver ≠ production and WHO confirms resolver → adopt resolver
     value. (Sub-case **CORRECTED_FROM_EMPTY** when production was empty and the
     resolver + WHO produce a confident code — net-new coverage.)
   - **FLAG_DATA_GAP** — resolver hits a known infrastructure gap (L4-only, PIN
     attribution, combo-with-no-MIN) → keep best reachable value, flag.
   - **FLAG_REVIEW** — resolver, production, and WHO cannot be reconciled, or the
     resolver contradicts a prior high-confidence `dx-v7` value → keep best-known
     value, flag for human adjudication.
5. **Safety valve:** never turn a non-empty production mapping into an empty output.
   If resolution collapses to nothing, retain the production value and flag.

Empty-in-production rows are resolved fresh; if the resolver + WHO produce a
confident code, that is **net-new coverage** (CORRECTED-from-empty). If not, they
stay empty and are flagged.

## 7. Guardrails / QA

- **WHO cross-check on every new/disputed code** — no knowledge-only verdicts
  (standing user rule).
- **Safety valve** — a row that had a mapping never becomes empty in the output.
- **Regression fixtures** must still hold after the run:
  - 1797907 fluticasone nasal → `R01AD08`
  - 617310 atorvastatin oral → `C10AA05`
  - 2702393 timolol ophthalmic → `S01ED01`
  - 151399 Bactrim → `J01EE01`
  - 1544396 Rasuvo (methotrexate auto-injector) → `L04AX03`; methotrexate vial → `L01BA01`
  - everolimus ≤1mg → `L04AH02`, >1mg → `L01EG02`
- **General mechanisms over per-drug patches** (standing user rule): fixes come from
  the resolver + WHO reconciliation, not hand-edited single rows. Any hand-curation
  goes into the resolver's curated tables, not the output CSV.

## 8. Deliverables

All under `reports/` (working dir), production-format primary + CSV sidecars:

1. **`rxcui-to-atc-SOT.tsv`** — the new table. Production's exact schema
   (`RXCUI \t ATC`, ATC = JSON array), drop-in replacement, all ~30,900 rows.
2. **`rxcui-to-atc-SOT-validation.csv`** — full audit, one row per RXCUI:
   `rxcui, drug_name, tty, production_atcs, our_prior_atcs, resolver_atcs, who_check,
   verdict, final_atcs, source`.
3. **`rxcui-to-atc-SOT-review.csv`** — only `FLAG_DATA_GAP` + `FLAG_REVIEW` rows, for
   human adjudication (with the resolver's alternative and WHO note).
4. **`SOT-summary.md`** — counts (correct / corrected / corrected-from-empty /
   flag-data-gap / flag-review), the before→after headline, and the top medication
   families corrected.

## 9. Acceptance criteria

- [ ] Output covers every production RXCUI (30,869) + the 31 extras; no RXCUI dropped.
- [ ] Every changed row (`final_atcs` ≠ `production_atcs`) appears in the validation CSV
      with a WHO cross-check result.
- [ ] Zero rows go from non-empty (production) to empty (output) without a FLAG.
- [ ] All regression fixtures (§7) resolve to their expected codes.
- [ ] The review CSV contains only genuinely irreducible/ambiguous rows; every other
      row is either CORRECT or CORRECTED-with-WHO-confirmation.
- [ ] `SOT-summary.md` reconciles: correct + corrected + corrected-from-empty +
      flagged = total rows.

## 10. Known limitations (carried into the review file, not silently)

- **Combos with no MIN concept** in RxClass (e.g. `N04BA02` Sinemet) — resolver reaches
  only the L4 or a single-ingredient L5; flagged.
- **Salt/PIN-attributed L5s** — mostly handled by the resolver's IN∪PIN matchIds, but
  residual salt-named classes may still under-resolve; flagged.
- **Ingredient-level RXCUIs (IN/MIN/PIN)** — no route filtering possible; all
  substance-level ATCs kept (by design), marked INGREDIENT_LEVEL.
- **RxNorm freshness** — resolution reflects RxNorm's last monthly release; brand-new
  RXCUIs may under-resolve.

## 11. Open questions

None outstanding. Decisions locked:
- Quality bar: validate **all** ~30,869 rows (not just diffs).
- On resolver-vs-us disagreement: **keep our value, flag** (no auto-flip).
- Gaps (267 untouched + empties): resolve fresh, fill where determinate.
- Extras (31): keep, provenance-tagged.
- Format: production's exact TSV serialization for the primary; CSV sidecars.
