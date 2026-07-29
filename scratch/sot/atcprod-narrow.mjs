// scratch/sot/atcprod-narrow.mjs — Phase 2 of the RXCUI→ATC SOT fix project:
// ATCPROD-based re-resolution pass.
//
// For every rxcui in the fix worklist (excluding A5-ingredient-skip rows),
// fetch NLM's authoritative product-level ATCPROD Level-4 classes and, when
// present, promote to Level 5 via the tested `resolveLevel5FromClassMembers`
// mechanism — the same code path atc-resolver.js's Strategy 1 uses in the
// live app. ATCPROD coverage (~50% of rows) is route-pre-filtered by NLM, so
// wherever it has data it is the authoritative answer, independent of
// whatever the current production/app mapping says.
//
// Usage:
//   node scratch/sot/atcprod-narrow.mjs           # full worklist run (resumable)
//   node scratch/sot/atcprod-narrow.mjs --test    # 5-rxcui smoke test, prints only
//
// Output (full run only): reports/sot/fix/01-atcprod-candidates.csv
//   columns: rxcui, atcprod_l4s (pipe-joined), candidate_l5 (pipe-joined), coverage
//
// Resumable: on restart, rxcuis already present in the output file are
// skipped, and processing continues appending to the same file.
//
// Shares the warm SOT cache at
// skills/route-aware-atc-audit/audit-output-sot/cache.json (same shim
// pattern as scratch/audit-batch.js) so most fetches are cache hits; new
// entries are saved back periodically and at the end of the run.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../..");

// Env overrides let a parallel chunk-runner give each chunk its own input
// slice, own output file, own cache copy, and own log, so N chunk processes
// can run concurrently without racing on shared files. Defaults preserve
// the single-process, whole-worklist behavior.
const WORKLIST_PATH = process.env.ATCPROD_WORKLIST   || path.join(REPO_ROOT, "reports/sot/fix/00-fix-worklist.csv");
const OUTPUT_PATH   = process.env.ATCPROD_OUTPUT     || path.join(REPO_ROOT, "reports/sot/fix/01-atcprod-candidates.csv");
const CACHE_PATH    = process.env.ATCPROD_CACHE_PATH || path.join(REPO_ROOT, "skills/route-aware-atc-audit/audit-output-sot/cache.json");
const LOG_PATH      = process.env.ATCPROD_LOG_PATH   || path.join(REPO_ROOT, "scratch/sot/atcprod-narrow.log");
const SKIP_BUCKET   = "A5-ingredient-skip";

const TEST_MODE = process.argv.includes("--test");
const CONCURRENCY = parseInt(process.env.ATCPROD_CONCURRENCY || "20", 10);
const CACHE_SAVE_EVERY = 250;

// ---------------- Persistent localStorage shim (pattern from scratch/audit-batch.js) ----
const memStore = new Map();
if (fs.existsSync(CACHE_PATH)) {
  try {
    const cached = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    for (const [k, v] of Object.entries(cached)) memStore.set(k, v);
    process.stdout.write(`Loaded shared cache: ${memStore.size} keys\n`);
  } catch (e) {
    process.stdout.write(`Cache load failed (${e.message}); starting cold\n`);
  }
}
globalThis.localStorage = {
  getItem: (k) => (memStore.has(k) ? memStore.get(k) : null),
  setItem: (k, v) => { memStore.set(k, String(v)); },
  removeItem: (k) => memStore.delete(k),
  clear: () => memStore.clear(),
  key: (i) => [...memStore.keys()][i] ?? null,
  get length() { return memStore.size; },
};

function saveCache() {
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(Object.fromEntries(memStore)));
  } catch (e) {
    process.stdout.write(`Cache save failed: ${e.message}\n`);
  }
}

// ---------------- Redirect resolver console chatter to a log file ----------------
fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
const logStream = fs.createWriteStream(LOG_PATH, { flags: "a" });
const stringify = (a) => (typeof a === "string" ? a : JSON.stringify(a));
const logWrite = (level, args) =>
  logStream.write(`[${new Date().toISOString()}] [${level}] ${args.map(stringify).join(" ")}\n`);
console.log = (...a) => logWrite("log", a);
console.warn = (...a) => logWrite("warn", a);
console.error = (...a) => logWrite("error", a);
console.info = (...a) => logWrite("info", a);
console.debug = (...a) => logWrite("debug", a);

const print = (...args) => process.stdout.write(args.join(" ") + "\n");

// ---------------- Tested promotion + client helpers ----------------
const { resolveLevel5FromClassMembers } = await import("../../js/atc-resolver.js");
const { getAtcprodClasses } = await import("../../js/rxnav-client.js");

// ---------------- CSV parsing (RFC4180-lite: quoted fields, "" escaping) ----------------
function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else {
        cur += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { out.push(cur); cur = ""; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

function parseWorklist(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").split("\n");
  const lines = raw.filter((l, idx) => idx === 0 || l.trim().length > 0);
  const header = parseCsvLine(lines[0]);
  const colIdx = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    if (cols.length < header.length) continue;
    records.push({
      rxcui: (cols[colIdx.rxcui] || "").trim(),
      drugName: cols[colIdx.drug_name] || "",
      tty: cols[colIdx.tty] || "",
      bucket: (cols[colIdx.bucket] || "").trim(),
    });
  }
  return records;
}

// ---------------- core per-rxcui logic ----------------
async function resolveOne(rxcui) {
  let atcprodClasses = [];
  try {
    atcprodClasses = await getAtcprodClasses(rxcui);
  } catch (e) {
    console.error(`getAtcprodClasses failed for ${rxcui}: ${e && e.message}`);
    return { rxcui, atcprodL4s: [], candidateL5: [], coverage: "MISS", error: true };
  }
  const l4Ids = [...new Set((atcprodClasses || []).map((c) => c && c.classId).filter(Boolean))];
  if (l4Ids.length === 0) {
    return { rxcui, atcprodL4s: [], candidateL5: [], coverage: "MISS", error: false };
  }
  let promoted = null;
  try {
    promoted = await resolveLevel5FromClassMembers(rxcui, l4Ids);
  } catch (e) {
    console.error(`resolveLevel5FromClassMembers threw for ${rxcui}: ${e && e.stack || e}`);
    return { rxcui, atcprodL4s: l4Ids, candidateL5: [], coverage: "COVERED", error: true };
  }
  const candidateL5 = [...new Set(
    (promoted || [])
      .map((c) => c && c.code)
      .filter((code) => typeof code === "string" && code.length === 7)
  )];
  return { rxcui, atcprodL4s: l4Ids, candidateL5, coverage: "COVERED", error: false };
}

// ---------------- concurrency-limited worker pool ----------------
async function runPool(items, limit, worker) {
  let cursor = 0;
  let completed = 0;
  const total = items.length;
  const t0 = Date.now();

  async function workerLoop() {
    for (;;) {
      const i = cursor++;
      if (i >= total) return;
      try {
        await worker(items[i]);
      } catch (e) {
        console.error(`Unhandled worker error for ${items[i]}: ${e && e.stack || e}`);
      }
      completed++;
      if (completed % CACHE_SAVE_EVERY === 0) saveCache();
      if (completed % 25 === 0 || completed === total) {
        const elapsed = (Date.now() - t0) / 1000;
        const rate = completed / elapsed;
        const eta = (total - completed) / Math.max(rate, 0.001);
        process.stdout.write(
          `\r[${String(completed).padStart(5)}/${total}] ${rate.toFixed(1)} rxcui/s  ` +
          `ETA ${(eta / 60).toFixed(1)}m  covered=${tally.COVERED} miss=${tally.MISS} errors=${tally.errors}      `
        );
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, total) }, () => workerLoop());
  await Promise.all(workers);
  process.stdout.write("\n");
}

const tally = { COVERED: 0, MISS: 0, errors: 0 };

// ============================================================
// TEST MODE — 5 fixed rxcuis, prints only, no file output.
// ============================================================
if (TEST_MODE) {
  const cases = [
    { rxcui: "617310",  expectCoverage: "COVERED", expectL5Includes: "C10AA05" },
    { rxcui: "1797907", expectCoverage: "MISS",    expectL5Includes: null },
    { rxcui: "211598",  expectCoverage: "MISS",    expectL5Includes: null },
    { rxcui: "1660018", expectCoverage: "MISS",    expectL5Includes: null },
    { rxcui: "545871",  expectCoverage: "MISS",    expectL5Includes: null },
  ];

  print(`\n=== TEST MODE: ${cases.length} rxcuis ===\n`);
  let allPass = true;
  const results = [];
  for (const c of cases) {
    const r = await resolveOne(c.rxcui);
    let pass = r.coverage === c.expectCoverage;
    if (c.expectL5Includes) pass = pass && r.candidateL5.includes(c.expectL5Includes);
    if (c.expectCoverage === "MISS") pass = pass && r.candidateL5.length === 0;
    if (!pass) allPass = false;
    results.push({ ...r, expect: c, pass });
    print(
      `rxcui=${r.rxcui.padEnd(9)} coverage=${r.coverage.padEnd(8)} ` +
      `atcprod_l4s=[${r.atcprodL4s.join("|")}]`.padEnd(28) +
      ` candidate_l5=[${r.candidateL5.join("|")}]`.padEnd(28) +
      ` error=${r.error}  => ${pass ? "PASS" : "FAIL"} (expected coverage=${c.expectCoverage}` +
      (c.expectL5Includes ? `, candidate includes ${c.expectL5Includes}` : "") + ")"
    );
  }
  saveCache();
  print(`\n${allPass ? "ALL TESTS PASSED" : "TEST FAILURE — BLOCKED"}\n`);
  if (!allPass) {
    print("STATUS: BLOCKED");
    process.exit(1);
  }
  print("STATUS: TEST_OK — proceeding is safe.");
  process.exit(0);
}

// ============================================================
// FULL RUN — resumable, incremental output.
// ============================================================
print(`\n=== ATCPROD narrowing — full worklist run ===`);
print(`Input:  ${path.relative(REPO_ROOT, WORKLIST_PATH)}`);
print(`Output: ${path.relative(REPO_ROOT, OUTPUT_PATH)}\n`);

const allRecords = parseWorklist(WORKLIST_PATH);
const eligible = allRecords.filter((r) => r.bucket !== SKIP_BUCKET && r.rxcui);
print(`Worklist: ${allRecords.length} total, ${eligible.length} eligible (excluding ${SKIP_BUCKET}).`);

// Resumability: collect rxcuis already present in the output file.
const done = new Set();
fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
const HEADER = "rxcui,atcprod_l4s,candidate_l5,coverage";
if (fs.existsSync(OUTPUT_PATH)) {
  const existingLines = fs.readFileSync(OUTPUT_PATH, "utf8").split("\n").filter(Boolean);
  for (let i = 1; i < existingLines.length; i++) {
    const rxcui = existingLines[i].split(",")[0];
    if (rxcui) done.add(rxcui);
  }
  print(`Resuming: ${done.size} rxcuis already in output file, will be skipped.`);
} else {
  fs.writeFileSync(OUTPUT_PATH, HEADER + "\n");
}

const remaining = eligible.filter((r) => !done.has(r.rxcui));
print(`Remaining to process: ${remaining.length}\n`);

if (remaining.length === 0) {
  print("Nothing to do — all eligible rxcuis already present in output.");
  process.exit(0);
}

const outStream = fs.createWriteStream(OUTPUT_PATH, { flags: "a" });

async function processAndWrite(record) {
  const r = await resolveOne(record.rxcui);
  tally[r.coverage] = (tally[r.coverage] || 0) + 1;
  if (r.error) tally.errors++;
  const line = [r.rxcui, r.atcprodL4s.join("|"), r.candidateL5.join("|"), r.coverage].join(",");
  outStream.write(line + "\n");
}

await runPool(remaining, CONCURRENCY, processAndWrite);

await new Promise((resolve) => outStream.end(resolve));
saveCache();

print(`\nDone. Processed ${remaining.length} rxcuis this run.`);
print(`Coverage this run: COVERED=${tally.COVERED} MISS=${tally.MISS} errors=${tally.errors}`);
print(`Output: ${path.relative(REPO_ROOT, OUTPUT_PATH)} (${done.size + remaining.length} total rxcuis).`);
logStream.end();
