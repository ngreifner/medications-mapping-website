#!/bin/zsh
# scratch/sot/atcprod-narrow-parallel.sh — parallel ATCPROD narrowing run.
# Splits the fix worklist into N chunks (scratch/sot/split-worklist.mjs),
# gives each chunk its OWN cache copy (seeded from the shared warm cache) to
# avoid concurrent-write races, runs chunks concurrently capped at CONC, then
# concatenates all per-chunk outputs into reports/sot/fix/01-atcprod-candidates.csv
# and merges the per-chunk caches back into the shared cache for future reuse.
#
# Resumable: atcprod-narrow.mjs itself skips rxcuis already present in a
# chunk's output file, so re-running this script picks up where it left off.
cd "/Users/Netanel.Greifner/medications mapping website"

N=${1:-10}
CONC=${2:-8}

ROOT="scratch/sot/chunks"
SEED="skills/route-aware-atc-audit/audit-output-sot/cache.json"
FINAL_OUT="reports/sot/fix/01-atcprod-candidates.csv"
LOG="$ROOT/parallel-progress.log"

mkdir -p "$ROOT"
node scratch/sot/split-worklist.mjs "$N"
: > "$LOG"

run_chunk() {
  local i=$1
  local pad=$(printf "%02d" "$i")
  local worklist="$ROOT/worklist-$pad.csv"
  [ -f "$worklist" ] || { echo "[$(date +%H:%M:%S)] chunk $pad: no worklist file, skip" >> "$LOG"; return; }
  local expected=$(($(wc -l < "$worklist") - 1))
  local out="$ROOT/output-$pad.csv"
  if [ -f "$out" ]; then
    local have=$(($(wc -l < "$out") - 1))
    if [ "$have" -ge "$expected" ]; then
      echo "[$(date +%H:%M:%S)] chunk $pad already complete ($have/$expected) — skip" >> "$LOG"
      return
    fi
  fi
  local cache="$ROOT/cache-$pad.json"
  [ -f "$cache" ] || cp "$SEED" "$cache"
  echo "[$(date +%H:%M:%S)] chunk $pad START ($expected rows)" >> "$LOG"
  ATCPROD_WORKLIST="$worklist" \
  ATCPROD_OUTPUT="$out" \
  ATCPROD_CACHE_PATH="$cache" \
  ATCPROD_LOG_PATH="$ROOT/log-$pad.log" \
  ATCPROD_CONCURRENCY="${ATCPROD_CONCURRENCY:-10}" \
  node scratch/sot/atcprod-narrow.mjs >> "$ROOT/chunk-$pad.stdout.log" 2>&1
  echo "[$(date +%H:%M:%S)] chunk $pad DONE" >> "$LOG"
}

i=0
for c in $(seq 1 $N); do
  run_chunk $c &
  i=$((i+1))
  if [ $((i % CONC)) -eq 0 ]; then wait; fi
done
wait

# ---- Concatenate all per-chunk outputs into the final combined CSV ----
echo "rxcui,atcprod_l4s,candidate_l5,coverage" > "$FINAL_OUT"
for c in $(seq 1 $N); do
  pad=$(printf "%02d" "$c")
  out="$ROOT/output-$pad.csv"
  [ -f "$out" ] && awk 'FNR>1' "$out" >> "$FINAL_OUT"
done
total=$(($(wc -l < "$FINAL_OUT") - 1))
echo "[$(date +%H:%M:%S)] ===== ALL CHUNKS DONE + COMBINED ($total rows) -> $FINAL_OUT =====" >> "$LOG"
echo "Combined output: $total rows -> $FINAL_OUT"

# ---- Merge per-chunk caches back into the shared cache for future reuse ----
node scratch/sot/merge-chunk-caches.mjs "$N"
echo "[$(date +%H:%M:%S)] ===== CACHE MERGE DONE =====" >> "$LOG"
