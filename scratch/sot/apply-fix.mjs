// scratch/sot/apply-fix.mjs — Phase 5: merge the fix-pass decisions (Phase-3
// auto + Phase-4 LLM residual) onto the SOT table, rebuild the corrected table,
// and emit a full corrections log + review file + summary.
//
// Precedence per rxcui:
//   1. auto decision (03-decisions-auto.csv)  — ATCPROD-confirmed / L4->L5 promote / ingredient-kept
//   2. residual LLM decision (resid/decision-NN.csv)
//   3. not in the fix pass (unchanged rows) -> keep current_final
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const R = (p) => path.join(REPO, p);
const readLines = (p) => fs.readFileSync(p, "utf8").split("\n").map(x => x.replace(/\r$/, "")).filter(x => x.length);
function parseCsvLine(l){const out=[];let f="";let q=false;
  for(let i=0;i<l.length;i++){const c=l[i];
    if(q){if(c==='"'){if(l[i+1]==='"'){f+='"';i++;}else q=false;}else f+=c;}
    else if(c==='"')q=true;else if(c===","){out.push(f);f="";}else f+=c;}
  out.push(f);return out;}
const codeOK = (c) => /^[A-Z]\d{2}[A-Z]{2}(\d{2})?$/.test(c);          // L4 (5) or L5 (7)
const cleanCodes = (s) => [...new Set((s||"").split("|").map(x=>x.trim()).filter(codeOK))];

// ---- current SOT (all 30,900 rows) ----
const sot = new Map();
{
  const lines = readLines(R("reports/sot/rxcui-to-atc-SOT-validation.csv"));
  const H = parseCsvLine(lines[0]); const ix = n => H.indexOf(n);
  for (let i=1;i<lines.length;i++){ const r=parseCsvLine(lines[i]); const rx=r[ix("rxcui")];
    sot.set(rx, { name:r[ix("drug_name")]||"", tty:r[ix("tty")]||"",
      production:r[ix("production_atcs")]||"", current:r[ix("final_atcs")]||"" }); }
}
// ---- auto decisions ----
const auto = new Map();
for (const l of readLines(R("reports/sot/fix/03-decisions-auto.csv")).slice(1)){
  const r=parseCsvLine(l); auto.set(r[0], { codes:r[1]||"", src:r[2]||"auto" }); }
// ---- residual LLM decisions ----
const resid = new Map();
for (let n=1;n<=20;n++){
  const fp = R(`reports/sot/fix/resid/decision-${String(n).padStart(2,"0")}.csv`);
  if (!fs.existsSync(fp)) { console.error(`WARNING: missing ${fp}`); continue; }
  const lines = readLines(fp); const H=parseCsvLine(lines[0]); const ix=k=>H.indexOf(k);
  for (let i=1;i<lines.length;i++){ const r=parseCsvLine(lines[i]); const rx=r[ix("rxcui")]; if(!rx)continue;
    resid.set(rx, { codes:r[ix("final_codes")]||"", action:r[ix("fix_action")]||"", conf:(r[ix("confidence")]||"").toUpperCase(), ev:r[ix("evidence")]||"" }); }
}

const tsvCell = (s)=> `"${String(s).replace(/"/g,'""')}"`;
const arrCell = (codes)=> codes.length ? `[`+codes.map(c=>`"${c}"`).join(", ")+`]` : `[]`;
const csvCell = (s)=>{ s=String(s??""); return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s; };

const sotOut=["RXCUI\tATC"];
const corr=["rxcui,drug_name,tty,production,prev_final,new_final,fix_source,confidence,changed_this_pass"];
const review=["rxcui,drug_name,tty,production,prev_final,new_final,fix_source,confidence,reason"];
const counts={}; let changedThisPass=0; let emptyNew=0; let svKept=0;
for (const [rx,s] of sot){
  const prod=cleanCodes(s.production), prev=cleanCodes(s.current);
  let neu, src, conf;
  if (auto.has(rx)){ const a=auto.get(rx); neu=cleanCodes(a.codes); src=a.src; conf="HIGH"; }
  else if (resid.has(rx)){ const d=resid.get(rx); neu=cleanCodes(d.codes); src="llm-"+(d.action||"?"); conf=d.conf||""; }
  else { neu=prev; src="unchanged"; conf="n/a"; }
  // safety valve: never blank a row that had production codes unless the LLM explicitly said no-code (OTHER + blank)
  let svFlag=false;
  if (neu.length===0 && prod.length>0){
    const intentionalBlank = resid.has(rx) && resid.get(rx).action==="OTHER";
    if (!intentionalBlank){ neu=prev.length?prev:prod; src+="+safetyvalve"; svKept++; svFlag=true; }
    else emptyNew++;
  }
  counts[src.replace("+safetyvalve","")]=(counts[src.replace("+safetyvalve","")]||0)+1;
  const setEq=(a,b)=>{const A=new Set(a),B=new Set(b);if(A.size!==B.size)return false;for(const x of A)if(!B.has(x))return false;return true;};
  const changed = !setEq(neu,prev);
  if (changed) changedThisPass++;
  sotOut.push(`${rx}\t${tsvCell(arrCell(neu))}`);
  corr.push([rx,s.name,s.tty,prod.join("|"),prev.join("|"),neu.join("|"),src,conf,changed?"YES":"no"].map(csvCell).join(","));
  // review: LOW confidence, intentional blanks, or safety-valve saves
  if (conf==="LOW" || (neu.length===0) || svFlag){
    const reason = neu.length===0 ? "no WHO code (LLM)" : conf==="LOW" ? "low-confidence adjudication" : "safety-valve kept prior";
    review.push([rx,s.name,s.tty,prod.join("|"),prev.join("|"),neu.join("|"),src,conf,reason].map(csvCell).join(","));
  }
}
fs.writeFileSync(R("reports/sot/rxcui-to-atc-SOT.tsv"), sotOut.join("\n")+"\n");
fs.writeFileSync(R("reports/sot/fix/CORRECTIONS-LOG.csv"), corr.join("\n")+"\n");
fs.writeFileSync(R("reports/sot/fix/FIX-REVIEW.csv"), review.join("\n")+"\n");

// summary
let md=`# SOT Fix Pass — Summary\n\nGenerated ${new Date().toISOString().slice(0,16).replace("T"," ")}\n\n`;
md+=`- Total rows in table: ${sot.size}\n`;
md+=`- Rows CHANGED by this fix pass (new_final != prev_final): **${changedThisPass}**\n`;
md+=`- Rows still empty (LLM: no WHO code exists): ${emptyNew}\n`;
md+=`- Safety-valve saves (kept prior to avoid emptying): ${svKept}\n`;
md+=`- Review file rows (LOW-conf + blanks + safety-valve): ${review.length-1}\n\n`;
md+=`## fix_source distribution\n`;
for (const [k,v] of Object.entries(counts).sort((a,b)=>b[1]-a[1])) md+=`- ${k}: ${v}\n`;
fs.writeFileSync(R("reports/sot/fix/FIX-SUMMARY.md"), md);
console.log("Table rows:", sot.size, "| changed this pass:", changedThisPass, "| empty(no-code):", emptyNew, "| safety-valve:", svKept, "| review:", review.length-1);
console.log("fix_source:", counts);
