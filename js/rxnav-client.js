// rxnav-client.js, the ONLY module allowed to call fetch().
// Owns: RxNav requests, localStorage caching (30-day TTL), retry+backoff,
// rate limiting (15 req/sec), and a 6-concurrent Promise pool.
//
// Helpers are tailored to the endpoints atc-resolver.js needs. Each returns
// already-parsed data so the resolver can stay focused on orchestration.

const BASE = "https://rxnav.nlm.nih.gov/REST";

const CACHE_VERSION = 1;
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const CACHE_KEYS = {
  rxcui:     "medcode_cache_rxcui_v1",
  ndc:       "medcode_cache_ndc_v1",
  atc:       "medcode_cache_atc_v1",
  ndcprops:  "medcode_cache_ndcprops_v1",
  ndcstatus: "medcode_cache_ndcstatus_v1",
};

const MAX_CONCURRENT = 6;
const MIN_INTERVAL_MS = 1000 / 15; // 15 req/sec → ~66.7ms between starts
const RETRY_DELAYS_MS = [1000, 2000, 4000];

// ---------------- cache ----------------

function loadCache(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed.__cache_version !== CACHE_VERSION) return { __cache_version: CACHE_VERSION };
    return parsed;
  } catch {
    return { __cache_version: CACHE_VERSION };
  }
}

function saveCache(key, obj) {
  try {
    obj.__cache_version = CACHE_VERSION;
    localStorage.setItem(key, JSON.stringify(obj));
  } catch {
    // Storage full / disabled, silently continue; network calls still work.
  }
}

function cacheGet(cacheKey, id) {
  const cache = loadCache(cacheKey);
  const entry = cache[id];
  if (!entry || typeof entry.timestamp !== "number") return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) return null;
  return entry;
}

function cachePut(cacheKey, id, value) {
  const cache = loadCache(cacheKey);
  cache[id] = { ...value, timestamp: Date.now() };
  saveCache(cacheKey, cache);
}

function cacheMergeRxcui(id, partial) {
  const existing = cacheGet(CACHE_KEYS.rxcui, id) || {};
  cachePut(CACHE_KEYS.rxcui, id, { ...existing, ...partial });
}

export function clearCache() {
  for (const k of Object.values(CACHE_KEYS)) {
    try { localStorage.removeItem(k); } catch {}
  }
}

// ---------------- rate limiter + pool ----------------

let lastStart = 0;
let active = 0;
const queue = [];

function schedule(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    drain();
  });
}

function drain() {
  while (active < MAX_CONCURRENT && queue.length > 0) {
    const now = Date.now();
    const wait = Math.max(0, lastStart + MIN_INTERVAL_MS - now);
    const { task, resolve, reject } = queue.shift();
    active++;
    lastStart = now + wait;
    setTimeout(() => {
      task().then(
        (v) => { active--; resolve(v); drain(); },
        (e) => { active--; reject(e); drain(); },
      );
    }, wait);
  }
}

// ---------------- fetch with retry ----------------

async function fetchJson(url) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 404) return { __notFound: true };
      if (!res.ok) {
        if (res.status >= 500 && attempt < RETRY_DELAYS_MS.length) {
          await sleep(RETRY_DELAYS_MS[attempt]);
          continue;
        }
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
    }
  }
  throw lastErr || new Error(`Request failed: ${url}`);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------- helpers for parsing RxNav shapes ----------------

function asArray(x) {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

// ---------------- public API ----------------

/**
 * /rxcui/{rxcui}/properties.json, returns { found, rxcui, name, tty, synonym }.
 */
export async function getProperties(rxcui) {
  const id = String(rxcui).trim();
  const cached = cacheGet(CACHE_KEYS.rxcui, id);
  if (cached && cached.properties) return cached.properties;

  const data = await schedule(() => fetchJson(`${BASE}/rxcui/${encodeURIComponent(id)}/properties.json`));
  let result;
  if (data.__notFound || !data?.properties) {
    result = { found: false, rxcui: id };
  } else {
    const p = data.properties;
    result = {
      found: true,
      rxcui: id,
      name: p.name || null,
      tty: p.tty || null,
      synonym: p.synonym || null,
    };
  }
  cacheMergeRxcui(id, { properties: result });
  return result;
}

/**
 * /rxcui/{rxcui}/related.json?tty=DFG, returns string[] of DFG names (e.g.
 * ["Nasal Product", "Inhalant Product"]). Empty array if the request fails or
 * none returned.
 */
export async function getDfgs(rxcui) {
  const id = String(rxcui).trim();
  const cached = cacheGet(CACHE_KEYS.rxcui, id);
  if (cached && cached.dfgs) return cached.dfgs.values;

  try {
    const url = `${BASE}/rxcui/${encodeURIComponent(id)}/related.json?tty=DFG`;
    const data = await schedule(() => fetchJson(url));
    if (data.__notFound || !data?.relatedGroup?.conceptGroup) {
      cacheMergeRxcui(id, { dfgs: { values: [] } });
      return [];
    }
    const groups = asArray(data.relatedGroup.conceptGroup);
    const names = [];
    for (const g of groups) {
      if (g.tty !== "DFG") continue;
      for (const p of asArray(g.conceptProperties)) {
        if (p && p.name) names.push(p.name);
      }
    }
    cacheMergeRxcui(id, { dfgs: { values: names } });
    return names;
  } catch {
    return [];
  }
}

/**
 * /rxcui/{rxcui}/related.json?tty=IN, returns string[] of RXCUIs containing
 * both the input itself and all related ingredient RXCUIs. Used to match the
 * input drug against ATC class members in resolveLevel5FromClassMembers.
 */
export async function getIngredientRxcuis(rxcui) {
  const id = String(rxcui).trim();
  const cached = cacheGet(CACHE_KEYS.rxcui, id);
  if (cached && cached.ingredientRxcuis) return cached.ingredientRxcuis.values;

  const url = `${BASE}/rxcui/${encodeURIComponent(id)}/related.json?tty=IN`;
  const data = await schedule(() => fetchJson(url));
  const ids = new Set([id]);
  if (!data.__notFound && data?.relatedGroup?.conceptGroup) {
    for (const g of asArray(data.relatedGroup.conceptGroup)) {
      for (const p of asArray(g.conceptProperties)) {
        if (p && p.rxcui) ids.add(String(p.rxcui));
      }
    }
  }
  const values = Array.from(ids);
  cacheMergeRxcui(id, { ingredientRxcuis: { values } });
  return values;
}

/**
 * /rxcui/{rxcui}/related.json?tty=MIN, returns string[] of Multiple
 * Ingredient (MIN) RxCUIs related to the input. Used by the resolver's
 * combination path: a MIN concept sometimes carries the dedicated
 * combination L5 ATC code in its property.json (e.g. MIN 1799211
 * "sofosbuvir / velpatasvir" → J05AP55) even when ATCPROD and
 * classMembers only expose the L4. Includes the input itself for
 * consistency with the IN / PIN siblings; callers filter that out.
 */
export async function getMinRxcuis(rxcui) {
  const id = String(rxcui).trim();
  const cached = cacheGet(CACHE_KEYS.rxcui, id);
  if (cached && cached.minRxcuis) return cached.minRxcuis.values;

  const url = `${BASE}/rxcui/${encodeURIComponent(id)}/related.json?tty=MIN`;
  const data = await schedule(() => fetchJson(url));
  const ids = new Set([id]);
  if (!data.__notFound && data?.relatedGroup?.conceptGroup) {
    for (const g of asArray(data.relatedGroup.conceptGroup)) {
      for (const p of asArray(g.conceptProperties)) {
        if (p && p.rxcui) ids.add(String(p.rxcui));
      }
    }
  }
  const values = Array.from(ids);
  cacheMergeRxcui(id, { minRxcuis: { values } });
  return values;
}

/**
 * /rxcui/{rxcui}/related.json?tty=PIN, returns string[] of Precise Ingredient
 * RxCUIs related to the input. Includes the input itself, like
 * getIngredientRxcuis. Used by resolveLevel5FromClassMembers to widen the
 * match set so PIN-attributed L5 codes (e.g. salt forms like "clorazepate
 * dipotassium" at N05BA05) are reachable from a parent SCD.
 */
export async function getPinRxcuis(rxcui) {
  const id = String(rxcui).trim();
  const cached = cacheGet(CACHE_KEYS.rxcui, id);
  if (cached && cached.pinRxcuis) return cached.pinRxcuis.values;

  const url = `${BASE}/rxcui/${encodeURIComponent(id)}/related.json?tty=PIN`;
  const data = await schedule(() => fetchJson(url));
  const ids = new Set([id]);
  if (!data.__notFound && data?.relatedGroup?.conceptGroup) {
    for (const g of asArray(data.relatedGroup.conceptGroup)) {
      for (const p of asArray(g.conceptProperties)) {
        if (p && p.rxcui) ids.add(String(p.rxcui));
      }
    }
  }
  const values = Array.from(ids);
  cacheMergeRxcui(id, { pinRxcuis: { values } });
  return values;
}

/**
 * Fetch ATC classes attached to an RXCUI via the rxclass byRxcui endpoint.
 * RxClass exposes ATC at Level 4 (classType="ATC1-4"); some endpoints
 * occasionally include Level 5 codes.
 *
 * @param {string} rxcui
 * @param {"ATCPROD" | "ATC"} relaSource
 * @returns {Promise<Array<{classId: string, className: string}>>}
 */
async function getAtcByRxcui(rxcui, relaSource) {
  const id = String(rxcui).trim();
  const cacheField = relaSource === "ATCPROD" ? "atcprod" : "atcIngredient";
  const cached = cacheGet(CACHE_KEYS.rxcui, id);
  if (cached && cached[cacheField]) return cached[cacheField].values;

  const url = `${BASE}/rxclass/class/byRxcui.json?rxcui=${encodeURIComponent(id)}&relaSource=${encodeURIComponent(relaSource)}`;
  const data = await schedule(() => fetchJson(url));
  const out = [];
  const seen = new Set();
  if (!data.__notFound && data?.rxclassDrugInfoList?.rxclassDrugInfo) {
    for (const item of asArray(data.rxclassDrugInfoList.rxclassDrugInfo)) {
      const min = item?.rxclassMinConceptItem;
      const classId = min?.classId != null ? String(min.classId).trim() : null;
      if (!classId || seen.has(classId)) continue;
      seen.add(classId);
      out.push({
        classId,
        className: min.className != null ? String(min.className).trim() : "",
      });
    }
  }
  cacheMergeRxcui(id, { [cacheField]: { values: out } });
  return out;
}

export function getAtcprodClasses(rxcui) {
  return getAtcByRxcui(rxcui, "ATCPROD");
}

export function getIngredientAtcClasses(rxcui) {
  return getAtcByRxcui(rxcui, "ATC");
}

/**
 * /rxcui/{rxcui}/property.json?propName=ATC, returns string[] of ATC codes
 * stored directly as an RxNorm property. Often empty.
 */
export async function getAtcPropertyValues(rxcui) {
  const id = String(rxcui).trim();
  const cached = cacheGet(CACHE_KEYS.rxcui, id);
  if (cached && cached.atcProperty) return cached.atcProperty.values;

  const url = `${BASE}/rxcui/${encodeURIComponent(id)}/property.json?propName=ATC`;
  const data = await schedule(() => fetchJson(url));
  const codes = [];
  if (!data.__notFound && data?.propConceptGroup?.propConcept) {
    for (const p of asArray(data.propConceptGroup.propConcept)) {
      if (p?.propValue != null) codes.push(String(p.propValue).trim());
    }
  }
  cacheMergeRxcui(id, { atcProperty: { values: codes } });
  return codes;
}

/**
 * /rxclass/classMembers.json?classId={x}&relaSource={ATC|ATCPROD}, returns the
 * drug members of an ATC class. For each member we surface:
 *   - rxcui:    the member's minConcept.rxcui
 *   - tty:      the member's TTY (when present)
 *   - sourceId: the Level 5 ATC code from nodeAttr SourceId (7 chars)
 *   - sourceName: from nodeAttr SourceName
 *
 * `relaSource` defaults to "ATC" (ingredient-level) for back-compat with the
 * resolver's existing 1-arg calls. Mode 3 passes "ATCPROD" (product-level,
 * route-pre-filtered) as the primary source and falls back to "ATC".
 *
 * Cached per-(classId, relaSource) pair so the two sources don't clobber.
 */
export async function getClassMembers(classId, relaSource = "ATC") {
  const id = String(classId).trim();
  const src = String(relaSource).toUpperCase().trim() || "ATC";
  const cached = cacheGet(CACHE_KEYS.atc, id);
  if (cached && cached.classMembers && cached.classMembers[src]) {
    return cached.classMembers[src];
  }

  const url = `${BASE}/rxclass/classMembers.json?classId=${encodeURIComponent(id)}&relaSource=${encodeURIComponent(src)}`;
  const data = await schedule(() => fetchJson(url));
  const out = [];
  if (!data.__notFound && data?.drugMemberGroup?.drugMember) {
    for (const m of asArray(data.drugMemberGroup.drugMember)) {
      const memberRxcui = m?.minConcept?.rxcui != null ? String(m.minConcept.rxcui) : null;
      if (!memberRxcui) continue;
      const tty = m?.minConcept?.tty ? String(m.minConcept.tty) : null;
      let sourceId = null;
      let sourceName = null;
      for (const a of asArray(m.nodeAttr)) {
        if (a.attrName === "SourceId") sourceId = a.attrValue;
        if (a.attrName === "SourceName") sourceName = a.attrValue;
      }
      out.push({ rxcui: memberRxcui, tty, sourceId, sourceName });
    }
  }
  // Preserve any previously cached source under this classId.
  const existingMembers = (cached && cached.classMembers) || {};
  cachePut(CACHE_KEYS.atc, id, {
    ...(cached || {}),
    classMembers: { ...existingMembers, [src]: out },
  });
  return out;
}

/**
 * Enumerate the Level 5 ATC codes that exist under a Level 4 class, as
 * observed via classMembers(L4, "ATC"). RxClass does not expose L5 codes as
 * classes, they only appear as the SourceId attribute on drug members. This
 * helper collects the distinct (sourceId, sourceName) pairs.
 *
 * Coverage note: this returns "L5s for which RxNorm has at least one drug
 * member," which is a subset of WHO's full ATC catalog. L5s that WHO has
 * defined but RxNorm hasn't classified any drug under will not appear. For
 * Mode 3's "show me the cousins in this family" feature, that's the right
 * scope, querying a no-coverage L5 downstream would return zero RxCUIs
 * anyway, so omitting it doesn't lose anything actionable.
 *
 * Backed by getClassMembers' existing 30-day cache; no extra cache layer.
 */
export async function getLevel5ChildrenForL4(level4Code) {
  const id = String(level4Code).trim().toUpperCase();
  if (!/^[A-Z]\d{2}[A-Z]{2}$/.test(id)) return [];
  const members = await getClassMembers(id, "ATC").catch(() => []);
  const map = new Map(); // code → name
  for (const m of members) {
    const sid = (m.sourceId || "").toUpperCase();
    if (sid.length !== 7 || !sid.startsWith(id)) continue;
    if (!map.has(sid)) map.set(sid, m.sourceName || "");
  }
  return [...map.entries()]
    .map(([code, name]) => ({ code, name }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

/**
 * /ndcproperties.json?id={rxcui}, rich active-NDC metadata for an RXCUI.
 *
 * Returns an array of normalized records:
 *   {
 *     ndc11, ndc10, ndc9,
 *     labeler, marketingCategory, marketingStatus,
 *     fdaApprovalNumber,                   // ANDA/NDA/BLA value
 *     packaging,                            // first description string
 *     color, imprint, shape, size,
 *   }
 *
 * Dedupes by ndcItem, when an NDC has been remapped between RXCUIs in
 * RxNorm's history, the response can include duplicate entries for the
 * same ndcItem. First-seen wins.
 *
 * Cached under CACHE_KEYS.ndcprops keyed by RXCUI, 30-day TTL.
 */
export async function getNdcPropertiesForRxcui(rxcui) {
  const id = String(rxcui).trim();
  const cached = cacheGet(CACHE_KEYS.ndcprops, id);
  if (cached && Array.isArray(cached.entries)) return cached.entries;

  const url = `${BASE}/ndcproperties.json?id=${encodeURIComponent(id)}`;
  const data = await schedule(() => fetchJson(url));
  const out = [];
  const seen = new Set();
  if (!data.__notFound && data?.ndcPropertyList?.ndcProperty) {
    for (const item of asArray(data.ndcPropertyList.ndcProperty)) {
      const ndc11 = item.ndcItem ? String(item.ndcItem) : null;
      if (!ndc11 || seen.has(ndc11)) continue;
      seen.add(ndc11);

      const propMap = {};
      for (const p of asArray(item?.propertyConceptList?.propertyConcept)) {
        if (p && p.propName) propMap[p.propName] = p.propValue;
      }
      const packagingArr = asArray(item?.packagingList?.packaging);
      const packaging = packagingArr.length > 0 ? String(packagingArr[0]) : "";

      const fdaApprovalNumber = propMap.ANDA || propMap.NDA || propMap.BLA || propMap.NDAAUTHORIZEDGENERIC || "";

      // FDA marketing window. Format on the wire is YYYYMMDD; we keep it
      // raw and let the UI extract the year on display.
      const marketingStartDate = propMap.MARKETING_EFFECTIVE_TIME_LOW  || "";
      const marketingEndDate   = propMap.MARKETING_EFFECTIVE_TIME_HIGH || "";

      out.push({
        ndc11,
        ndc10: item.ndc10 ? String(item.ndc10) : "",
        ndc9:  item.ndc9  ? String(item.ndc9)  : "",
        labeler: propMap.LABELER || "",
        marketingCategory: propMap.MARKETING_CATEGORY || "",
        marketingStatus:   propMap.MARKETING_STATUS || "",
        marketingStartDate,
        marketingEndDate,
        fdaApprovalNumber,
        packaging,
        color:   propMap.COLORTEXT || propMap.COLOR || "",
        imprint: propMap.IMPRINT_CODE || "",
        shape:   propMap.SHAPE || "",
        size:    propMap.SIZE || "",
      });
    }
  }
  cachePut(CACHE_KEYS.ndcprops, id, { entries: out });
  return out;
}

/**
 * Backward-compat shim, Mode 3 previously called this to get a flat list of
 * NDC strings. After the Mode-3-NDC removal it's unused in-tree, but kept
 * exported so external callers (the previous /ndcs.json shape) keep working.
 * Returns just the 11-digit NDC codes from the richer ndcproperties dataset.
 */
export async function getNdcsForRxcui(rxcui) {
  const entries = await getNdcPropertiesForRxcui(rxcui);
  return entries.map(e => e.ndc11);
}

/**
 * /ndcstatus.json?ndc={ndc}, RxNav's reverse lookup: NDC → RxCUI plus the
 * drug's concept name, RxNorm status (ACTIVE / OBSOLETE / ALIEN), the
 * canonical 11-digit form, the source list, and the marketing-range history
 * window. Returns a normalized record:
 *   {
 *     found:           bool,
 *     input:           string,        // original input
 *     ndc11:           string,        // canonical 11-digit, no dashes
 *     status:          "ACTIVE" | "OBSOLETE" | "ALIEN" | "" ,
 *     active:          "YES" | "NO" | "",
 *     rxnormNdc:       "YES" | "NO" | "",
 *     rxcui:           string,
 *     conceptName:     string,
 *     conceptStatus:   string,
 *     altNdc:          "Y" | "N" | "",
 *     sourceList:      string[],
 *     marketingStart:  string,       // YYYYMM from ndcHistory[0].startDate
 *     marketingEnd:    string,       // YYYYMM, or "" if still active
 *   }
 *
 * Cached under CACHE_KEYS.ndcstatus keyed by the user's raw input (so the
 * same cache row is reused whether the caller normalized the NDC or not).
 * 30-day TTL like the other rxnav-client caches.
 */
export async function getNdcStatus(ndc) {
  const input = String(ndc).trim();
  const cached = cacheGet(CACHE_KEYS.ndcstatus, input);
  if (cached) return cached;

  const url = `${BASE}/ndcstatus.json?ndc=${encodeURIComponent(input)}`;
  const data = await schedule(() => fetchJson(url));
  let result;
  if (data.__notFound || !data?.ndcStatus) {
    result = { found: false, input };
  } else {
    const s = data.ndcStatus;
    const hist = asArray(s.ndcHistory)[0] || {};
    const sources = asArray(s.sourceList?.sourceName).map(x => String(x));
    result = {
      found: !!s.rxcui,
      input,
      ndc11: s.ndc11 ? String(s.ndc11) : "",
      status: s.status || "",
      active: s.active || "",
      rxnormNdc: s.rxnormNdc || "",
      rxcui: s.rxcui ? String(s.rxcui) : "",
      conceptName: s.conceptName || "",
      conceptStatus: s.conceptStatus || "",
      altNdc: s.altNdc || "",
      sourceList: sources,
      marketingStart: hist.startDate ? String(hist.startDate) : "",
      marketingEnd: hist.endDate ? String(hist.endDate) : "",
    };
  }
  cachePut(CACHE_KEYS.ndcstatus, input, result);
  return result;
}

/**
 * /rxclass/byId.json?classId={id}, returns the className for an ATC class.
 * Cached in the atc cache (class names rarely change between monthly RxNorm
 * releases, so the 30-day TTL is generous-but-fine). Returns null if not found.
 */
export async function getAtcClassName(classId) {
  const id = String(classId).trim();
  const cached = cacheGet(CACHE_KEYS.atc, id);
  if (cached && cached.className !== undefined) return cached.className;

  // NB: the working endpoint is /rxclass/class/byId.json with the extra
  // /class/ segment. /rxclass/byId.json returns 404. Returns {} for L5
  // classIds (L5 is modeled as a class-member attribute, not a class).
  const url = `${BASE}/rxclass/class/byId.json?classId=${encodeURIComponent(id)}`;
  const data = await schedule(() => fetchJson(url));
  let name = null;
  if (!data.__notFound && data?.rxclassMinConceptList) {
    const list = data.rxclassMinConceptList;
    const concepts = list.rxclassMinConcept;
    const item = Array.isArray(concepts) && concepts[0]
      ? concepts[0]
      : list.rxclassMinConceptItem;
    if (item?.className) name = String(item.className).trim();
  }
  const existing = cacheGet(CACHE_KEYS.atc, id) || {};
  cachePut(CACHE_KEYS.atc, id, { ...existing, className: name });
  return name;
}

/**
 * Resolve a drug name → current RXCUI via /approximateTerm.json.
 * Used to regenerate test fixtures by name.
 */
export async function findRxcuiByName(name) {
  const url = `${BASE}/approximateTerm.json?term=${encodeURIComponent(name)}&maxEntries=5`;
  const data = await schedule(() => fetchJson(url));
  if (data.__notFound || !data?.approximateGroup?.candidate?.length) {
    return { found: false, name, rxcui: null };
  }
  const top = data.approximateGroup.candidate[0];
  if (!top.rxcui) return { found: false, name, rxcui: null };
  const props = await getProperties(top.rxcui);
  return {
    found: true,
    name,
    rxcui: top.rxcui,
    resolvedName: top.name || props.name || null,
    tty: props.tty || null,
    score: Number(top.score),
  };
}
