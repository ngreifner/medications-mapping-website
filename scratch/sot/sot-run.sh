#!/bin/zsh
# scratch/sot/sot-run.sh — full SOT validation run, resumable.
set -e
cd "/Users/Netanel.Greifner/medications mapping website"
ROOT="skills/route-aware-atc-audit/audit-output-sot"
export AUDIT_BATCH_DIR="skills/route-aware-atc-audit/batches-sot"
export AUDIT_OUT_ROOT="$ROOT"
export AUDIT_CACHE_PATH="$ROOT/cache.json"
export AUDIT_NUM_BATCHES=12
LOG="$ROOT/progress.log"
mkdir -p "$ROOT"
for b in $(seq 1 12); do
  if [ -f "$ROOT/batch-$b/master-diff.csv" ]; then
    echo "[$(date +%H:%M:%S)] batch $b already done — skip" >> "$LOG"; continue
  fi
  echo "[$(date +%H:%M:%S)] ===== BATCH $b of 12 START =====" >> "$LOG"
  node scratch/audit-batch.js $b >> "$LOG" 2>&1
  echo "[$(date +%H:%M:%S)] ===== BATCH $b DONE =====" >> "$LOG"
done
# Combine: concat all per-batch master-diff.csv into one (header once).
COMBINED="$ROOT/master-diff.csv"
head -1 "$ROOT/batch-1/master-diff.csv" > "$COMBINED"
for b in $(seq 1 12); do awk 'FNR>1' "$ROOT/batch-$b/master-diff.csv" >> "$COMBINED"; done
echo "[$(date +%H:%M:%S)] ===== ALL BATCHES DONE + COMBINED ($(wc -l < "$COMBINED") lines) =====" >> "$LOG"
