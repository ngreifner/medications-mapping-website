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
// ---- quote-aware CSV line parser (shared by prior-file + master-diff blocks) ----
function parseCsvLine(l) { const out=[];let f="";let q=false;
  for(let i=0;i<l.length;i++){const c=l[i];
    if(q){if(c==='"'){if(l[i+1]==='"'){f+='"';i++;}else q=false;}else f+=c;}
    else if(c==='"')q=true;else if(c===","){out.push(f);f="";}else f+=c;}
  out.push(f);return out; }
// ---- prior certified (drug_name, tty, certified) ----
const prior = new Map();
{
  const lines = readLines(R("reports/navina-unified-mapping-FINAL.csv"));
  const h = parseCsvLine(lines[0]); const rxI = h.indexOf("rxcui"), nmI = h.indexOf("drug_name"), ttyI = h.indexOf("tty"), certI = h.indexOf("certified_atcs");
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const rx = cells[rxI]; if (!/^\d+$/.test(rx)) continue;
    // Read ONLY the certified_atcs column (our corrected value), using the
    // quote-aware parser above — drug_name can contain embedded commas inside
    // quoted fields (e.g. "100 ML insulin, regular, human ... [Myxredlin]"),
    // which a naive split(",") would misalign, shifting later columns.
    const codes = [...new Set((cells[certI] || "").split("|").map(s => s.trim()).filter(c => /^[A-Z]\d{2}[A-Z]{2}\d{2}$/.test(c)))];
    prior.set(rx, { name: cells[nmI] || "", tty: cells[ttyI] || "", codes });
  }
}
// ---- master-diff (resolver) ----
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
  const w = who.get(rx) || "UNCONFIRMED";
  let verdict, final, reason = "";
  if (setEq(resolver, baseline)) { verdict = "CORRECT"; final = baseline; }
  else if (w === "GAP" || GAP.has(m.status)) { verdict = "FLAG_DATA_GAP"; final = baseline; reason = `data gap (${m.status||w})`; }
  else if (baseline.length === 0 && resolver.length && w === "CONFIRMED") { verdict = "CORRECTED_FROM_EMPTY"; final = resolver; }
  else { verdict = "FLAG_REVIEW"; final = baseline; reason = `resolver disagrees (${resolver.join("|")||"∅"}); who=${w}`; }
  // safety valve
  if (final.length === 0 && p.length > 0) { final = p; if (!verdict.startsWith("FLAG")) { verdict = "FLAG_REVIEW"; reason = "safety valve: kept production to avoid emptying"; } }
  counts[verdict] = (counts[verdict]||0) + 1;
  const src = pr ? (!prod.has(rx) ? "extra" : "prior") : "gap-resolved";
  const row = [rx, name, tty, p.join("|"), baseline.join("|"), resolver.join("|"), w, verdict, final.join("|"), src].map(csvCell).join(",");
  val.push(row);
  if (verdict.startsWith("FLAG")) review.push([rx, name, tty, p.join("|"), baseline.join("|"), resolver.join("|"), w, verdict, final.join("|"), reason].map(csvCell).join(","));
  sot.push(`${rx}\t${tsvCell(arrCell(final))}`);
}
fs.writeFileSync(R("reports/sot/rxcui-to-atc-SOT-validation.csv"), val.join("\n") + "\n");
fs.writeFileSync(R("reports/sot/rxcui-to-atc-SOT-review.csv"), review.join("\n") + "\n");
fs.writeFileSync(R("reports/sot/rxcui-to-atc-SOT.tsv"), "RXCUI\tATC\n" + sot.join("\n") + "\n");

const total = universe.size;
const order = ["CORRECT","CORRECTED","CORRECTED_FROM_EMPTY","FLAG_DATA_GAP","FLAG_REVIEW"];
const sum = order.reduce((s,k)=>s+(counts[k]||0),0);
let mdOut = `# SOT Rebuild — Summary\n\nGenerated ${new Date().toISOString().slice(0,10)}\n\n`;
mdOut += `- Output rows (universe): **${total}**\n`;
for (const k of order) mdOut += `- ${k}: **${counts[k]||0}**\n`;
const changed = (counts.CORRECTED||0)+(counts.CORRECTED_FROM_EMPTY||0);
mdOut += `\n**Corrected total (value differs from production): ${changed}. Flagged for review: ${(counts.FLAG_DATA_GAP||0)+(counts.FLAG_REVIEW||0)}.**\n`;
mdOut += `\nReconciliation check: sum(${sum}) == total(${total}) ? ${sum===total}\n`;
fs.writeFileSync(R("reports/sot/SOT-summary.md"), mdOut);
console.log("verdict counts:", counts, "total:", total, "reconciles:", sum===total);
