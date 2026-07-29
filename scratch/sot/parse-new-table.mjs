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
