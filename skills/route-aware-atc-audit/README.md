# route-aware-atc-audit

A Claude skill that applies the MedCode Lookup app's route-aware RxCUI→ATC
correction logic to large existing mapping tables (Navina-style meds index,
EHR drug master, claims data — anything with `rxcui` and `atc` columns).

## What you get

Drop this directory into any Claude Code installation under
`~/.claude/skills/route-aware-atc-audit/` (or any path Claude scans for
skills). When the user asks Claude to "audit our meds index" or similar,
the skill runs `audit.py` over the input CSV and produces:

- `clean.csv` — every input row with the engine's `resolved_atc`
- `flagged.csv` — only the rows where the resolved ATC differs from the input
- `needs_review.csv` — rows the engine couldn't resolve to Level 5
- `summary.json` — counts + timing
- `cache.sqlite` — RxNav response cache (30-day TTL, persists between runs)

## Direct CLI usage

The Python is also runnable standalone. No pip dependencies — uses only the standard library:

```bash
cd skills/route-aware-atc-audit
python3 audit.py path/to/your_index.csv ./output/
```

Smoke test against the provided 6-row fixture:

```bash
python audit.py sample_input.csv ./smoke_output/ --limit 6
cat smoke_output/summary.json
```

## Files

| File              | Role                                                                 |
|-------------------|----------------------------------------------------------------------|
| `SKILL.md`        | Skill definition. Read by Claude when the skill activates.           |
| `engine.py`       | Python port of the app's resolver (atc-resolver.js + filter-engine.js). |
| `audit.py`        | CSV-in / CSV-out driver with worker pool, resume, and progress.      |
| `sample_input.csv`| 6-row smoke-test fixture covering KEEP_UNCHANGED / CORRECTED / NO_RESOLUTION. |

## Keeping in sync with the app

`engine.py` carries verbatim copies of three things from the MedCode Lookup
repo:

- `DFG_ROUTE_MAP`, `DFG_PRIORITY`, `ROUTE_ATC_MATRIX` from `js/filter-engine.js`
- The three-strategy resolution order in `convert_rxcui_to_atc`
- The `resolveLevel5FromClassMembers` three-pass match (incl. MIN-equality)

When the app updates any of those, copy the new values across.

## Runtime

Cold-cache estimate: ~0.4 seconds per RxCUI end-to-end. So:

- 1,000 rows ≈ 7 minutes
- 10,000 rows ≈ 70 minutes
- 100,000 rows ≈ 11 hours

The disk cache (`cache.sqlite`) cuts re-runs by ~10× or more once it warms
up. Use `--workers N` to tune parallelism; the default (8) is safe under the
15 req/sec limit. Use `--limit N` to smoke-test on a slice before
committing to the full job.

## Disclaimer

The corrected mappings come from public RxNorm data and a curated
route-classification heuristic. Output may produce false positives or
false negatives, especially for combination products and ingredient-level
concepts. Verify a sample against WHO ATC, RxNorm, and FDA NDC Directory
before deploying to production claims data.
