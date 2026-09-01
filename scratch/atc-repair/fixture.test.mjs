import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MUST_NOT_CHANGE, MUST_FIX, currentAtcOf } from "./fixture.mjs";
import { getWhoName } from "./who-full-index.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TABLE = path.join(REPO, "reports/rxcui-to-atc/rxcui-to-atc-NAVINA-PRODUCTS-WITH-NAMES.csv");

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
const rows = parseCsv(fs.readFileSync(TABLE, "utf8")).slice(1)
  .filter((r) => r[0]).map((r) => ({ rxcui: r[0], name: r[1], atc: r[2] }));

// every fixture rxcui must exist in the table
for (const f of [...MUST_NOT_CHANGE, ...MUST_FIX]) {
  assert.ok(currentAtcOf(rows, f.rxcui) !== null, `rxcui ${f.rxcui} missing from table`);
}
// MUST_NOT_CHANGE must match the table as it stands today
for (const f of MUST_NOT_CHANGE) {
  assert.equal(currentAtcOf(rows, f.rxcui), f.atc, `baseline drift on ${f.rxcui}`);
}
// MUST_FIX must still be broken (otherwise the fixture is stale)
for (const f of MUST_FIX) {
  assert.equal(currentAtcOf(rows, f.rxcui), f.current, `MUST_FIX baseline drift on ${f.rxcui}`);
}
// every expected answer must be a real WHO code
for (const f of MUST_FIX) {
  if (f.expected === "") continue;
  assert.ok(getWhoName(f.expected), `expected code ${f.expected} not in WHO index`);
}
console.log(`fixture: ${MUST_NOT_CHANGE.length} must-not-change + ${MUST_FIX.length} must-fix verified against table`);
