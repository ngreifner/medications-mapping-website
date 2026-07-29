#!/bin/zsh
# scratch/sot/sot-run-parallel.sh — parallel SOT validation run.
# The run is CPU-bound (cache-hit-heavy), so parallelizing adds little network
# load. Each batch gets its OWN cache copy to avoid concurrent-write races on
# the shared seed. Concurrency capped at 4 to stay well under NLM's 20 req/s
# even on the sparse cache misses. Resumable: skips batches with a master-diff.
cd "/Users/Netanel.Greifner/medications mapping website"
ROOT="skills/route-aware-atc-audit/audit-output-sot"
SEED="$ROOT/cache.json"
export AUDIT_BATCH_DIR="skills/route-aware-atc-audit/batches-sot"
export AUDIT_OUT_ROOT="$ROOT"
export AUDIT_NUM_BATCHES=12
LOG="$ROOT/parallel-progress.log"
CONC=4
: > "$LOG"
run_batch() {
  local b=$1
  if [ -f "$ROOT/batch-$b/master-diff.csv" ]; then echo "[$(date +%H:%M:%S)] batch $b already done — skip" >> "$LOG"; return; fi
  local cache="$ROOT/cache-$b.json"
  [ -f "$cache" ] || cp "$SEED" "$cache"
  echo "[$(date +%H:%M:%S)] batch $b START" >> "$LOG"
  AUDIT_CACHE_PATH="$cache" node scratch/audit-batch.js $b >> "$ROOT/batch-$b.stdout.log" 2>&1
  echo "[$(date +%H:%M:%S)] batch $b DONE" >> "$LOG"
}
i=0
for b in $(seq 1 12); do
  run_batch $b &
  i=$((i+1))
  if [ $((i % CONC)) -eq 0 ]; then wait; fi
done
wait
COMBINED="$ROOT/master-diff.csv"
head -1 "$ROOT/batch-1/master-diff.csv" > "$COMBINED"
for b in $(seq 1 12); do awk 'FNR>1' "$ROOT/batch-$b/master-diff.csv" >> "$COMBINED"; done
echo "[$(date +%H:%M:%S)] ===== ALL BATCHES DONE + COMBINED ($(awk 'FNR>1' "$COMBINED" | wc -l | tr -d ' ') rows) =====" >> "$LOG"
