// openfda-client.js, the ONLY module allowed to call api.fda.gov.
// Mirrors rxnav-client's shape: localStorage cache (30-day TTL), retry +
// backoff, and a rate-limited scheduler. OpenFDA's anonymous limit is much
// lower than RxNav's (1000/day per IP) so we batch aggressively: each
// request OR-matches up to BATCH_SIZE package_ndc values.
//
// The single public function is getOpenFdaDetailsForNdcs(ndcs), which
// returns a Map<inputNdc, record | null> where record carries the brand /
// generic / labeler / dosage form / route / strength / marketing dates /
// product type / packaging description. Inputs that don't match in
// OpenFDA's index map to null in the returned Map.

const BASE = "https://api.fda.gov/drug/ndc.json";
const CACHE_KEY = "medcode_cache_openfda_v1";
const CACHE_VERSION = 1;
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const BATCH_SIZE = 25;                          // packagings per OR query
const MIN_INTERVAL_MS = 250;                    // ~4 req/sec, conservative
const RETRY_DELAYS_MS = [800, 1600, 3200];

// ---------------- cache ----------------

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return { __cache_version: CACHE_VERSION };
    const parsed = JSON.parse(raw);
    if (parsed.__cache_version !== CACHE_VERSION) return { __cache_version: CACHE_VERSION };
    return parsed;
  } catch {
    return { __cache_version: CACHE_VERSION };
  }
}

function saveCache(obj) {
  try {
    obj.__cache_version = CACHE_VERSION;
    localStorage.setItem(CACHE_KEY, JSON.stringify(obj));
  } catch {
    // Storage full or disabled, fall back to memory-only.
  }
}

function cacheGet(key) {
  const cache = loadCache();
  const entry = cache[key];
  if (!entry || typeof entry.timestamp !== "number") return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) return null;
  return entry.value; // null is a valid cached miss
}

function cachePut(key, value) {
  const cache = loadCache();
  cache[key] = { value, timestamp: Date.now() };
  saveCache(cache);
}

// ---------------- rate limiter ----------------

let lastStart = 0;
function schedule(task) {
  return new Promise((resolve, reject) => {
    const now = Date.now();
    const wait = Math.max(0, lastStart + MIN_INTERVAL_MS - now);
    lastStart = now + wait;
    setTimeout(() => task().then(resolve, reject), wait);
  });
}

async function fetchJson(url) {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(url);
      // OpenFDA returns 404 with {"error":{"code":"NOT_FOUND"...}} when no
      // documents match — treat it as a legitimate "no result", not an error.
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
      if (attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Request failed: ${url}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------- NDC format normalization ----------------
//
// FDA NDC has three real segmentations: 4-4-2, 5-3-2, 5-4-2. HIPAA forces
// an 11-digit "billing" form that zero-pads to 5-4-2. We don't know the
// original segmentation from a hyphenless input, so we generate every
// plausible hyphenated variant and OR them into a single OpenFDA query.

function generateCandidates(input) {
  const raw = String(input || "").trim();
  if (!raw) return [];
  // Already hyphenated? Trust the segmentation.
  if (raw.includes("-")) {
    const cleaned = raw.replace(/\s+/g, "");
    return [cleaned];
  }
  // Pure digits, expand to plausible segmentations.
  const digits = raw.replace(/\D/g, "");
  const out = new Set();
  if (digits.length === 11) {
    // 5-4-2 HIPAA padded form
    out.add(`${digits.slice(0,5)}-${digits.slice(5,9)}-${digits.slice(9,11)}`);
    // Unpad to 4-4-2 (labeler leading zero dropped)
    if (digits[0] === "0") {
      out.add(`${digits.slice(1,5)}-${digits.slice(5,9)}-${digits.slice(9,11)}`);
    }
    // Unpad to 5-3-2 (product leading zero dropped)
    if (digits[5] === "0") {
      out.add(`${digits.slice(0,5)}-${digits.slice(6,9)}-${digits.slice(9,11)}`);
    }
  } else if (digits.length === 10) {
    // Could be 4-4-2 or 5-3-2 or 5-4-1, try all three:
    out.add(`${digits.slice(0,4)}-${digits.slice(4,8)}-${digits.slice(8,10)}`);
    out.add(`${digits.slice(0,5)}-${digits.slice(5,8)}-${digits.slice(8,10)}`);
    out.add(`${digits.slice(0,5)}-${digits.slice(5,9)}-${digits.slice(9,10)}`);
  }
  return [...out];
}

// ---------------- public API ----------------

/**
 * Look up brand / generic / labeler / etc. details for a list of input NDCs.
 *
 * @param {string[]} ndcs
 * @param {Object} [opts]
 * @param {{cancelled: boolean}} [opts.cancel]
 * @param {(progress:{done:number,total:number,batchSize:number}) => void} [opts.onBatchDone]
 * @returns {Promise<Map<string, OpenFdaRecord | null>>}
 *
 * OpenFdaRecord shape:
 *   {
 *     packageNdc,                            // the matched package_ndc string
 *     brandName, genericName,
 *     labelerName,
 *     dosageForm, route,                     // route is comma-joined
 *     strength,                              // first active ingredient's strength
 *     activeIngredients,                     // joined "name (strength); ..."
 *     marketingCategory, marketingStatus,
 *     marketingStartDate, marketingEndDate,  // YYYYMMDD or empty
 *     productType,
 *     productNdc,
 *     packagingDescription,                  // packaging[match].description
 *     splSetId, fdaApprovalNumber,
 *   }
 */
export async function getOpenFdaDetailsForNdcs(ndcs, opts = {}) {
  const { cancel, onBatchDone } = opts;
  const inputs = [...new Set((ndcs || []).map(s => String(s).trim()).filter(Boolean))];
  const result = new Map();

  // Cache lookup. cacheGet returns null for both "cache miss" and "cached
  // miss (we asked OpenFDA and it returned nothing)" — so walk the raw
  // cache here to distinguish the two.
  const fetchInputs = [];
  const cacheSnapshot = loadCache();
  for (const input of inputs) {
    const entry = cacheSnapshot[input];
    if (entry && typeof entry.timestamp === "number" && Date.now() - entry.timestamp <= CACHE_TTL_MS) {
      result.set(input, entry.value); // value: record OR null (cached miss)
    } else {
      fetchInputs.push(input);
    }
  }

  // Map each input to its candidate hyphenated forms.
  const candidatesByInput = new Map();
  for (const input of fetchInputs) {
    candidatesByInput.set(input, generateCandidates(input));
  }

  // Build batches by combining the OR'd candidates of many inputs into one
  // request. Each batch holds up to BATCH_SIZE inputs (not candidates), so
  // the OpenFDA URL stays well under any practical length limit.
  const batches = [];
  for (let i = 0; i < fetchInputs.length; i += BATCH_SIZE) {
    batches.push(fetchInputs.slice(i, i + BATCH_SIZE));
  }

  let done = 0;
  for (const batch of batches) {
    if (cancel && cancel.cancelled) break;

    // Gather every candidate string across this batch into one OR list.
    const orParts = [];
    const candidateOwner = new Map(); // candidate → owning input
    for (const input of batch) {
      for (const c of candidatesByInput.get(input) || []) {
        orParts.push(`"${c}"`);
        candidateOwner.set(c, input);
      }
    }
    if (orParts.length === 0) {
      for (const input of batch) {
        result.set(input, null);
        cachePut(input, null);
      }
      done += batch.length;
      if (onBatchDone) onBatchDone({ done, total: fetchInputs.length, batchSize: batch.length });
      continue;
    }

    const url = `${BASE}?search=packaging.package_ndc:(${orParts.join("+OR+")})&limit=${BATCH_SIZE * 3}`;
    let data;
    try {
      data = await schedule(() => fetchJson(url));
    } catch {
      // Network/HTTP error: leave these inputs unset for this run; don't
      // cache nulls so a later retry can succeed.
      done += batch.length;
      if (onBatchDone) onBatchDone({ done, total: fetchInputs.length, batchSize: batch.length });
      continue;
    }

    const products = data && !data.__notFound && Array.isArray(data.results) ? data.results : [];

    // Index: for each input, find a product whose packaging contains one of
    // the input's candidates. First match wins.
    const matched = new Set();
    for (const input of batch) {
      const inputCandidates = new Set((candidatesByInput.get(input) || []));
      let hit = null;
      let matchedPackaging = null;
      for (const p of products) {
        for (const pkg of (p.packaging || [])) {
          if (pkg && inputCandidates.has(pkg.package_ndc)) {
            hit = p;
            matchedPackaging = pkg;
            break;
          }
        }
        if (hit) break;
      }
      if (hit) {
        const rec = normalizeRecord(hit, matchedPackaging);
        result.set(input, rec);
        cachePut(input, rec);
        matched.add(input);
      } else {
        result.set(input, null);
        cachePut(input, null);
      }
    }
    done += batch.length;
    if (onBatchDone) onBatchDone({ done, total: fetchInputs.length, batchSize: batch.length });
  }

  return result;
}

function normalizeRecord(p, pkg) {
  const ai = Array.isArray(p.active_ingredients) ? p.active_ingredients : [];
  const ofda = p.openfda || {};
  return {
    packageNdc: pkg ? String(pkg.package_ndc || "") : "",
    brandName: p.brand_name || (Array.isArray(ofda.brand_name) ? ofda.brand_name[0] : "") || "",
    genericName: p.generic_name || (Array.isArray(ofda.generic_name) ? ofda.generic_name[0] : "") || "",
    labelerName: p.labeler_name || "",
    dosageForm: p.dosage_form || "",
    route: Array.isArray(p.route) ? p.route.join(", ") : (p.route || ""),
    strength: ai.length > 0 ? String(ai[0].strength || "") : "",
    activeIngredients: ai.length > 0
      ? ai.map(a => `${a.name || ""}${a.strength ? ` (${a.strength})` : ""}`).join("; ")
      : "",
    marketingCategory: p.marketing_category || "",
    marketingStatus: p.marketing_status || "",
    marketingStartDate: pkg && pkg.marketing_start_date ? pkg.marketing_start_date : (p.marketing_start_date || ""),
    marketingEndDate:   pkg && pkg.marketing_end_date   ? pkg.marketing_end_date   : (p.marketing_end_date || ""),
    productType: p.product_type || "",
    productNdc: p.product_ndc || "",
    packagingDescription: pkg ? String(pkg.description || "") : "",
    splSetId: p.spl_id || "",
    fdaApprovalNumber: p.application_number || "",
  };
}
