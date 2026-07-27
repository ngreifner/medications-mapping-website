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
