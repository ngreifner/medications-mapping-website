import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveComboCode } from "./combo-resolver.mjs";
import { enrichRxcui, saveCache } from "./enrich.mjs";
import { MUST_NOT_CHANGE } from "./fixture.mjs";
import { isValidAtcCode, resolveRoute } from "../../js/filter-engine.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = path.join(REPO, "reports/rxcui-to-atc/rxcui-to-atc-NAVINA-PRODUCTS.csv");
const OUT = path.join(REPO, "reports/rxcui-to-atc/repair-2026-09");
const APPLY = process.argv.includes("--apply");
fs.mkdirSync(OUT, { recursive: true });

function parseCsv(text) {
  const rows = []; let cur = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i+1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { cur.push(f); f = ""; }
    else if (c === "\n") { cur.push(f); rows.push(cur); cur = []; f = ""; }
    else if (c !== "\r") f += c;
  }
  if (f.length || cur.length) { cur.push(f); rows.push(cur); }
  return rows;
}
const esc = (s) => (/[",\n]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s));

const raw = parseCsv(fs.readFileSync(SRC, "utf8"));
const header = raw[0];               // RXCUI,ATC_CODES,SOURCES
const body = raw.slice(1).filter((r) => r[0]);
const FROZEN = new Set(MUST_NOT_CHANGE.map((f) => f.rxcui));

const changes = [], worklist = [];
let scanned = 0, repaired = 0, blanked = 0, untouched = 0, frozenSkips = 0;

for (const row of body) {
  const rxcui = row[0];
  const codes = (row[1] || "").split("|").map((s) => s.trim()).filter(Boolean);
  if (codes.length < 2) { untouched++; continue; }   // only multi-code rows can carry a per-ingredient list

  const e = await enrichRxcui(rxcui);
  // Bare ingredient/salt-form concepts (TTY IN/MIN/PIN) legitimately carry multiple
  // mono ATC codes across every route they're formulated in. RxNorm's "related IN"
  // query on an IN concept returns SALT-FORM SIBLINGS (e.g. beclomethasone dipropionate
  // vs. 17-monopropionate), not co-formulated combination partners -- enrichRxcui has
  // no way to tell these apart from a real multi-ingredient product's ingredient list,
  // so this must never be treated as a combination candidate. See the 2026-09-01 defect
  // (RxCUI 1347 et al. blanked from a legitimate 4-code multi-route list) for why this
  // guard exists -- it mirrors Pass 3's existing TTY guard.
  if (["IN", "MIN", "PIN"].includes(e.tty)) { untouched++; continue; }
  if (e.ingredientNames.length < 2) { untouched++; continue; }  // not a combination -> Pass 3's job
  scanned++;

  if (FROZEN.has(rxcui)) { frozenSkips++; continue; }

  const route = e.dfgs && e.dfgs.length ? resolveRoute(e.dfgs) : null;
  const r = resolveComboCode({
    ingredientNames: e.ingredientNames,
    currentCodes: codes,
    minAtcCodes: e.minAtcCodes,
    dfgs: e.dfgs,
    route,
  });

  if (r.code) {
    if (!isValidAtcCode(r.code)) {
      worklist.push({ rxcui, name: e.ingredientNames.join(" + "), current: codes.join("|"),
        proposed: r.code, provenance: r.provenance, reason: "resolved code failed isValidAtcCode" });
      continue;
    }
    if (r.code === codes.join("|")) { untouched++; continue; }
    changes.push({ rxcui, current: codes.join("|"), next: r.code,
      verdict: "COLLAPSE_TO_COMBINATION", provenance: r.provenance,
      reason: `${e.ingredientNames.length} ingredients -> single WHO combination code` });
    row[1] = r.code;
    repaired++;
  } else {
    // Spec R2: never invent. Blank and hand to a human.
    changes.push({ rxcui, current: codes.join("|"), next: "",
      verdict: "BLANKED_NO_WHO_COMBO", provenance: r.provenance,
      reason: "WHO defines no dedicated combination code for this ingredient set" });
    worklist.push({ rxcui, name: e.ingredientNames.join(" + "), current: codes.join("|"),
      proposed: "", provenance: r.provenance,
      reason: r.provenance === "ambiguous" ? `ambiguous: ${r.candidates.join("|")}` : "no dedicated WHO combination code" });
    row[1] = "";
    blanked++;
  }
}
saveCache();

const chHdr = ["rxcui","current","next","verdict","provenance","reason"];
fs.writeFileSync(path.join(OUT, "pass1-changes.csv"),
  [chHdr.join(",")].concat(changes.map((c) => chHdr.map((h) => esc(c[h])).join(","))).join("\n") + "\n");
const wlHdr = ["rxcui","name","current","proposed","provenance","reason"];
fs.writeFileSync(path.join(OUT, "pass1-review-worklist.csv"),
  [wlHdr.join(",")].concat(worklist.map((c) => wlHdr.map((h) => esc(c[h])).join(","))).join("\n") + "\n");

const summary = `# Pass 1 — combination repair (${APPLY ? "APPLIED" : "DRY RUN"})

combination rows scanned      : ${scanned}
collapsed to a WHO combo code : ${repaired}
blanked (no WHO combo exists) : ${blanked}
left unchanged                : ${untouched}
skipped (regression fixture)  : ${frozenSkips}
review worklist rows          : ${worklist.length}
`;
fs.writeFileSync(path.join(OUT, "pass1-summary.md"), summary);
console.log(summary);

if (APPLY) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
  fs.copyFileSync(SRC, `${SRC}.bak.${stamp}`);
  const outRows = [header, ...body];
  fs.writeFileSync(SRC, outRows.map((r) => r.map(esc).join(",")).join("\n") + "\n");
  console.log(`APPLIED. backup at ${SRC}.bak.${stamp}`);
} else {
  console.log("dry run — re-run with --apply to write");
}
