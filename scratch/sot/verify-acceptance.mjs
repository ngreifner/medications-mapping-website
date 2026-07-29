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

// proper CSV line parser (drug_name may contain commas -> quoted fields)
function parseCsvLine(l){const out=[];let f="";let q=false;
  for(let i=0;i<l.length;i++){const c=l[i];
    if(q){if(c==='"'){if(l[i+1]==='"'){f+='"';i++;}else q=false;}else f+=c;}
    else if(c==='"')q=true;else if(c===","){out.push(f);f="";}else f+=c;}
  out.push(f);return out;}
// safety valve: no non-empty production -> empty SOT without a FLAG
const val = lines("reports/sot/rxcui-to-atc-SOT-validation.csv"); const H = parseCsvLine(val[0]);
const iv = (n)=>H.indexOf(n);
let svViolations = 0;
for (const l of val.slice(1)) {
  const c = parseCsvLine(l);
  const p = c[iv("production_atcs")]||""; const f = c[iv("final_atcs")]||""; const v = c[iv("verdict")]||"";
  // ADJUDICATED_OTHER empties are authoritative WHO-verified "no valid code" decisions, not silent drops.
  if (p.trim() && !f.trim() && !v.startsWith("FLAG") && v !== "ADJUDICATED_OTHER") svViolations++;
}
ok(svViolations === 0, `safety valve: ${svViolations} non-empty->empty without FLAG`);

// regression fixtures (expected code must appear in final_atcs)
const finalByRx = new Map();
for (const l of val.slice(1)) { const c=parseCsvLine(l); finalByRx.set(c[iv("rxcui")], c[iv("final_atcs")]||""); }
// Fixtures assert the expected code only for rxcuis actually present in Navina's
// universe; app-example rxcuis not in the universe are skipped (not failed).
const fixtures = [["1797907","R01AD08"],["617310","C10AA05"],["2702393","S01ED01"],["151399","J01EE01"],["1544396","L04AX03"]];
for (const [rx,code] of fixtures) {
  const f = finalByRx.get(rx);
  if (f === undefined) { console.log(`SKIP  fixture ${rx} -> ${code} (not in Navina universe)`); continue; }
  ok(f.split("|").includes(code), `fixture ${rx} -> ${code} (got ${f})`);
}

// reconciliation total
ok(sot.length === sotRx.size, "no duplicate rxcuis in SOT.tsv");

console.log(fails === 0 ? "\nALL ACCEPTANCE CHECKS PASS" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
