// scratch/atc-repair/enrich.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// js/rxnav-client.js caches in localStorage; provide one for Node.
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  clear: () => mem.clear(),
  key: (i) => [...mem.keys()][i] ?? null,
  get length() { return mem.size; },
};

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CACHE = path.join(REPO, "scratch/atc-repair/.enrich-cache.json");
let cache = {};
if (fs.existsSync(CACHE)) { try { cache = JSON.parse(fs.readFileSync(CACHE, "utf8")); } catch { cache = {}; } }
export function saveCache() { fs.writeFileSync(CACHE, JSON.stringify(cache)); }

const { getProperties, getDfgs, getIngredientRxcuis, getPinRxcuis, getMinRxcuis, getAtcPropertyValues } =
  await import("../../js/rxnav-client.js");

const BASE = "https://rxnav.nlm.nih.gov/REST";
let nextAllowed = 0;
const MIN_INTERVAL = 1000 / 14;
async function historyStatus(rxcui) {
  const now = Date.now(); const wait = nextAllowed - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  nextAllowed = Math.max(now, nextAllowed) + MIN_INTERVAL;
  // historystatus is not yet exposed by rxnav-client; this is the one place we read it.
  // TASK 6 ports it into js/rxnav-client.js as getDfgsFromHistory().
  const res = await fetch(`${BASE}/rxcui/${rxcui}/historystatus.json`);
  if (!res.ok) return null;
  return await res.json();
}

export async function enrichRxcui(rxcui) {
  if (cache[rxcui]) return cache[rxcui];

  const id = String(rxcui).trim();

  const props = await getProperties(rxcui).catch(() => null);
  let tty = (props && props.tty) || "";
  let status = (props && props.found === false) ? "NotFound" : "Active";

  let dfgs = await getDfgs(rxcui).catch(() => []);
  let dfgSource = dfgs && dfgs.length ? "live" : "none";

  // NB: getIngredientRxcuis returns the input's own rxcui PLUS related IN
  // rxcuis (documented in js/rxnav-client.js). Filter the input itself out
  // before resolving names, otherwise the product's own name gets counted
  // as an "ingredient" and pollutes ingredientNames / the combo-count check.
  const inIds = (await getIngredientRxcuis(rxcui).catch(() => [])).filter((x) => String(x) !== id);
  let ingredientNames = [];
  for (const ingId of inIds) {
    const p = await getProperties(ingId).catch(() => null);
    if (p && p.name && !ingredientNames.includes(p.name)) ingredientNames.push(p.name);
  }

  // Some drug classes only expose their ingredient relations at the PIN
  // (Precise Ingredient) level, not IN -- insulin analogs are the documented
  // example (see CLAUDE.md's "PIN-attributed L5 codes" / active-moiety-alias
  // notes for the same pattern in the live resolver). When the IN-based
  // lookup above comes up short of a real combination (<2 distinct names),
  // also pull PIN relations and union their resolved names in by exact-name
  // dedupe. Only fires as a top-up (not unconditionally) so it doesn't
  // double-count ingredients for the common case where IN already carries
  // >=2 names.
  if (ingredientNames.length < 2) {
    const pinIds = (await getPinRxcuis(rxcui).catch(() => [])).filter((x) => String(x) !== id);
    for (const pinId of pinIds) {
      const p = await getProperties(pinId).catch(() => null);
      if (p && p.name && !ingredientNames.includes(p.name)) ingredientNames.push(p.name);
    }
  }

  // Same shape caveat applies to getMinRxcuis (input rxcui is included).
  let minAtcCodes = [];
  const minIds = (await getMinRxcuis(rxcui).catch(() => [])).filter((x) => String(x) !== id);
  for (const minId of minIds) {
    const codes = await getAtcPropertyValues(minId).catch(() => []);
    for (const c of codes) if (!minAtcCodes.includes(c)) minAtcCodes.push(c);
  }

  if (!dfgs || !dfgs.length) {
    const h = await historyStatus(rxcui);
    const hs = h && h.rxcuiStatusHistory;
    if (hs) {
      if (hs.metaData && hs.metaData.status) status = hs.metaData.status;
      if (!tty && hs.attributes && hs.attributes.tty) tty = hs.attributes.tty;
      const df = hs.definitionalFeatures && hs.definitionalFeatures.doseFormGroupConcept;
      if (df && df.length) { dfgs = df.map((x) => x.doseFormGroupName); dfgSource = "history"; }
      const ing = hs.definitionalFeatures && hs.definitionalFeatures.ingredientAndStrength;
      if (ing && ing.length && !ingredientNames.length) {
        // activeIngredientName is blank on a real share of historical (obsolete/
        // remapped) multi-ingredient concepts -- confirmed live on RxCUI 1360383
        // (NovoLog Mix), where both ingredientAndStrength entries have
        // activeIngredientName: "" even though the concept genuinely has 2
        // ingredients. baseName is the next-best field on the same object.
        ingredientNames = ing.map((x) => x.activeIngredientName || x.baseName).filter(Boolean);
      }
      // Last-resort fallback: derivedConcepts.ingredientConcept is a sibling
      // section of the same historystatus response and reliably carries
      // ingredientName even when definitionalFeatures' own name fields are
      // blank (both activeIngredientName and baseName empty).
      if (!ingredientNames.length) {
        const derived = hs.derivedConcepts && hs.derivedConcepts.ingredientConcept;
        if (derived && derived.length) {
          ingredientNames = derived.map((x) => x.ingredientName).filter(Boolean);
        }
      }
    }
  }

  const rec = { tty, status, ingredientNames, dfgs: dfgs || [], dfgSource, minAtcCodes };
  cache[rxcui] = rec;
  return rec;
}
