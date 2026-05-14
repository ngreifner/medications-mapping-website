---
name: route-aware-atc-audit
description: Use when the user asks to audit, validate, correct, clean, or fix a large existing RxCUI→ATC mapping table (Navina-style meds index, claims data, EHR codeset, or any CSV with rxcui + atc columns). Applies the route-aware filter from MedCode Lookup at scale, resolving each RxCUI's dose form, dropping wrong-route ATC codes, promoting Level 4 to Level 5 via class members, MIN-equality matching for combination products, and producing clean / flagged / needs-review CSVs plus a summary. Designed for batch jobs up to ~100,000 rows with persistent caching and resumability. Trigger phrases include "audit our meds index", "validate our RxCUI to ATC mappings", "fix wrong-route ATC", "clean up the medication mapping table".
---

# Route-aware ATC mapping audit

This skill audits an existing RxCUI→ATC mapping table against the route-aware
rules from the MedCode Lookup app. For every `(rxcui, current_atc)` pair it
runs the same three-strategy resolver the app uses interactively, then writes
three output CSVs:

- `clean.csv` — every input row with the engine's chosen `resolved_atc`
  (often equal to the input ATC; sometimes different; sometimes empty when
  unresolvable).
- `flagged.csv` — only the rows where the resolved ATC differs from the
  input ATC. These are the substantive corrections.
- `needs_review.csv` — rows the engine could not resolve to a Level 5 code,
  with the reason recorded.

It also prints a summary: total rows, kept-unchanged, corrected, needs-review.

## When to use this skill

Trigger this skill when the user wants to apply the MedCode Lookup
correction logic to a large existing dataset and the dataset is too big to
process row-by-row through the interactive app. Typical inputs are pharmacy
benefit manager meds indexes, EHR drug master tables, or claims data.

Do NOT use this skill for:

- Single-RxCUI lookups (the user should use the app for those).
- Mapping from ATC back to RxCUIs (different direction; the app's Mode 3
  handles that interactively).
- NDC lookups (use the MedCode Lookup app's Mode 4/5/6 tabs).

## Inputs

The user supplies a CSV with at minimum:

| Column   | Required | Description                              |
|----------|----------|------------------------------------------|
| `rxcui`  | yes      | RxNorm Concept Unique Identifier (numeric) |
| `atc`    | yes      | The current ATC code to validate         |

Other columns (`drug_name`, `source_id`, etc.) are preserved verbatim in the
output. Column order in `clean.csv` is: original columns first, then
`resolved_atc`, `resolved_atc_name`, `route`, `verdict`, `reason`.

Acceptable alternative column names (case-insensitive): `rxcui`/`RXCUI`/`rx_cui`,
`atc`/`ATC`/`atc_code`/`atc_l5`. Detect the columns by header pattern; ask
the user if ambiguous.

## Required tools

- Python 3.9+ on PATH (standard library only, no pip dependencies)
- Network access to `https://rxnav.nlm.nih.gov`

The Python implementation lives in `engine.py` (the resolver, mirrors the
app's `js/atc-resolver.js`) and `audit.py` (the CSV-in/CSV-out driver).

## Workflow

When invoked, perform these steps in order. Confirm with the user before
launching a long run.

### 1. Verify the input

Read the first ~10 rows with `head` or Python. Confirm:
- File exists and is a CSV.
- Has `rxcui` and `atc` columns (or close variants).
- RxCUIs look numeric. ATCs look like ATC codes.

Tell the user the row count and ask them to confirm before running.

### 2. Estimate runtime

Each RxCUI makes ~4–6 RxNav requests. The default rate limit in `engine.py`
is 15 req/sec with a pool of 6 concurrent. Cold-cache estimate is roughly
**0.4 seconds per RxCUI** end-to-end. Quote that to the user:

- 1,000 rows: ~7 minutes
- 10,000 rows: ~70 minutes
- 100,000 rows: ~11 hours

If the user is rerunning a partially-completed job, the disk cache cuts
this drastically — typically 10× faster on repeated runs.

### 3. Run the audit

```bash
python audit.py <input.csv> <output_dir>
```

The script:
- Creates `<output_dir>/cache.sqlite` if missing. 30-day TTL on all entries.
- Streams the input row-by-row so memory stays small.
- Writes a `progress.jsonl` checkpoint every 100 rows; reruns automatically
  resume from the last checkpoint if interrupted.
- Prints progress to stderr: `12,453 / 100,000 (12%) — 4h 23m remaining`.

### 4. Report the output

When complete, four files exist in `<output_dir>`:

- `clean.csv`
- `flagged.csv` (subset of `clean.csv`)
- `needs_review.csv`
- `summary.json` (counts + timing)

Print the summary to the user. Suggested format:

```
Audited 100,000 rows in 11h 12m.
  - 78,234 kept unchanged (input ATC matched the engine's verdict)
  - 17,901 corrected (input ATC replaced by route-aware verdict)
  -  3,865 needs review (no DFG, INGREDIENT_LEVEL ambiguous, or no ATC mapped)
```

Then list a handful of representative rows from `flagged.csv` so the user
can sanity-check the corrections before applying them.

## Verdict states (preserved in clean.csv)

- `KEEP_UNCHANGED` — engine resolved to the same ATC the user supplied.
- `CORRECTED` — engine resolved to a different ATC; the input was wrong-
  route or otherwise mismatched.
- `INGREDIENT_LEVEL` — RxCUI is TTY=IN/MIN/PIN; route filter doesn't apply;
  the engine returned all canonical Level 5 codes for the substance. The
  input ATC is considered correct if it appears in that set.
- `NO_RESOLUTION` — engine couldn't resolve any Level 5 ATC. Row appears in
  `needs_review.csv` with the reason in the `reason` column.

## Single source of truth

The route matrix (`DFG_ROUTE_MAP`, `DFG_PRIORITY`, `ROUTE_ATC_MATRIX`) and
the three-strategy resolution order are defined verbatim in `engine.py` and
match `js/filter-engine.js` + `js/atc-resolver.js` in the MedCode Lookup
repo. Do not edit them without coordinating with the app team. If the matrix
in the app is updated, copy the new values into `engine.py` here so the skill
stays in sync.

## Known limitations

(Documented in the MedCode Lookup repo's `CLAUDE.md`; the same caveats apply.)

- Combination products in classes lacking MIN-L5 attribution in RxClass (e.g.
  carbidopa+levodopa, which RxClass classifies only at L4 N04BA, not L5
  N04BA02) will resolve to the single-ingredient L5 instead of the combo L5,
  and the row may appear in `flagged.csv` as a substitution or in
  `needs_review.csv`. This is a RxClass coverage gap, not an algorithm gap.
- ATCPROD coverage is ~97% of common Medicare Part-D products; novel,
  international, or rare drugs may fall through to the lower-confidence
  Strategy 2/3 paths.
- The route filter is a strong heuristic, not perfect ground truth. Some
  drugs legitimately map to multiple anatomical groups in WHO ATC. Treat
  output as advisory.

## Disclaimer to the user

Always include this when presenting results: the corrected mappings are
derived from public RxNorm data and a curated route-classification
heuristic. The output may produce false positives or false negatives,
particularly for combination products and ingredient-level concepts.
Verify a sample against WHO ATC, RxNorm, and FDA NDC Directory before
deploying corrections to production claims data.
