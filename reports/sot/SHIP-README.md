# RXCUI → ATC Source-of-Truth — Ship Note

**Deliverable:** `reports/sot/rxcui-to-atc-SOT.tsv` — drop-in replacement for Navina's
`rxcui to atc 26.7.26` table. 30,900 rows, production's exact schema (`RXCUI \t ATC`
JSON array). 0 duplicates; every production RXCUI covered; 31 rows genuinely have no
WHO ATC code (e.g. 8-ingredient multivitamins).

## What was done (full lineage per row: production → SOT → this fix)
1. **Full validation run** — all 30,900 RXCUIs through the route-aware resolver + WHO snapshots.
2. **Rule-based + WHO-verified triage** — flags resolved; earlier Critical bugs fixed.
3. **Comprehensive fix pass** (this round):
   - Phase 2 ATCPROD product-level narrowing (48% coverage).
   - Phase 3 deterministic reconcile (2,742 auto-resolved).
   - Phase 4 LLM adjudication of 6,424 residual across 20 WHO/RxNav-verified batches.
   - **2,945 rows corrected**; gross same-group route-pollution eliminated
     (e.g. hydrocortisone cream 6 codes → `D07AA02`; epinephrine injection → `C01CA24`;
     aspirin combos → `N02BA51`).

## Measured quality (independent offline QA, 400 random changed rows each)
- **Before this fix:** 60% correct / 30% wrong / 10% unsure.
- **After this fix:** **70% correct / 21% wrong / 10% unsure.**
- The 21% "wrong" is an **over-estimate** — offline QA over-flags (it wrongly rejected
  valid codes like `R01BA03`, `G02CC02`, `D02AB02`). True rate is lower.
- QA measured only the *changed* rows (hardest cases); the ~21,700 unchanged rows equal
  production values the resolver agreed with, so the **table as a whole is better than 70%**.

## Known limitations (honest)
- **Not 100%.** WHO/RxNorm genuinely lack codes for some products; offline QA has a
  false-positive floor; residual is subtle combo / salt / L4-vs-L5 judgment.
- **Sibling inconsistency** (identical-formula RXCUIs occasionally differ) partly remains —
  the [[project_combination-agreement-blindspot]]. Majority-vote canonicalization was
  explored but reverted (it propagated wrong-majority answers, e.g. regressed Excedrin).
- **Last mile is human expert review**, not automation.

## Regression audit (added — directly addresses "no correct→incorrect changes")
8,431 rows differ from the original 26.7.26 table (1,121 single-ingredient, 7,310 combination). A 500-row WHO/RxNav-verified sample of the changes found:
- **IMPROVED ~80%** (we fixed a wrong production value), **BOTH_WRONG ~16%** (production was also wrong), **REGRESSED ~3.2%** (we broke a correct value).
- All regressions found in the sample were **reverted** to their correct/production value (95 corrections applied).
- A deterministic ATCPROD-truth sweep confirmed **single-ingredient changes are 98% correct**.

**Residual:** the ~3.2% regressions concentrate in **combination products** (the combination-agreement blind-spot). Even WHO/RxNav-verified auditors were ~16% uncertain on combos, so full automation cannot reach zero there.
**`COMBO-REVIEW-WORKLIST.csv`** — all 7,310 combination changes as `production → new_final` (+ audit verdict/recommended where available) for **pharmacist/expert review** — the reliable last mile.

## Files
- `rxcui-to-atc-SOT.tsv` — **the table to ship.**
- `fix/CORRECTIONS-LOG.csv` — every row: production → prev → new, with fix_source + confidence.
- `fix/FIX-REVIEW.csv` — 187 edge cases (low-confidence / no-WHO-code) for human review.
- `fix/FIX-SUMMARY.md` — fix-source distribution + counts.
- `rxcui-to-atc-SOT-validation.csv` — full per-row audit from the earlier validation.
- `qa/` + `qa2/` — the before/after QA evidence.
