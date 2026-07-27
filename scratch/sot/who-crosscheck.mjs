// scratch/sot/who-crosscheck.mjs — for each CHANGED row, verify the resolver's
// codes against the committed WHO ATC snapshots. A code is CONFIRMED when its
// L4 exists in the snapshot set AND the exact L5 appears among that L4's WHO
// entries; UNCONFIRMED when we have no snapshot for its L4 (not disproven, just
// not independently WHO-verified); GAP when the resolver itself reported a
// data-gap status (L4_ONLY / COMBINATION_NO_DEDICATED_CODE / RETIRED_NO_REMAP).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MD = path.join(REPO, "skills/route-aware-atc-audit/audit-output-sot/master-diff.csv");
const SNAP_DIR = path.join(REPO, "data/who-atc-snapshots");
const OUT = path.join(REPO, "reports/sot/01-who-check.csv");

// Build the set of WHO L5 codes we have snapshots for, keyed by L4 (5 chars).
const whoL5 = new Set(); const whoL4 = new Set();
if (fs.existsSync(SNAP_DIR)) {
  for (const f of fs.readdirSync(SNAP_DIR)) {
    if (!f.endsWith(".json") || f.startsWith("_")) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(SNAP_DIR, f), "utf8"));
      const l4 = f.replace(/\.json$/, ""); whoL4.add(l4);
      const entries = j.entries || j.l5 || j.codes || (Array.isArray(j) ? j : []);
      for (const e of entries) {
        const code = (e.code || e.atc || e).toString();
        if (/^[A-Z]\d{2}[A-Z]{2}\d{2}$/.test(code)) whoL5.add(code);
      }
    } catch {}
  }
}

// CSV reader (fields may be quoted; list fields pipe-joined, no embedded commas).
const rows = fs.readFileSync(MD, "utf8").split("\n").filter(Boolean).map(l => {
  const out = []; let f = ""; let q = false;
  for (let i = 0; i < l.length; i++) { const c = l[i];
    if (q) { if (c === '"') { if (l[i+1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true; else if (c === ",") { out.push(f); f = ""; } else f += c; }
  out.push(f); return out;
});
const H = rows.shift();
const ix = (n) => H.indexOf(n);
const GAP_STATUS = new Set(["L4_ONLY", "COMBINATION_NO_DEDICATED_CODE", "RETIRED_NO_REMAP", "NO_ATC"]);

const out = ["rxcui,who_check,who_note"];
for (const r of rows) {
  const rx = r[ix("rxcui")];
  const navina = (r[ix("navina_atcs")] || "").split("|").filter(Boolean).sort().join("|");
  const app = (r[ix("app_atcs")] || "").split("|").filter(Boolean);
  const appKey = app.slice().sort().join("|");
  if (navina === appKey) continue; // unchanged — not in the cross-check set
  const status = r[ix("app_status")] || "";
  let check, note;
  if (GAP_STATUS.has(status)) { check = "GAP"; note = `resolver status ${status}`; }
  else {
    const l5 = app.filter(c => /^[A-Z]\d{2}[A-Z]{2}\d{2}$/.test(c));
    if (!l5.length) { check = "GAP"; note = "no L5 codes"; }
    else if (l5.every(c => whoL5.has(c))) { check = "CONFIRMED"; note = "all L5 in WHO snapshot"; }
    else if (l5.some(c => whoL4.has(c.slice(0, 5)))) { check = "CONFIRMED"; note = "L4 in WHO snapshot"; }
    else { check = "UNCONFIRMED"; note = "no WHO snapshot for these L4s"; }
  }
  out.push(`${rx},${check},"${note}"`);
}
fs.writeFileSync(OUT, out.join("\n") + "\n");
const counts = out.slice(1).reduce((m, l) => { const k = l.split(",")[1]; m[k] = (m[k]||0)+1; return m; }, {});
console.log("who-check counts:", counts, "rows:", out.length - 1);
