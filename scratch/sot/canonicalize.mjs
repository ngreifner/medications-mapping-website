// scratch/sot/canonicalize.mjs — deterministic sibling-canonicalization pass.
// Group rows by (ingredient-set, route/form-class) parsed from the drug name;
// within each inconsistent group, converge all members onto one canonical code
// set (majority vote; tie -> fewest codes [prefer dedicated combo L5 over split];
// then highest source confidence). Skips strength-determined ingredients where
// identical ingredients legitimately map to different codes.
//
// MODE: `node canonicalize.mjs`         -> report only (no writes)
//       `node canonicalize.mjs --apply` -> rewrite SOT.tsv + write canon log
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const R = (p) => path.join(REPO, p);
const APPLY = process.argv.includes("--apply");
function parseCsvLine(l){const o=[];let f="";let q=false;for(let i=0;i<l.length;i++){const c=l[i];
  if(q){if(c==='"'){if(l[i+1]==='"'){f+='"';i++;}else q=false;}else f+=c;}
  else if(c==='"')q=true;else if(c===","){o.push(f);f="";}else f+=c;}o.push(f);return o;}
const lines = fs.readFileSync(R("reports/sot/fix/CORRECTIONS-LOG.csv"),"utf8").split("\n").filter(x=>x.length).map(x=>x.replace(/\r$/,""));
const H=parseCsvLine(lines[0]); const ix=n=>H.indexOf(n);

// strength-determined ingredients: identical ingredient set, different code by strength — never canonicalize
const STRENGTH_DETERMINED = ["everolimus","finasteride"];

const FORM_MAP = [
  [/ophthalmic|eye /i,"ophthalmic"],[/otic|ear /i,"otic"],[/nasal/i,"nasal"],
  [/rectal|suppository|enema/i,"rectal"],[/vaginal/i,"vaginal"],
  [/topical|cream|ointment|lotion|\bgel\b|\bpaste\b|medicated (patch|pad|cloth|swab)|shampoo|soap|foam|dressing/i,"topical"],
  [/transdermal/i,"transdermal"],[/inhalation|inhalant|metered dose inhaler|dry powder|nebuli/i,"inhalant"],
  [/injection|injectable|prefilled|cartridge|auto-injector/i,"injectable"],
  [/mouthwash|mucous|buccal|sublingual|lozenge|troche|oral (paste|gel|rinse)/i,"oromucosal"],
  [/irrigation/i,"irrigation"],
  [/oral|tablet|capsule|\bpill\b|chewable|solution|suspension|syrup|elixir|granules|powder|lozenge/i,"oral"],
];
function ingredientSig(name){
  let s = name.replace(/\[[^\]]*\]/g," ");                 // drop [Brand]
  s = s.replace(/\b[\d.]+\s*(MG|ML|MCG|UNT|IU|%|MEQ|MMOL|GM|G|L|CELLS|BILLION|MILLION|UNITS?)\b(\s*\/\s*(ML|ACTUAT|HR|MG|G|L|DOSE|CM2|APPLICATION|EA))?/gi," "); // strengths
  s = s.replace(/\b\d+(\.\d+)?\s*(HR|HOUR|H)\b/gi," ");
  // remove dose-form / packaging words
  s = s.replace(/\b(oral|nasal|otic|ophthalmic|rectal|vaginal|topical|transdermal|buccal|sublingual|inhalation|injectable|injection|irrigation|mucosal|dental|prolonged release|extended release|delayed release|24 hr|12 hr|metered dose|dry powder|tablet|capsule|caplet|pill|chewable|disintegrating|solution|suspension|syrup|elixir|granules?|powder|cream|ointment|lotion|gel|paste|foam|shampoo|soap|bar|lozenge|troche|pastille|suppository|enema|patch|pad|film|spray|drops?|inhaler|nebulizer|kit|pack|product|for|prefilled|cartridge|auto-injector|pen|syringe|vial|actuat|medicated|extended|release|mg|ml)\b/gi," ");
  const parts = s.split(/\s*\/\s*|\s+and\s+/i).map(t=>t.replace(/[^a-z0-9]+/gi," ").trim().toLowerCase()).filter(Boolean);
  return [...new Set(parts)].sort();
}
function formClass(name){ for(const [re,c] of FORM_MAP) if(re.test(name)) return c; return "unknown"; }
const setKey = arr => [...new Set(arr)].sort().join("|");

// build rows
const rows=[];
for(let i=1;i<lines.length;i++){ const r=parseCsvLine(lines[i]);
  const codes=(r[ix("new_final")]||"").split("|").filter(Boolean);
  const ings=ingredientSig(r[ix("drug_name")]||"");
  rows.push({rxcui:r[ix("rxcui")],name:r[ix("drug_name")],tty:r[ix("tty")],prod:r[ix("production")],
    codes, conf:(r[ix("confidence")]||"").toUpperCase(), src:r[ix("fix_source")]||"",
    sig: ings.join("+")+"::"+formClass(r[ix("drug_name")]||""), ings}); }

// group
const groups=new Map();
for(const r of rows){ if(!r.ings.length) continue; if(!groups.has(r.sig)) groups.set(r.sig,[]); groups.get(r.sig).push(r); }

const confRank={HIGH:3,MED:2,LOW:1,"":0,"N/A":0};
let changed=[]; let groupsFixed=0;
for(const [sig,members] of groups){
  if(members.length<2) continue;
  if(members.some(m=>m.ings.some(g=>STRENGTH_DETERMINED.includes(g)))) continue; // skip strength-determined
  const distinct=new Set(members.map(m=>setKey(m.codes)));
  if(distinct.size<2) continue;                              // already consistent
  // pick canonical: tally votes, tie-break fewest-codes then confidence
  const tally=new Map();
  for(const m of members){ const k=setKey(m.codes); if(!k) continue;
    const t=tally.get(k)||{k,codes:m.codes,votes:0,bestConf:0}; t.votes++; t.bestConf=Math.max(t.bestConf,confRank[m.conf]||0); tally.set(k,t); }
  const cands=[...tally.values()];
  cands.sort((a,b)=> b.votes-a.votes || a.codes.length-b.codes.length || b.bestConf-a.bestConf);
  const canon=cands[0];
  groupsFixed++;
  for(const m of members){ if(setKey(m.codes)!==canon.k){ changed.push({...m, to:canon.codes, from:m.codes, sig}); } }
}
console.log(`groups with >=2 members: ${[...groups.values()].filter(g=>g.length>1).length}`);
console.log(`inconsistent groups canonicalized: ${groupsFixed}`);
console.log(`rows that would change: ${changed.length}`);
console.log("\nsample canonicalizations (name | from -> to):");
for(const c of changed.slice(0,15)) console.log(`  ${c.rxcui} ${c.name.slice(0,44)} | ${c.from.join("|")} -> ${c.to.join("|")}`);

if(APPLY){
  const toNew=new Map(changed.map(c=>[c.rxcui,c.to]));
  // rewrite SOT.tsv
  const sl=fs.readFileSync(R("reports/sot/rxcui-to-atc-SOT.tsv"),"utf8").split("\n").filter(x=>x.length);
  const out=[sl[0]];
  for(let i=1;i<sl.length;i++){ const [rx]=sl[i].split("\t");
    if(toNew.has(rx)){ const codes=toNew.get(rx); const cell=codes.length?`[`+codes.map(c=>`"${c}"`).join(", ")+`]`:`[]`; out.push(`${rx}\t"${cell.replace(/"/g,'""')}"`);}
    else out.push(sl[i]); }
  fs.writeFileSync(R("reports/sot/rxcui-to-atc-SOT.tsv"), out.join("\n")+"\n");
  const log=["rxcui,drug_name,tty,from_codes,to_codes,group_sig"];
  for(const c of changed) log.push([c.rxcui,c.name,c.tty,c.from.join("|"),c.to.join("|"),c.sig].map(x=>/[",\n]/.test(String(x))?`"${String(x).replace(/"/g,'""')}"`:x).join(","));
  fs.writeFileSync(R("reports/sot/fix/CANONICALIZE-LOG.csv"), log.join("\n")+"\n");
  console.log(`\nAPPLIED: rewrote SOT.tsv (${changed.length} rows) + CANONICALIZE-LOG.csv`);
}
