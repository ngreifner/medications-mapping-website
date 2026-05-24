#!/usr/bin/env node
// scripts/refresh-who-snapshots.js
//
// Fetches the WHO ATC/DDD index pages for a configured list of L4 codes,
// parses the L5 table on each page, and writes one JSON file per L4 to
// data/who-atc-snapshots/. Also writes a manifest and an auto-generated
// JS bundle (js/who-atc-snapshots-bundle.js) that the browser runtime
// imports — the .json files are the canonical, human-reviewable artifact;
// the .js bundle is the runtime import surface.
//
// Why this exists: WHO defines many combination-product Level-5 ATC codes
// (e.g. C09DA03 "valsartan and diuretics", N02AJ22 "hydrocodone and
// paracetamol") that are not exposed through any RxNav endpoint. The
// official WHO ATC index at atcddd.fhi.no is the authoritative public
// source, but its server returns no CORS headers, so the browser app
// cannot fetch it directly. This script does the fetching offline, ahead
// of time, and commits the parsed snapshots into the repo.
//
// Run manually or via CI:
//   node scripts/refresh-who-snapshots.js
//
// To add a new L4 to the snapshot list, append to L4_CODES below.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

// ----------------------------------------------------------------
// Configuration
// ----------------------------------------------------------------

const PARSER_VERSION = 1;
const USER_AGENT = "MedCode-Lookup/0.1 (clinical research; https://github.com/ngreifner/medications-mapping-website)";

// L4 codes to snapshot. Keep this list focused on combinations relevant to
// real clinical workflows — every entry costs ~1 HTTP call to WHO per
// refresh.
const L4_CODES = [
  "N02AJ", // Opioids in combination with non-opioid analgesics
  "C09DA", // ARBs and diuretics
  "C09DB", // ARBs and calcium channel blockers
  "C09BA", // ACE inhibitors and diuretics
  "C09BB", // ACE inhibitors and calcium channel blockers
  "C09DX", // ARBs, other combinations (3-component)
  "N04BA", // Dopa derivatives + decarboxylase inhibitor combinations
  "J01CR", // Penicillin + beta-lactamase inhibitor combinations
  "J01DD", // Cephalosporin combinations (incl. ceftazidime/avibactam = Avycaz)
  "J01EE", // Sulfonamide + trimethoprim combinations
  "A10BD", // Oral diabetes combinations (DPP-4 + biguanide, etc.)
  "R03AK", // ICS + LABA combinations
  "R03AL", // LABA + LAMA combinations (incl. triple inhalers)
  "J05AR", // HIV antiviral combinations
  "J05AP", // HCV antiviral combinations
];

const SNAPSHOT_DIR = path.join(REPO_ROOT, "data", "who-atc-snapshots");
const MANIFEST_PATH = path.join(SNAPSHOT_DIR, "_manifest.json");
const BUNDLE_PATH = path.join(REPO_ROOT, "js", "who-atc-snapshots-bundle.js");

const WHO_BASE = "https://atcddd.fhi.no/atc_ddd_index/";

// ----------------------------------------------------------------
// HTTP fetch (ISO-8859-1 aware)
// ----------------------------------------------------------------

async function fetchL4Html(l4Code) {
  const url = `${WHO_BASE}?code=${encodeURIComponent(l4Code)}&showdescription=no`;
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
  });
  if (!response.ok) {
    throw new Error(`WHO returned HTTP ${response.status} for ${l4Code}`);
  }
  // The WHO server returns ISO-8859-1; decode manually so we don't get
  // mojibake on any extended characters (none observed in current pages,
  // but defensive).
  const buf = Buffer.from(await response.arrayBuffer());
  return { url, html: buf.toString("latin1") };
}

// ----------------------------------------------------------------
// Parser
// ----------------------------------------------------------------

/**
 * Parse the L4 page HTML and return the L4 class name + its L5 children.
 * Structure observed (verified Phase 1 against N02AJ, C09DA, N04BA, J01DD):
 *
 *   <table>
 *     <tr><td>ATC code  </td><td>Name  </td><td>DDD </td><td>U </td><td>Adm.R</td><td>Note</td></tr>
 *     <tr><td>{L4}{NN}&nbsp;</td><td><a href="...">name</a>&nbsp;</td><td>...</td>...</tr>
 *     ...
 *   </table>
 *
 * The L4 own name lives in the page's <h3> tag.
 */
function parseL4Page(html, l4Code) {
  // L4 own name — appears as the page heading
  let l4Name = "";
  const headingMatch = html.match(/<h3>\s*([A-Z0-9]+)\s+([^<]+)<\/h3>/i);
  if (headingMatch) {
    // The page heading lists ancestor codes too; the LAST <h3> is the L4
    // itself, so re-scan to take the last match.
    const allHeadings = [...html.matchAll(/<h3>\s*([A-Z0-9]+)\s+([^<]+)<\/h3>/gi)];
    const lastForL4 = allHeadings.reverse().find(m => m[1].toUpperCase() === l4Code.toUpperCase());
    if (lastForL4) l4Name = lastForL4[2].replace(/&nbsp;/g, " ").trim();
  }

  // L5 children — anchor each row on the L4 prefix to skip header / footer
  // rows and any other tables.
  const rowPattern = new RegExp(
    `<tr>\\s*<td>(${l4Code}\\d{2})&nbsp;</td>\\s*<td>(?:<a[^>]*>)?([^<]+?)(?:</a>)?\\s*(?:&nbsp;)?\\s*</td>`,
    "gi",
  );

  const children = [];
  const seenCodes = new Set();
  for (const m of html.matchAll(rowPattern)) {
    const code = m[1].toUpperCase();
    const name = m[2].replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
    if (!name) continue;
    if (seenCodes.has(code)) {
      // Documented possibility: same L5 appears in multiple rows for
      // different administration routes. We take the first occurrence;
      // route doesn't change the ingredient set or the L5 attribution.
      continue;
    }
    seenCodes.add(code);
    children.push({ code, name });
  }

  if (children.length === 0) {
    throw new Error(`parser produced zero L5 children for ${l4Code} — page structure may have changed`);
  }

  return { l4_name: l4Name, children };
}

// ----------------------------------------------------------------
// Refresh
// ----------------------------------------------------------------

async function refreshOne(l4Code) {
  const { url, html } = await fetchL4Html(l4Code);
  const { l4_name, children } = parseL4Page(html, l4Code);
  return {
    l4_code: l4Code,
    l4_name,
    source_url: url,
    refreshed_at: new Date().toISOString(),
    parser_version: PARSER_VERSION,
    children,
  };
}

function buildBundle(snapshots) {
  const lines = [];
  lines.push("// js/who-atc-snapshots-bundle.js");
  lines.push("// AUTO-GENERATED by scripts/refresh-who-snapshots.js — DO NOT EDIT.");
  lines.push("// To refresh, run: node scripts/refresh-who-snapshots.js");
  lines.push("//");
  lines.push("// Each L4 entry mirrors data/who-atc-snapshots/{L4}.json with the same");
  lines.push("// fields. The browser runtime imports this bundle directly so no network");
  lines.push("// calls to WHO are required at query time.");
  lines.push("");
  lines.push("export const WHO_ATC_SNAPSHOTS = " + JSON.stringify(
    Object.fromEntries(snapshots.map(s => [s.l4_code, {
      l4_name: s.l4_name,
      source_url: s.source_url,
      refreshed_at: s.refreshed_at,
      parser_version: s.parser_version,
      children: s.children,
    }])),
    null,
    2,
  ) + ";");
  lines.push("");
  return lines.join("\n");
}

async function main() {
  await fs.mkdir(SNAPSHOT_DIR, { recursive: true });

  console.log(`Refreshing ${L4_CODES.length} L4 snapshots from WHO ATC/DDD index…`);
  const snapshots = [];
  const perL4 = {};

  for (const l4 of L4_CODES) {
    try {
      const snap = await refreshOne(l4);
      const outPath = path.join(SNAPSHOT_DIR, `${l4}.json`);
      await fs.writeFile(outPath, JSON.stringify(snap, null, 2) + "\n", "utf-8");
      snapshots.push(snap);
      perL4[l4] = {
        refreshed_at: snap.refreshed_at,
        parser_version: snap.parser_version,
        entry_count: snap.children.length,
      };
      console.log(`  ${l4}: ${snap.children.length} L5 children, "${snap.l4_name || "(no name)"}"`);
      // Be polite — small gap between requests.
      await new Promise(r => setTimeout(r, 250));
    } catch (err) {
      console.error(`  ${l4}: FAILED — ${err.message}`);
      perL4[l4] = { error: err.message, refreshed_at: new Date().toISOString() };
    }
  }

  const manifest = {
    refreshed_at: new Date().toISOString(),
    parser_version: PARSER_VERSION,
    l4_codes: L4_CODES,
    per_l4: perL4,
  };
  await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  console.log(`\nWrote manifest: ${path.relative(REPO_ROOT, MANIFEST_PATH)}`);

  await fs.writeFile(BUNDLE_PATH, buildBundle(snapshots), "utf-8");
  console.log(`Wrote bundle:   ${path.relative(REPO_ROOT, BUNDLE_PATH)}`);
  console.log(`\nDone. ${snapshots.length}/${L4_CODES.length} L4 snapshots refreshed.`);
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
