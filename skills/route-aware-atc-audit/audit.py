#!/usr/bin/env python3
"""
audit.py — Drive engine.py over a CSV of (rxcui, atc) pairs.

Usage:
    python audit.py <input.csv> <output_dir> [--workers N] [--limit N]

Output (written to <output_dir>):
    clean.csv         — every input row + resolved_atc, resolved_atc_name, route, verdict, reason
    flagged.csv       — subset of clean.csv where resolved_atc differs from input atc
    needs_review.csv  — rows where the engine could not resolve to Level 5
    summary.json      — counts + timing
    cache.sqlite      — RxNav response cache (30-day TTL, kept across runs)
    progress.jsonl    — checkpoint, written every CHECKPOINT_EVERY rows

Re-running the same command resumes from progress.jsonl. Delete it (or use
a fresh output dir) to start over.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time
from typing import Dict, Iterable, List, Optional, Tuple

from engine import AtcResolver

CHECKPOINT_EVERY = 100
DEFAULT_WORKERS = 8


# ----------------------------------------------------------------------
# Column detection
# ----------------------------------------------------------------------

RXCUI_HEADER_CANDIDATES = ("rxcui", "rx_cui", "rxnorm_cui", "rxnorm_id")
ATC_HEADER_CANDIDATES   = ("atc", "atc_code", "atc_l5", "atc5", "atc_id")


def pick_column(headers: List[str], candidates: Tuple[str, ...]) -> str:
    lower = {h.lower(): h for h in headers}
    for cand in candidates:
        if cand in lower:
            return lower[cand]
    raise SystemExit(
        f"Couldn't find an expected column. Looked for any of {candidates}; "
        f"header is {headers}"
    )


# ----------------------------------------------------------------------
# Resume support
# ----------------------------------------------------------------------

def load_processed(progress_path: str) -> Dict[str, dict]:
    """Read progress.jsonl into a dict keyed by (rxcui, atc) → verdict-record."""
    out: Dict[str, dict] = {}
    if not os.path.exists(progress_path):
        return out
    with open(progress_path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
                key = f"{row['rxcui']}::{row['input_atc']}"
                out[key] = row
            except (json.JSONDecodeError, KeyError):
                continue
    return out


def append_progress(progress_path: str, row: dict) -> None:
    with open(progress_path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(row, ensure_ascii=False) + "\n")


# ----------------------------------------------------------------------
# Per-row classification: input_atc vs the engine's verdict.
# ----------------------------------------------------------------------

def classify_row(input_atc: str, verdict: dict) -> Tuple[str, str, str, str, str]:
    """Return (resolved_atc, resolved_atc_name, route, verdict_label, reason)."""
    status = verdict.get("status", "")
    route = verdict.get("route") or ""
    codes = verdict.get("codes") or []

    if status == "NO_ATC":
        return ("", "", route, "NO_RESOLUTION", "Engine could not resolve any Level 5 ATC")

    if status == "ERROR":
        return ("", "", route, "NO_RESOLUTION", verdict.get("error") or "Engine error")

    # Strip Level-4 fallbacks; only L5 codes are user-facing.
    l5_codes = [c for c in codes if len(c.get("code", "")) == 7]

    if not l5_codes:
        if status == "KEEP" and codes:
            # All codes are L4 fallbacks.
            return ("", "", route, "NO_RESOLUTION", "Only Level 4 codes resolvable (L4 fallback)")
        return ("", "", route, "NO_RESOLUTION", "No Level 5 codes returned")

    input_upper = (input_atc or "").upper().strip()

    if status == "INGREDIENT_LEVEL":
        # Ingredient-level: every L5 is a valid mapping for the substance.
        # If input ATC is one of them, KEEP_UNCHANGED. Otherwise CORRECTED
        # using the first L5 as the primary suggestion.
        for c in l5_codes:
            if c["code"].upper() == input_upper:
                return (c["code"], c.get("name") or "", route, "KEEP_UNCHANGED",
                        "Ingredient-level RxCUI; input ATC matches one of the canonical L5s")
        primary = l5_codes[0]
        return (primary["code"], primary.get("name") or "", route, "CORRECTED",
                f"Ingredient-level; input ATC not in canonical L5 set ({', '.join(c['code'] for c in l5_codes)})")

    # status == "KEEP" (route-aware resolution)
    for c in l5_codes:
        if c["code"].upper() == input_upper:
            return (c["code"], c.get("name") or "", route, "KEEP_UNCHANGED",
                    "Engine confirmed the input ATC")
    primary = l5_codes[0]
    reason = (f"Engine resolved to {primary['code']} via route '{route}'; "
              f"input was {input_atc}")
    return (primary["code"], primary.get("name") or "", route, "CORRECTED", reason)


# ----------------------------------------------------------------------
# Streaming worker pool driver
# ----------------------------------------------------------------------

def iter_input_rows(input_path: str, rxcui_col: str, atc_col: str) -> Iterable[dict]:
    with open(input_path, "r", encoding="utf-8", newline="") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            rx = (row.get(rxcui_col) or "").strip()
            atc = (row.get(atc_col) or "").strip()
            if not rx:
                continue
            yield row


def fmt_duration(secs: float) -> str:
    secs = int(secs)
    if secs < 60:
        return f"{secs}s"
    m, s = divmod(secs, 60)
    if m < 60:
        return f"{m}m {s}s"
    h, m = divmod(m, 60)
    return f"{h}h {m}m"


def run(input_path: str, output_dir: str, workers: int, limit: Optional[int]) -> None:
    os.makedirs(output_dir, exist_ok=True)
    cache_path    = os.path.join(output_dir, "cache.sqlite")
    progress_path = os.path.join(output_dir, "progress.jsonl")
    clean_path    = os.path.join(output_dir, "clean.csv")
    flagged_path  = os.path.join(output_dir, "flagged.csv")
    review_path   = os.path.join(output_dir, "needs_review.csv")
    summary_path  = os.path.join(output_dir, "summary.json")

    # Detect columns
    with open(input_path, "r", encoding="utf-8", newline="") as fh:
        reader = csv.reader(fh)
        headers = next(reader)
    rxcui_col = pick_column(headers, RXCUI_HEADER_CANDIDATES)
    atc_col   = pick_column(headers, ATC_HEADER_CANDIDATES)
    print(f"[audit] rxcui column = {rxcui_col!r}, atc column = {atc_col!r}", file=sys.stderr)

    processed = load_processed(progress_path)
    if processed:
        print(f"[audit] resuming, {len(processed)} rows already done", file=sys.stderr)

    resolver = AtcResolver(cache_path=cache_path)

    # Count total rows for progress
    with open(input_path, "r", encoding="utf-8", newline="") as fh:
        total = sum(1 for _ in fh) - 1  # minus header
    if limit:
        total = min(total, limit)
    print(f"[audit] processing {total} row(s)", file=sys.stderr)

    out_headers = headers + ["resolved_atc", "resolved_atc_name", "route", "verdict", "reason"]
    clean_fh   = open(clean_path,   "w", encoding="utf-8", newline="")
    flagged_fh = open(flagged_path, "w", encoding="utf-8", newline="")
    review_fh  = open(review_path,  "w", encoding="utf-8", newline="")
    clean_w   = csv.writer(clean_fh)
    flagged_w = csv.writer(flagged_fh)
    review_w  = csv.writer(review_fh)
    clean_w.writerow(out_headers)
    flagged_w.writerow(out_headers)
    review_w.writerow(out_headers)

    # If resuming, we need to re-emit all previously-processed rows from the
    # progress log into the output files (the output files were truncated at
    # start). This keeps the output files in sync with progress.jsonl.
    if processed:
        for rec in processed.values():
            _write_record(rec, headers, clean_w, flagged_w, review_w)

    counts = {"KEEP_UNCHANGED": 0, "CORRECTED": 0, "NO_RESOLUTION": 0}
    for rec in processed.values():
        counts[rec["verdict"]] = counts.get(rec["verdict"], 0) + 1

    start = time.monotonic()
    done = len(processed)

    from concurrent.futures import ThreadPoolExecutor, as_completed
    ex = ThreadPoolExecutor(max_workers=workers)

    pending = {}
    processed_so_far = 0
    for row in iter_input_rows(input_path, rxcui_col, atc_col):
        if limit and processed_so_far >= limit:
            break
        processed_so_far += 1
        rx = (row.get(rxcui_col) or "").strip()
        atc_in = (row.get(atc_col) or "").strip()
        key = f"{rx}::{atc_in}"
        if key in processed:
            continue
        fut = ex.submit(_process_row, resolver, row, headers, rxcui_col, atc_col)
        pending[fut] = (key, row)

        # Drain when pool is busy, so we keep at most ~workers*4 futures.
        if len(pending) >= workers * 4:
            _drain(pending, clean_w, flagged_w, review_w, progress_path,
                   counts, headers, total, start, done)
            done = sum(counts.values())

    # Flush remaining
    _drain(pending, clean_w, flagged_w, review_w, progress_path,
           counts, headers, total, start, done, force=True)

    ex.shutdown()
    clean_fh.close()
    flagged_fh.close()
    review_fh.close()

    elapsed = time.monotonic() - start
    summary = {
        "input_path": input_path,
        "output_dir": output_dir,
        "total_rows": total,
        "counts": counts,
        "elapsed_seconds": int(elapsed),
        "elapsed_human": fmt_duration(elapsed),
    }
    with open(summary_path, "w", encoding="utf-8") as fh:
        json.dump(summary, fh, indent=2)
    print(json.dumps(summary, indent=2))


def _process_row(resolver: AtcResolver, row: dict, headers: List[str],
                 rxcui_col: str, atc_col: str) -> dict:
    rx = (row.get(rxcui_col) or "").strip()
    atc_in = (row.get(atc_col) or "").strip()
    try:
        verdict = resolver.convert_rxcui_to_atc(rx)
    except Exception as e:
        verdict = {"status": "ERROR", "error": str(e), "codes": []}
    resolved, resolved_name, route, label, reason = classify_row(atc_in, verdict)
    rec = {
        "rxcui": rx,
        "input_atc": atc_in,
        "_row": [row.get(h, "") for h in headers],
        "resolved_atc": resolved,
        "resolved_atc_name": resolved_name,
        "route": route,
        "verdict": label,
        "reason": reason,
    }
    return rec


def _write_record(rec: dict, headers: List[str], clean_w, flagged_w, review_w) -> None:
    original_row = rec.get("_row") or [rec.get(h, "") for h in headers]
    out_row = list(original_row) + [
        rec["resolved_atc"], rec["resolved_atc_name"],
        rec["route"], rec["verdict"], rec["reason"],
    ]
    clean_w.writerow(out_row)
    if rec["verdict"] == "NO_RESOLUTION":
        review_w.writerow(out_row)
    elif rec["verdict"] == "CORRECTED":
        flagged_w.writerow(out_row)


def _drain(pending, clean_w, flagged_w, review_w, progress_path,
           counts, headers, total, start, done_at_call_start, force=False):
    from concurrent.futures import as_completed
    keys = list(pending.keys())
    if not force:
        # Drain just enough to keep buffer healthy.
        keys = keys[: max(1, len(keys) // 2)]
    for f in as_completed(keys):
        key, _row = pending.pop(f)
        rec = f.result()
        _write_record(rec, headers, clean_w, flagged_w, review_w)
        append_progress(progress_path, rec)
        counts[rec["verdict"]] = counts.get(rec["verdict"], 0) + 1
        done = sum(counts.values())
        if done % CHECKPOINT_EVERY == 0 or done == total:
            elapsed = time.monotonic() - start
            rate = done / max(0.001, elapsed)
            remaining = max(0, (total - done) / max(0.001, rate))
            print(f"[audit] {done:,} / {total:,} ({done*100//max(1,total)}%) "
                  f"— {fmt_duration(remaining)} remaining", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser(description="Route-aware ATC mapping audit")
    ap.add_argument("input", help="Path to input CSV (must have rxcui + atc columns)")
    ap.add_argument("output_dir", help="Directory for output files (created if missing)")
    ap.add_argument("--workers", type=int, default=DEFAULT_WORKERS,
                    help=f"Concurrent rows (default {DEFAULT_WORKERS})")
    ap.add_argument("--limit", type=int, default=None,
                    help="Process at most N rows (useful for smoke tests)")
    args = ap.parse_args()
    run(args.input, args.output_dir, args.workers, args.limit)


if __name__ == "__main__":
    main()
