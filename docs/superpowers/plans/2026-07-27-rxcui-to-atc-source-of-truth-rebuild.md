# RXCUI→ATC Source-of-Truth Rebuild — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a new, validated `RXCUI → ATC` table that replaces Navina's `rxcui to atc 26.7.26` production table, by re-running every RXCUI through the route-aware resolver + a WHO ground-truth cross-check, correcting what the data can adjudicate and explicitly flagging the irreducible remainder.

**Architecture:** Reuse the existing Node resolver harness (`scratch/audit-batch.js`, driven by env-var-overridable batch dirs) as the validation engine. Add thin glue: parse the new TSV, build validation batches, run the harness in resumable background batches, run a WHO-snapshot cross-check on changed rows, then reconcile three sources (production / our-prior-certified / resolver) into a final table under a "keep our value, flag on disagreement" policy. Emit a drop-in TSV plus validation/review/summary sidecars.

**Tech Stack:** Node ES modules (the resolver + harness are Node with `fetch`), Python 3 stdlib `csv` for parse/reconcile glue (both work in this sandbox; **Python `urllib` network is BLOCKED — never use it for RxNav; the Node harness uses `fetch`**). Zero new dependencies.

## Global Constraints

- Output RXCUI universe = production's 30,869 RXCUIs **∪** our 31 prior-only extras (~30,900 rows). No RXCUI dropped.
- Validation engine = `js/atc-resolver.js` via `scratch/audit-batch.js` (full Phase 2B–2I logic). Do **not** modify `js/*`.
- Policy on disagreement = **keep our value, flag** (no auto-flip), except: empty-in-production rows are filled when resolver+WHO give a confident code; known data-gaps are flagged as `FLAG_DATA_GAP`.
- WHO cross-check required on every new/disputed code (no knowledge-only verdicts).
- Safety valve: a row that has a non-empty mapping never becomes empty in the output without a FLAG.
- Primary deliverable serialization = production's exact schema: TSV, header `RXCUI\tATC`, ATC value = a JSON array string (CSV-quoted).
- All intermediate + final artifacts live under `reports/sot/`; new scripts under `scratch/sot/`.
- RxNav access is rate-limited (15 req/s) + 30-day cached inside the harness; the full run is ~2–3 hrs, resumable.

**Source references:** spec at `docs/superpowers/specs/2026-07-27-rxcui-to-atc-source-of-truth-rebuild-design.md`. Prior certified values: `reports/navina-unified-mapping-FINAL.csv` (cols `rxcui,drug_name,tty,navina_atcs,certified_atcs,source`). Production input: `navina current mapping/rxcui to atc 26.7.26.tsv` (cols `RXCUI`, `ATC` = multi-line JSON array, tab-delimited, standard CSV quoting). Harness `master-diff.csv` columns: `rxcui,drug_name,tty,navina_atcs,app_atcs,intersection,app_only,navina_only,verdict,who_correct,fix_target,pattern,confidence,app_status,provenance,strict_atcs,with_ingredients_atcs,remapped_to,explanation` (list fields pipe-joined). Harness `app_status` ∈ {KEEP, L4_ONLY, INGREDIENT_LEVEL, COMBINATION_NO_DEDICATED_CODE, RETIRED_RECOVERED, RETIRED_NO_REMAP, NO_ATC, ERROR}.

---

### Task 1: Parse the production table + build the RXCUI universe

**Files:**
- Create: `scratch/sot/parse-new-table.mjs`
- Read: `navina current mapping/rxcui to atc 26.7.26.tsv`, `reports/navina-unified-mapping-FINAL.csv`
- Write: `reports/sot/00-production-parsed.csv` (cols `rxcui,production_atcs` pipe-joined), `reports/sot/00-universe.csv` (cols `rxcui,in_production,has_prior`)

**Interfaces:**
- Produces: `reports/sot/00-production-parsed.csv` and `reports/sot/00-universe.csv`, consumed by Task 2.

- [ ] **Step 1: Write the parser script**

```js
// scratch/sot/parse-new-table.mjs — parse the production TSV (multi-line
// JSON-array ATC cells) into a flat rxcui->codes map, and compute the output
// universe (production ∪ prior-only extras).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PROD = path.join(REPO, "navina current mapping/rxcui to atc 26.7.26.tsv");
const PRIOR = path.join(REPO, "reports/navina-unified-mapping-FINAL.csv");
const OUT_DIR = path.join(REPO, "reports/sot");
fs.mkdirSync(OUT_DIR, { recursive: true });

// Minimal RFC-4180 CSV/TSV reader that handles quoted fields with embedded
// newlines and doubled quotes. Returns array of string[] rows.
function parseDelimited(text, delim) {
  const rows = []; let row = []; let field = ""; let i = 0; let inQ = false;
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === delim) { row.push(field); field = ""; i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}
const codesFromCell = (cell) => {
  const s = (cell || "").trim();
  if (!s || s === "[]") return [];
  try { const a = JSON.parse(s); return Array.isArray(a) ? a.map(x => String(x).trim()).filter(Boolean) : []; }
  catch { return (s.match(/[A-Z]\d{2}[A-Z]{2}\d{2}/g) || []); }
};

const prodRows = parseDelimited(fs.readFileSync(PROD, "utf8"), "\t");
const prodHeader = prodRows.shift(); // RXCUI, ATC
const production = new Map();
for (const r of prodRows) {
  if (!r.length) continue;
  const rx = (r[0] || "").trim();
  if (!/^\d+$/.test(rx)) continue;
  production.set(rx, codesFromCell(r[1]));
}

// prior certified rxcuis (for the "extras" = prior-only set)
const priorRows = parseDelimited(fs.readFileSync(PRIOR, "utf8"), ",");
const ph = priorRows.shift();
const priorIdx = { rxcui: ph.indexOf("rxcui"), cert: ph.indexOf("certified_atcs") };
const priorRx = new Set();
for (const r of priorRows) { const rx = (r[priorIdx.rxcui] || "").trim(); if (/^\d+$/.test(rx)) priorRx.add(rx); }

const universe = new Set([...production.keys(), ...priorRx]);

const prodOut = ["rxcui,production_atcs"];
for (const rx of production.keys()) prodOut.push(`${rx},${production.get(rx).join("|")}`);
fs.writeFileSync(path.join(OUT_DIR, "00-production-parsed.csv"), prodOut.join("\n") + "\n");

const uniOut = ["rxcui,in_production,has_prior"];
for (const rx of universe) uniOut.push(`${rx},${production.has(rx) ? 1 : 0},${priorRx.has(rx) ? 1 : 0}`);
fs.writeFileSync(path.join(OUT_DIR, "00-universe.csv"), uniOut.join("\n") + "\n");

const extras = [...priorRx].filter(rx => !production.has(rx));
console.log(`production rxcuis: ${production.size}`);
console.log(`prior-only extras: ${extras.length}`);
console.log(`output universe:   ${universe.size}`);
console.log(`empty-in-production: ${[...production.values()].filter(v => v.length === 0).length}`);
```

- [ ] **Step 2: Run it**

Run: `node scratch/sot/parse-new-table.mjs`
Expected output (approx): `production rxcuis: 30869`, `prior-only extras: 31`, `output universe: 30900`, and a non-zero `empty-in-production` count.

- [ ] **Step 3: Assert invariants**

Run: `wc -l reports/sot/00-production-parsed.csv reports/sot/00-universe.csv`
Expected: `00-production-parsed.csv` = 30870 lines (30869 + header); `00-universe.csv` = 30901 lines.
Run spot-check: `grep -E '^1797907,' reports/sot/00-production-parsed.csv`
Expected: contains `R01AD08` (production's fluticasone-nasal row parsed correctly, proving multi-line JSON parse works).

- [ ] **Step 4: Commit**

```bash
git add scratch/sot/parse-new-table.mjs reports/sot/00-production-parsed.csv reports/sot/00-universe.csv
git commit -m "SOT Task 1: parse production table + build output universe"
```

---

### Task 2: Build validation-input batches (production ∪ extras, Navina array format)

**Files:**
- Create: `scratch/sot/sot-setup.mjs`
- Read: `reports/sot/00-universe.csv`, `reports/sot/00-production-parsed.csv`, `reports/navina-unified-mapping-FINAL.csv`, existing warm caches
- Write: `skills/route-aware-atc-audit/batches-sot/batch-{1..N}.csv`, seed `skills/route-aware-atc-audit/audit-output-sot/cache.json`

**Interfaces:**
- Consumes: Task 1 outputs.
- Produces: N batch CSVs (header `RXCUI,ATC`, one row per rxcui, ATC as `"[""C10AA05""]"` array cell) that `audit-batch.js` reads via `AUDIT_BATCH_DIR`.

- [ ] **Step 1: Write the setup script** (adapted from `scratch/oos-setup.mjs`)

```js
// scratch/sot/sot-setup.mjs — build SOT validation batches for the full
// output universe. Seeds cache from the two warm prior caches so the run is
// mostly cache hits. Idempotent / resumable.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const UNI = path.join(REPO, "reports/sot/00-universe.csv");
const PRODP = path.join(REPO, "reports/sot/00-production-parsed.csv");
const PRIOR = path.join(REPO, "reports/navina-unified-mapping-FINAL.csv");
const BATCH_DIR = path.join(REPO, "skills/route-aware-atc-audit/batches-sot");
const OUT_ROOT  = path.join(REPO, "skills/route-aware-atc-audit/audit-output-sot");
const DX_CACHE  = path.join(REPO, "skills/route-aware-atc-audit/audit-output/cache.json");
const OOS_CACHE = path.join(REPO, "skills/route-aware-atc-audit/audit-output-oos/cache.json");
const SOT_CACHE = path.join(OUT_ROOT, "cache.json");
const NUM_BATCHES = parseInt(process.env.AUDIT_NUM_BATCHES || "12", 10);

const readCsv = (p) => fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map(l => l.split(","));
// production_atcs by rxcui (the batch "ATC" seed = what the harness diffs against)
const prod = new Map();
for (const [rx, atcs] of readCsv(PRODP).slice(1)) prod.set(rx, (atcs || "").split("|").filter(Boolean));
// prior certified by rxcui — used ONLY as the batch seed for prior-only extras
const priorLines = fs.readFileSync(PRIOR, "utf8").split("\n").filter(Boolean);
const ph = priorLines[0].split(","); const rxI = ph.indexOf("rxcui"); const certI = ph.indexOf("certified_atcs");
const prior = new Map();
for (let i = 1; i < priorLines.length; i++) {
  // certified_atcs may be pipe/comma/semicolon joined and possibly quoted; extract codes
  const cells = priorLines[i].match(/(".*?"|[^,]*)(,|$)/g) || [];
  const rx = (cells[rxI] || "").replace(/[",]/g, "").trim();
  const codes = (priorLines[i].match(/[A-Z]\d{2}[A-Z]{2}\d{2}/g) || []);
  if (/^\d+$/.test(rx)) prior.set(rx, codes);
}

const universe = readCsv(UNI).slice(1).map(([rx]) => rx).filter(rx => /^\d+$/.test(rx));
const arrayCell = (codes) => codes.length ? `"[` + codes.map(c => `""${c}""`).join(", ") + `]"` : `"[]"`;
fs.mkdirSync(BATCH_DIR, { recursive: true });
const buckets = Array.from({ length: NUM_BATCHES }, () => []);
for (const rx of universe) buckets[parseInt(rx, 10) % NUM_BATCHES].push(rx);
let total = 0;
for (let b = 0; b < NUM_BATCHES; b++) {
  const out = ["RXCUI,ATC"];
  for (const rx of buckets[b]) {
    const seed = prod.has(rx) ? prod.get(rx) : (prior.get(rx) || []);
    out.push(`${rx},${arrayCell(seed)}`);
  }
  fs.writeFileSync(path.join(BATCH_DIR, `batch-${b + 1}.csv`), out.join("\n") + "\n");
  total += buckets[b].length;
  console.log(`  batch-${b + 1}.csv  ${String(buckets[b].length).padStart(5)} records`);
}
console.log(`Total written: ${total} (universe ${universe.length})`);
if (total !== universe.length) { console.error("MISMATCH"); process.exit(1); }

fs.mkdirSync(OUT_ROOT, { recursive: true });
if (!fs.existsSync(SOT_CACHE)) {
  // merge both warm caches (dx first, oos overlays) into the SOT cache
  const merged = {};
  for (const p of [DX_CACHE, OOS_CACHE]) {
    if (fs.existsSync(p)) { try { Object.assign(merged, JSON.parse(fs.readFileSync(p, "utf8"))); } catch {} }
  }
  fs.writeFileSync(SOT_CACHE, JSON.stringify(merged));
  console.log(`Seeded SOT cache: ${Object.keys(merged).length} entries (${(fs.statSync(SOT_CACHE).size/1e6).toFixed(1)} MB)`);
} else {
  console.log("SOT cache already exists — leaving as-is (resumable).");
}
console.log("Setup complete.");
```

- [ ] **Step 2: Run it**

Run: `node scratch/sot/sot-setup.mjs`
Expected: 12 `batch-N.csv` lines printed; `Total written: 30900 (universe 30900)`; a "Seeded SOT cache" line with a large entry count.

- [ ] **Step 3: Assert invariants**

Run: `awk -F, 'FNR>1' skills/route-aware-atc-audit/batches-sot/batch-*.csv | wc -l`
Expected: `30900`.
Run: `head -3 skills/route-aware-atc-audit/batches-sot/batch-1.csv`
Expected: header `RXCUI,ATC` then rows like `617310,"[""C10AA05""]"` (array-cell format matches `audit-batch.js` input).

- [ ] **Step 4: Commit** (batch CSVs + cache are gitignored under the audit skill dir; commit only the script)

```bash
git add scratch/sot/sot-setup.mjs
git commit -m "SOT Task 2: build validation-input batches + seed warm cache"
```

---

### Task 3: Smoke-test the resolver on one batch (de-risk before the full run)

**Files:**
- Read/run: `scratch/audit-batch.js` (unchanged)
- Write: `skills/route-aware-atc-audit/audit-output-sot/batch-1/*`

**Interfaces:**
- Consumes: Task 2 batches + cache.
- Produces: `audit-output-sot/batch-1/master-diff.csv` (schema per Global Constraints), proving the harness runs against SOT inputs.

- [ ] **Step 1: Run one batch with SOT env overrides**

```bash
cd "/Users/Netanel.Greifner/medications mapping website"
AUDIT_BATCH_DIR="skills/route-aware-atc-audit/batches-sot" \
AUDIT_OUT_ROOT="skills/route-aware-atc-audit/audit-output-sot" \
AUDIT_CACHE_PATH="skills/route-aware-atc-audit/audit-output-sot/cache.json" \
node scratch/audit-batch.js 1
```
Expected: finishes without crashing; prints a `master-diff.csv (N rows)` line where N = batch-1 record count.

- [ ] **Step 2: Assert the output schema + a regression fixture**

Run: `head -1 skills/route-aware-atc-audit/audit-output-sot/batch-1/master-diff.csv`
Expected: the 19-column header from Global Constraints.
Run: `grep -E '^617310,' skills/route-aware-atc-audit/audit-output-sot/batch-1/master-diff.csv` (617310 % 12 + 1 == batch 1? if not, grep whichever batch it lands in — `617310 % 12 = 10` → batch-11; run batch 11 instead for this check, or grep across the batch it maps to).
Expected: `app_atcs`/`strict_atcs` column contains `C10AA05` (atorvastatin regression fixture resolves correctly).

> Note: RXCUI→batch mapping is `rxcui % 12 + 1`. For fixture checks, compute the batch first (e.g. `node -e 'console.log(617310%12+1)'`).

- [ ] **Step 3: Commit** (nothing new to commit unless the smoke test revealed a needed script tweak; if clean, skip). Otherwise:

```bash
git add -A scratch/sot
git commit -m "SOT Task 3: smoke-test harness on SOT batch (no code change)" --allow-empty
```

---

### Task 4: Full resolver run across all batches (background, resumable)

**Files:**
- Create: `scratch/sot/sot-run.sh` (driver, adapted from `scratch/oos-run.sh`)
- Read/run: `scratch/audit-batch.js`, `scratch/combine-batches.js`
- Write: `skills/route-aware-atc-audit/audit-output-sot/batch-{1..12}/*` + combined output + `progress.log`

**Interfaces:**
- Consumes: Task 2 batches + cache.
- Produces: per-batch `master-diff.csv` for all 12 batches; a combined `audit-output-sot/master-diff.csv` (via `combine-batches.js` if it supports env overrides, else a concat step in this script).

- [ ] **Step 1: Write the driver**

```bash
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
```

- [ ] **Step 2: Launch in background**

Run (via the Bash tool with `run_in_background: true`):
```bash
zsh scratch/sot/sot-run.sh
```
Then poll `skills/route-aware-atc-audit/audit-output-sot/progress.log` for `===== ALL BATCHES DONE`.

- [ ] **Step 3: Assert completion invariant**

Run: `awk -F, 'FNR>1' skills/route-aware-atc-audit/audit-output-sot/master-diff.csv | wc -l`
Expected: `30900` (one row per universe RXCUI).
Run: `grep -c 'ERROR' skills/route-aware-atc-audit/audit-output-sot/master-diff.csv`
Expected: small/zero; investigate any `app_status=ERROR` rows (transient RxNav failures → re-run that batch by deleting its `master-diff.csv` and re-invoking `sot-run.sh`, which is resumable).

- [ ] **Step 4: Commit the driver**

```bash
git add scratch/sot/sot-run.sh
git commit -m "SOT Task 4: full resolver run driver (background, resumable)"
```

---

### Task 5: WHO ground-truth cross-check on changed rows

**Files:**
- Create: `scratch/sot/who-crosscheck.mjs`
- Read: `skills/route-aware-atc-audit/audit-output-sot/master-diff.csv`, `data/who-atc-snapshots/*.json`, `js/who-atc-snapshots-bundle.js`
- Write: `reports/sot/01-who-check.csv` (cols `rxcui,who_check,who_note`)

**Interfaces:**
- Consumes: Task 4 combined `master-diff.csv`.
- Produces: `reports/sot/01-who-check.csv`; `who_check` ∈ {`CONFIRMED`, `UNCONFIRMED`, `GAP`}, one row per RXCUI where the resolver's `app_atcs` differ from `navina_atcs` (the changed rows). Consumed by Task 6.

- [ ] **Step 1: Write the cross-check**

```js
// scratch/sot/who-crosscheck.mjs — for each CHANGED row, verify the resolver's
// codes against the committed WHO ATC snapshots. A code is CONFIRMED when its
// L4 exists in the snapshot set AND the exact L5 appears among that L4's WHO
// entries; UNCONFIRMED when we have no snapshot for its L4 (not disproven, just
// not independently WHO-verified); GAP when the resolver itself reported a
// data-gap status (L4_ONLY / COMBINATION_NO_DEDICATED_CODE / RETIRED_NO_REMAP).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MD = path.join(REPO, "skills/route-aware-atc-audit/audit-output-sot/master-diff.csv");
const SNAP_DIR = path.join(REPO, "data/who-atc-snapshots");
const OUT = path.join(REPO, "reports/sot/01-who-check.csv");

// Build the set of WHO L5 codes we have snapshots for, keyed by L4 (5 chars).
const whoL5 = new Set(); const whoL4 = new Set();
if (fs.existsSync(SNAP_DIR)) {
  for (const f of fs.readdirSync(SNAP_DIR)) {
    if (!f.endsWith(".json") || f.startsWith("_")) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(SNAP_DIR, f), "utf8"));
      const l4 = f.replace(/\.json$/, ""); whoL4.add(l4);
      const entries = j.entries || j.l5 || j.codes || (Array.isArray(j) ? j : []);
      for (const e of entries) {
        const code = (e.code || e.atc || e).toString();
        if (/^[A-Z]\d{2}[A-Z]{2}\d{2}$/.test(code)) whoL5.add(code);
      }
    } catch {}
  }
}

// CSV reader (fields may be quoted; list fields pipe-joined, no embedded commas).
const rows = fs.readFileSync(MD, "utf8").split("\n").filter(Boolean).map(l => {
  const out = []; let f = ""; let q = false;
  for (let i = 0; i < l.length; i++) { const c = l[i];
    if (q) { if (c === '"') { if (l[i+1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true; else if (c === ",") { out.push(f); f = ""; } else f += c; }
  out.push(f); return out;
});
const H = rows.shift();
const ix = (n) => H.indexOf(n);
const GAP_STATUS = new Set(["L4_ONLY", "COMBINATION_NO_DEDICATED_CODE", "RETIRED_NO_REMAP", "NO_ATC"]);

const out = ["rxcui,who_check,who_note"];
for (const r of rows) {
  const rx = r[ix("rxcui")];
  const navina = (r[ix("navina_atcs")] || "").split("|").filter(Boolean).sort().join("|");
  const app = (r[ix("app_atcs")] || "").split("|").filter(Boolean);
  const appKey = app.slice().sort().join("|");
  if (navina === appKey) continue; // unchanged — not in the cross-check set
  const status = r[ix("app_status")] || "";
  let check, note;
  if (GAP_STATUS.has(status)) { check = "GAP"; note = `resolver status ${status}`; }
  else {
    const l5 = app.filter(c => /^[A-Z]\d{2}[A-Z]{2}\d{2}$/.test(c));
    if (!l5.length) { check = "GAP"; note = "no L5 codes"; }
    else if (l5.every(c => whoL5.has(c))) { check = "CONFIRMED"; note = "all L5 in WHO snapshot"; }
    else if (l5.some(c => whoL4.has(c.slice(0, 5)))) { check = "CONFIRMED"; note = "L4 in WHO snapshot"; }
    else { check = "UNCONFIRMED"; note = "no WHO snapshot for these L4s"; }
  }
  out.push(`${rx},${check},"${note}"`);
}
fs.writeFileSync(OUT, out.join("\n") + "\n");
const counts = out.slice(1).reduce((m, l) => { const k = l.split(",")[1]; m[k] = (m[k]||0)+1; return m; }, {});
console.log("who-check counts:", counts, "rows:", out.length - 1);
```

- [ ] **Step 2: Run it**

Run: `node scratch/sot/who-crosscheck.mjs`
Expected: prints `who-check counts: { CONFIRMED: …, UNCONFIRMED: …, GAP: … } rows: N`, where N = number of changed rows.

- [ ] **Step 3: Assert**

Run: `wc -l reports/sot/01-who-check.csv`
Expected: header + one row per changed RXCUI (N+1). Cross-check N against `awk -F, 'FNR>1{split($4,a,"|");split($5,b,"|"); ...}'` count of changed rows — or simply confirm N > 0 and ≤ 30900.

- [ ] **Step 4: Commit**

```bash
git add scratch/sot/who-crosscheck.mjs reports/sot/01-who-check.csv
git commit -m "SOT Task 5: WHO snapshot cross-check on changed rows"
```

---

### Task 6: Reconcile → verdicts + final table, emit deliverables

**Files:**
- Create: `scratch/sot/reconcile.mjs`
- Read: `reports/sot/00-production-parsed.csv`, `reports/navina-unified-mapping-FINAL.csv`, `skills/route-aware-atc-audit/audit-output-sot/master-diff.csv`, `reports/sot/01-who-check.csv`
- Write: `reports/sot/rxcui-to-atc-SOT-validation.csv`, `reports/sot/rxcui-to-atc-SOT-review.csv`, `reports/sot/rxcui-to-atc-SOT.tsv`, `reports/sot/SOT-summary.md`

**Interfaces:**
- Consumes: Tasks 1, 4, 5 outputs + prior certified.
- Produces: the four final deliverables. Verdict ∈ {`CORRECT`, `CORRECTED`, `CORRECTED_FROM_EMPTY`, `FLAG_DATA_GAP`, `FLAG_REVIEW`}. `final_atcs` chosen per policy below.

**Reconcile policy (per RXCUI):**
- `baseline` = `our_prior_atcs` if the RXCUI has a prior certified value, else `production_atcs`. ("our value")
- `resolver` = `app_atcs` from master-diff; `who` = `who_check` (default `CONFIRMED` for unchanged rows, since resolver == production).
- If `resolver`(set) == `baseline`(set) → **CORRECT**, `final = baseline`.
- Else (disagreement):
  - if `who == GAP` OR `app_status` ∈ {L4_ONLY, COMBINATION_NO_DEDICATED_CODE, RETIRED_NO_REMAP, NO_ATC} → **FLAG_DATA_GAP**, `final = baseline`.
  - else if `baseline` is empty AND `resolver` non-empty AND `who == CONFIRMED` → **CORRECTED_FROM_EMPTY**, `final = resolver`.
  - else → **FLAG_REVIEW**, `final = baseline` (keep our value; record resolver alternative + who in review).
- Safety valve: if `final` empty but `production_atcs` non-empty → `final = production_atcs` and force verdict into a FLAG bucket.

- [ ] **Step 1: Write the reconcile script**

```js
// scratch/sot/reconcile.mjs — join production / prior / resolver / who-check,
// apply the keep-our-value-flag policy, emit the four SOT deliverables.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const R = (p) => path.join(REPO, p);
const readLines = (p) => fs.readFileSync(p, "utf8").split("\n").filter(Boolean);

// ---- production_atcs ----
const prod = new Map();
for (const l of readLines(R("reports/sot/00-production-parsed.csv")).slice(1)) {
  const c = l.indexOf(","); const rx = l.slice(0, c); prod.set(rx, l.slice(c + 1).split("|").filter(Boolean));
}
// ---- prior certified (drug_name, tty, certified) ----
const prior = new Map();
{
  const lines = readLines(R("reports/navina-unified-mapping-FINAL.csv"));
  const h = lines[0].split(","); const rxI = h.indexOf("rxcui"), nmI = h.indexOf("drug_name"), ttyI = h.indexOf("tty");
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",");
    const rx = cells[rxI]; if (!/^\d+$/.test(rx)) continue;
    const codes = lines[i].match(/[A-Z]\d{2}[A-Z]{2}\d{2}/g) || [];
    prior.set(rx, { name: cells[nmI] || "", tty: cells[ttyI] || "", codes });
  }
}
// ---- master-diff (resolver) ----
function parseCsvLine(l) { const out=[];let f="";let q=false;
  for(let i=0;i<l.length;i++){const c=l[i];
    if(q){if(c==='"'){if(l[i+1]==='"'){f+='"';i++;}else q=false;}else f+=c;}
    else if(c==='"')q=true;else if(c===","){out.push(f);f="";}else f+=c;}
  out.push(f);return out; }
const md = new Map();
{
  const lines = readLines(R("skills/route-aware-atc-audit/audit-output-sot/master-diff.csv"));
  const H = parseCsvLine(lines[0]); const ix=(n)=>H.indexOf(n);
  for (let i = 1; i < lines.length; i++) {
    const r = parseCsvLine(lines[i]); const rx = r[ix("rxcui")];
    md.set(rx, {
      name: r[ix("drug_name")]||"", tty: r[ix("tty")]||"",
      app: (r[ix("app_atcs")]||"").split("|").filter(Boolean),
      status: r[ix("app_status")]||"", explanation: r[ix("explanation")]||"",
    });
  }
}
// ---- who-check ----
const who = new Map();
for (const l of readLines(R("reports/sot/01-who-check.csv")).slice(1)) {
  const r = parseCsvLine(l); who.set(r[0], r[1]);
}

const GAP = new Set(["L4_ONLY","COMBINATION_NO_DEDICATED_CODE","RETIRED_NO_REMAP","NO_ATC"]);
const setEq = (a,b) => { const A=new Set(a),B=new Set(b); if(A.size!==B.size)return false; for(const x of A)if(!B.has(x))return false; return true; };
const arrCell = (codes)=> codes.length ? `[` + codes.map(c=>`"${c}"`).join(", ") + `]` : `[]`;
const tsvCell = (s)=> `"${String(s).replace(/"/g,'""')}"`;
const csvCell = (s)=>{ s=String(s??""); return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s; };

const universe = new Set([...prod.keys(), ...prior.keys()]);
const val = ["rxcui,drug_name,tty,production_atcs,our_prior_atcs,resolver_atcs,who_check,verdict,final_atcs,source"];
const review = ["rxcui,drug_name,tty,production_atcs,our_prior_atcs,resolver_atcs,who_check,verdict,final_atcs,reason"];
const sot = [];
const counts = {};
for (const rx of universe) {
  const p = prod.get(rx) || [];
  const pr = prior.get(rx);
  const m = md.get(rx) || { app: [], status: "MISSING", name: pr?.name||"", tty: pr?.tty||"" };
  const name = m.name || pr?.name || ""; const tty = m.tty || pr?.tty || "";
  const baseline = pr ? pr.codes : p;
  const resolver = m.app;
  const w = who.get(rx) || "CONFIRMED";
  let verdict, final, reason = "";
  if (setEq(resolver, baseline)) { verdict = "CORRECT"; final = baseline; }
  else if (w === "GAP" || GAP.has(m.status)) { verdict = "FLAG_DATA_GAP"; final = baseline; reason = `data gap (${m.status||w})`; }
  else if (baseline.length === 0 && resolver.length && w === "CONFIRMED") { verdict = "CORRECTED_FROM_EMPTY"; final = resolver; }
  else { verdict = "FLAG_REVIEW"; final = baseline; reason = `resolver disagrees (${resolver.join("|")||"∅"}); who=${w}`; }
  // safety valve
  if (final.length === 0 && p.length > 0) { final = p; if (!verdict.startsWith("FLAG")) { verdict = "FLAG_REVIEW"; reason = "safety valve: kept production to avoid emptying"; } }
  counts[verdict] = (counts[verdict]||0) + 1;
  const src = pr ? pr.tty && !prod.has(rx) ? "extra" : "prior" : "gap-resolved";
  const row = [rx, name, tty, p.join("|"), baseline.join("|"), resolver.join("|"), w, verdict, final.join("|"), src].map(csvCell).join(",");
  val.push(row);
  if (verdict.startsWith("FLAG")) review.push([rx, name, tty, p.join("|"), baseline.join("|"), resolver.join("|"), w, verdict, final.join("|"), reason].map(csvCell).join(","));
  sot.push(`${rx}\t${tsvCell(arrCell(final))}`);
}
fs.writeFileSync(R("reports/sot/rxcui-to-atc-SOT-validation.csv"), val.join("\n") + "\n");
fs.writeFileSync(R("reports/sot/rxcui-to-atc-SOT-review.csv"), review.join("\n") + "\n");
fs.writeFileSync(R("reports/sot/rxcui-to-atc-SOT.tsv"), "RXCUI\tATC\n" + sot.join("\n") + "\n");

const total = universe.size;
let md2 = `# SOT Rebuild — Summary\n\nGenerated ${new Date().toISOString().slice(0,10)}\n\n`;
md2 += `- Output rows (universe): **${total}**\n`;
for (const k of ["CORRECT","CORRECTED","CORRECTED_FROM_EMPTY","FLAG_DATA_GAP","FLAG_REVIEW"]) md2 += `- ${k}: **${counts[k]||0}**\n`;
const changed = (counts.CORRECTED||0)+(counts.CORRECTED_FROM_EMPTY||0);
md2 += `\n**Corrected total (value differs from production): ${changed}. Flagged for review: ${(counts.FLAG_DATA_GAP||0)+(counts.FLAG_REVIEW||0)}.**\n`;
md2 += `\nReconciliation check: ${["CORRECT","CORRECTED","CORRECTED_FROM_EMPTY","FLAG_DATA_GAP","FLAG_REVIEW"].reduce((s,k)=>s+(counts[k]||0),0)} == ${total} ? ${["CORRECT","CORRECTED","CORRECTED_FROM_EMPTY","FLAG_DATA_GAP","FLAG_REVIEW"].reduce((s,k)=>s+(counts[k]||0),0)===total}\n`;
fs.writeFileSync(R("reports/sot/SOT-summary.md"), md2);
console.log("verdict counts:", counts, "total:", total);
```

- [ ] **Step 2: Run it**

Run: `node scratch/sot/reconcile.mjs`
Expected: prints `verdict counts: {...} total: 30900`; the five verdict counts sum to 30900.

- [ ] **Step 3: Assert deliverable invariants**

Run: `awk -F'\t' 'FNR>1' reports/sot/rxcui-to-atc-SOT.tsv | wc -l` → Expected `30900`.
Run: `head -3 reports/sot/rxcui-to-atc-SOT.tsv` → Expected header `RXCUI\tATC` then rows like `103\t"[""L01BB02""]"`.
Run: `tail -n +2 reports/sot/SOT-summary.md` → confirm the reconciliation check line says `true`.

- [ ] **Step 4: Commit**

```bash
git add scratch/sot/reconcile.mjs reports/sot/rxcui-to-atc-SOT-validation.csv reports/sot/rxcui-to-atc-SOT-review.csv reports/sot/rxcui-to-atc-SOT.tsv reports/sot/SOT-summary.md
git commit -m "SOT Task 6: reconcile to policy + emit SOT table, validation, review, summary"
```

---

### Task 7: Acceptance + regression gate

**Files:**
- Create: `scratch/sot/verify-acceptance.mjs`
- Read: the four deliverables + `reports/sot/00-production-parsed.csv`

**Interfaces:**
- Consumes: Task 6 deliverables.
- Produces: a pass/fail report on every spec §9 acceptance criterion + §7 regression fixtures. Exits non-zero on any failure.

- [ ] **Step 1: Write the gate**

```js
// scratch/sot/verify-acceptance.mjs — assert spec §9 acceptance + §7 regression.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const R = (p)=>path.join(REPO,p);
const lines = (p)=>fs.readFileSync(R(p),"utf8").split("\n").filter(Boolean);
let fails = 0; const ok=(c,m)=>{ console.log(`${c?"PASS":"FAIL"}  ${m}`); if(!c)fails++; };

// universe coverage
const prod = new Set(lines("reports/sot/00-production-parsed.csv").slice(1).map(l=>l.slice(0,l.indexOf(","))));
const sot = lines("reports/sot/rxcui-to-atc-SOT.tsv").slice(1);
const sotRx = new Set(sot.map(l=>l.slice(0,l.indexOf("\t"))));
ok([...prod].every(rx=>sotRx.has(rx)), "every production RXCUI present in SOT.tsv");
ok(sotRx.size >= 30869, `SOT covers >= 30869 rxcuis (got ${sotRx.size})`);

// safety valve: no non-empty production -> empty SOT without a FLAG
const val = lines("reports/sot/rxcui-to-atc-SOT-validation.csv"); const H = val[0].split(",");
const iv = (n)=>H.indexOf(n);
let svViolations = 0;
for (const l of val.slice(1)) {
  const c = l.split(","); // list fields have no embedded commas (pipe-joined)
  const p = c[iv("production_atcs")]||""; const f = c[iv("final_atcs")]||""; const v = c[iv("verdict")]||"";
  if (p.trim() && !f.trim() && !v.startsWith("FLAG")) svViolations++;
}
ok(svViolations === 0, `safety valve: ${svViolations} non-empty→empty without FLAG`);

// regression fixtures (expected code must appear in final_atcs)
const finalByRx = new Map();
for (const l of val.slice(1)) { const c=l.split(","); finalByRx.set(c[iv("rxcui")], c[iv("final_atcs")]||""); }
const fixtures = [["1797907","R01AD08"],["617310","C10AA05"],["2702393","S01ED01"],["151399","J01EE01"],["1544396","L04AX03"]];
for (const [rx,code] of fixtures) {
  const f = finalByRx.get(rx);
  ok(f !== undefined && f.split("|").includes(code), `fixture ${rx} -> ${code} (got ${f})`);
}

// reconciliation total
ok(sot.length === sotRx.size, "no duplicate rxcuis in SOT.tsv");

console.log(fails === 0 ? "\nALL ACCEPTANCE CHECKS PASS" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
```

- [ ] **Step 2: Run the gate**

Run: `node scratch/sot/verify-acceptance.mjs`
Expected: all lines `PASS`, final line `ALL ACCEPTANCE CHECKS PASS`, exit 0.

> If a fixture fails, it means the resolver's answer for that RXCUI didn't reach the final table under the policy (likely landed in a FLAG bucket). Inspect that RXCUI in `rxcui-to-atc-SOT-validation.csv`, decide whether it's a genuine data-gap (leave flagged, note in summary) or a reconcile bug (fix `reconcile.mjs`), then re-run Tasks 6–7.

- [ ] **Step 3: Commit**

```bash
git add scratch/sot/verify-acceptance.mjs
git commit -m "SOT Task 7: acceptance + regression gate"
```

---

## Self-Review (completed by author)

- **Spec coverage:** §4 inputs → Task 1/2; §5 validation tool → Task 3/4; §6 algorithm → Task 4 (resolve) + Task 6 (reconcile); §6 WHO cross-check → Task 5; §7 guardrails (safety valve, fixtures, general mechanisms) → Task 6 + Task 7; §8 deliverables (4 files) → Task 6; §9 acceptance → Task 7; §10 known limitations → surfaced via FLAG_DATA_GAP in Task 6 + review CSV. All covered.
- **Placeholder scan:** no TBD/TODO; every code step has complete, runnable code.
- **Type consistency:** verdict vocabulary {CORRECT, CORRECTED, CORRECTED_FROM_EMPTY, FLAG_DATA_GAP, FLAG_REVIEW} used identically in Task 6 and Task 7; column names (`production_atcs`, `our_prior_atcs`, `resolver_atcs`, `who_check`, `final_atcs`) consistent across validation CSV, reconcile, and gate; harness `master-diff.csv` columns match Global Constraints.
- **Known risk flagged in-plan:** WHO snapshot coverage is a subset of WHO's full catalog, so `UNCONFIRMED` ≠ wrong — it means "not independently snapshot-verified." These stay at our value and are visible in the validation CSV; only genuine gaps/disagreements go to the review file.
