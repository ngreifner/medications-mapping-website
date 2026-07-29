// scratch/sot/split-worklist.mjs — split the fix worklist into N roughly-
// equal chunks (excluding A5-ingredient-skip rows) for the parallel
// atcprod-narrow.mjs runner. Each chunk keeps the original header/columns
// so atcprod-narrow.mjs's own parser and bucket filter work unchanged.
//
// Usage: node scratch/sot/split-worklist.mjs [numChunks]   (default 10)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORKLIST_PATH = path.join(REPO_ROOT, "reports/sot/fix/00-fix-worklist.csv");
const CHUNK_DIR = path.join(REPO_ROOT, "scratch/sot/chunks");
const SKIP_BUCKET = "A5-ingredient-skip";
const N = parseInt(process.argv[2] || "10", 10);

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
      } else cur += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { out.push(cur); cur = ""; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

function csvCell(v) {
  const s = String(v ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

const raw = fs.readFileSync(WORKLIST_PATH, "utf8").split("\n");
const lines = raw.filter((l, idx) => idx === 0 || l.trim().length > 0);
const header = parseCsvLine(lines[0]);
const bucketIdx = header.indexOf("bucket");

const dataRows = [];
for (let i = 1; i < lines.length; i++) {
  const cols = parseCsvLine(lines[i]);
  if (cols.length < header.length) continue;
  if ((cols[bucketIdx] || "").trim() === SKIP_BUCKET) continue;
  dataRows.push(cols);
}

fs.mkdirSync(CHUNK_DIR, { recursive: true });
const headerLine = header.map(csvCell).join(",");
const chunkSize = Math.ceil(dataRows.length / N);
let written = 0;
for (let c = 0; c < N; c++) {
  const slice = dataRows.slice(c * chunkSize, (c + 1) * chunkSize);
  if (slice.length === 0) continue;
  const lines = [headerLine, ...slice.map((cols) => cols.map(csvCell).join(","))];
  const outPath = path.join(CHUNK_DIR, `worklist-${String(c + 1).padStart(2, "0")}.csv`);
  fs.writeFileSync(outPath, lines.join("\n") + "\n");
  written += slice.length;
  console.log(`chunk ${c + 1}: ${slice.length} rows -> ${path.relative(REPO_ROOT, outPath)}`);
}
console.log(`\nTotal eligible rows: ${dataRows.length}, written: ${written}`);
