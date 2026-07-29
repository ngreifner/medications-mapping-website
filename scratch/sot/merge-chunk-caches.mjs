// scratch/sot/merge-chunk-caches.mjs — fold each parallel chunk's cache
// (which started as a copy of the shared warm cache and accumulated new
// entries during its own chunk's run) back into the shared cache at
// skills/route-aware-atc-audit/audit-output-sot/cache.json, so future runs
// benefit from everything all chunks fetched. Safe to re-run.
//
// Usage: node scratch/sot/merge-chunk-caches.mjs [numChunks]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SEED = path.join(REPO_ROOT, "skills/route-aware-atc-audit/audit-output-sot/cache.json");
const CHUNK_DIR = path.join(REPO_ROOT, "scratch/sot/chunks");
const N = parseInt(process.argv[2] || "10", 10);

function loadOuter(p) {
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return {}; }
}

// outer shape: { "medcode_cache_rxcui_v1": "<json string>", "medcode_cache_atc_v1": "<json string>" }
const merged = loadOuter(SEED);
const mergedInner = {};
for (const [k, v] of Object.entries(merged)) {
  try { mergedInner[k] = JSON.parse(v); } catch { mergedInner[k] = {}; }
}

let chunksMerged = 0;
for (let c = 1; c <= N; c++) {
  const pad = String(c).padStart(2, "0");
  const chunkPath = path.join(CHUNK_DIR, `cache-${pad}.json`);
  if (!fs.existsSync(chunkPath)) continue;
  const outer = loadOuter(chunkPath);
  for (const [key, strVal] of Object.entries(outer)) {
    let innerObj;
    try { innerObj = JSON.parse(strVal); } catch { continue; }
    if (!mergedInner[key]) mergedInner[key] = {};
    Object.assign(mergedInner[key], innerObj);
  }
  chunksMerged++;
}

const outOuter = {};
for (const [k, v] of Object.entries(mergedInner)) outOuter[k] = JSON.stringify(v);
fs.writeFileSync(SEED, JSON.stringify(outOuter));

const rxcuiCount = mergedInner.medcode_cache_rxcui_v1 ? Object.keys(mergedInner.medcode_cache_rxcui_v1).length : 0;
const atcCount = mergedInner.medcode_cache_atc_v1 ? Object.keys(mergedInner.medcode_cache_atc_v1).length : 0;
console.log(`Merged ${chunksMerged} chunk caches into ${path.relative(REPO_ROOT, SEED)}`);
console.log(`Shared cache now: ${rxcuiCount} rxcui entries, ${atcCount} atc-class entries`);
