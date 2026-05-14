// filter-engine.js, pure logic for DFG → route resolution and route → ATC filtering.
//
// All tables (DFG_ROUTE_MAP, DFG_PRIORITY, ROUTE_ATC_MATRIX) are ported verbatim
// from the user's working browser app (index.html). They have been tested
// against real drugs and are the source of truth, not CLAUDE.md, which is
// being rewritten to match this file.
//
// No network calls. No DOM. Console logs use the [RxCUI→ATC] prefix to match
// the browser app line-for-line.

/** Canonical route identifiers. */
export const ROUTE = {
  TOPICAL:      'topical',
  OPHTHALMIC:   'ophthalmic',
  OTIC:         'otic',
  NASAL:        'nasal',
  INHALANT:     'inhalant',
  VAGINAL:      'vaginal',
  RECTAL:       'rectal',
  ORAL:         'oral',
  INJECTABLE:   'injectable',
  TRANSDERMAL:  'transdermal',
  BUCCAL:       'buccal',
  SUBLINGUAL:   'sublingual',
  UNKNOWN:      'unknown',
};

/** Map DFG name → canonical route. */
export const DFG_ROUTE_MAP = {
  'Topical Product':       ROUTE.TOPICAL,
  'Ophthalmic Product':    ROUTE.OPHTHALMIC,
  'Otic Product':          ROUTE.OTIC,
  'Nasal Product':         ROUTE.NASAL,
  'Inhalant Product':      ROUTE.INHALANT,
  'Vaginal Product':       ROUTE.VAGINAL,
  'Rectal Product':        ROUTE.RECTAL,
  'Oral Product':          ROUTE.ORAL,
  'Injectable Product':    ROUTE.INJECTABLE,
  'Transdermal Product':   ROUTE.TRANSDERMAL,
  'Buccal Product':        ROUTE.BUCCAL,
  'Sublingual Product':    ROUTE.SUBLINGUAL,
  'Dental Product':        ROUTE.BUCCAL,
  'Urethral Product':      ROUTE.TOPICAL,
  'Mucosal Product':       ROUTE.TOPICAL,
};

/**
 * DFG priority, when multiple DFGs are returned (e.g. "Nasal Product" +
 * "Inhalant Product"), pick the most specific route. Lower index = higher
 * priority. Routes not listed here have lowest priority.
 */
export const DFG_PRIORITY = [
  ROUTE.OPHTHALMIC, ROUTE.OTIC, ROUTE.NASAL, ROUTE.VAGINAL,
  ROUTE.RECTAL, ROUTE.BUCCAL, ROUTE.SUBLINGUAL, ROUTE.INHALANT,
  ROUTE.TOPICAL, ROUTE.TRANSDERMAL, ROUTE.ORAL, ROUTE.INJECTABLE,
];

/**
 * Route → ATC Prefix Matrix.
 *
 * Local routes use `allow` mode, only ATC codes starting with one of the
 * listed prefixes survive. Everything else is removed.
 *
 * Systemic routes use `exclude` mode, codes starting with any listed prefix
 * (local/route-specific anatomical groups) are removed. Everything else passes.
 *
 * Prefixes are sorted longest-first on module load so e.g. R03 is checked
 * before R, S03 before S, preventing accidental short-prefix matches.
 */
export const ROUTE_ATC_MATRIX = {
  [ROUTE.TOPICAL]:     { mode: 'allow', prefixes: ['D', 'M02', 'N01B', 'C05'] },
  [ROUTE.OPHTHALMIC]:  { mode: 'allow', prefixes: ['S01', 'S03'] },
  [ROUTE.OTIC]:        { mode: 'allow', prefixes: ['S02', 'S03'] },
  [ROUTE.NASAL]:       { mode: 'allow', prefixes: ['R01'] },
  [ROUTE.INHALANT]:    { mode: 'allow', prefixes: ['R03'] },
  [ROUTE.VAGINAL]:     { mode: 'allow', prefixes: ['G01', 'G02', 'G03'] },
  [ROUTE.RECTAL]:      { mode: 'allow', prefixes: ['A07', 'C05'] },
  [ROUTE.BUCCAL]:      { mode: 'allow', prefixes: ['A01'] },
  [ROUTE.ORAL]:        { mode: 'exclude', prefixes: ['A01', 'C05', 'D', 'G01', 'G02', 'G03', 'M02', 'R01', 'S01', 'S02', 'S03'] },
  [ROUTE.INJECTABLE]:  { mode: 'exclude', prefixes: ['A01', 'C05', 'D', 'G01', 'G02', 'G03', 'M02', 'R01', 'R03', 'S01', 'S02', 'S03'] },
  [ROUTE.TRANSDERMAL]: { mode: 'exclude', prefixes: ['A01', 'C05', 'D', 'G01', 'G02', 'G03', 'M02', 'R01', 'R03', 'S01', 'S02', 'S03'] },
  [ROUTE.SUBLINGUAL]:  { mode: 'exclude', prefixes: ['A01', 'C05', 'D', 'G01', 'G02', 'G03', 'M02', 'R01', 'R03', 'S01', 'S02', 'S03'] },
};
for (const rule of Object.values(ROUTE_ATC_MATRIX)) {
  rule.prefixes.sort((a, b) => b.length - a.length);
}

/** Check if an ATC code starts with any prefix in a list. */
function matchesAnyPrefix(atcCode, prefixes) {
  const c = atcCode.toUpperCase();
  return prefixes.some(p => c.startsWith(p));
}

/**
 * Per-code matrix verdict, same logic as filterAtcByRoute but for a single
 * code, without the bulk safety fallback. UI surfaces use this to label
 * individual codes as kept or rejected (with the matched/blocked prefix).
 *
 * Returns { kept: boolean, mode, matchedPrefix, allowedPrefixes?, blockedPrefixes? }.
 */
export function classifyAtcForRoute(atcCode, route) {
  const rule = ROUTE_ATC_MATRIX[route];
  if (!rule) return { kept: true, mode: null, matchedPrefix: null };
  const atc = (atcCode || "").toUpperCase();
  if (rule.mode === "allow") {
    const matched = rule.prefixes.find(p => atc.startsWith(p)) || null;
    return {
      kept: !!matched,
      mode: "allow",
      matchedPrefix: matched,
      allowedPrefixes: rule.prefixes,
    };
  }
  const blocked = rule.prefixes.find(p => atc.startsWith(p)) || null;
  return {
    kept: !blocked,
    mode: "exclude",
    matchedPrefix: blocked,
    blockedPrefixes: rule.prefixes,
  };
}

/**
 * Resolve a list of DFG names into a single canonical route. If multiple
 * DFGs are present, the most specific local route wins (per DFG_PRIORITY).
 * Returns ROUTE.UNKNOWN when no DFG maps to a known route.
 */
export function resolveRoute(dfgNames) {
  if (!dfgNames || dfgNames.length === 0) return ROUTE.UNKNOWN;
  const routes = dfgNames.map(n => DFG_ROUTE_MAP[n]).filter(Boolean);
  if (routes.length === 0) return ROUTE.UNKNOWN;
  if (routes.length === 1) return routes[0];
  routes.sort((a, b) => {
    const ia = DFG_PRIORITY.indexOf(a);
    const ib = DFG_PRIORITY.indexOf(b);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });
  console.log(`[RxCUI→ATC] Multiple DFGs: [${dfgNames.join(', ')}] → resolved to route: ${routes[0]}`);
  return routes[0];
}

/**
 * Filter ATC codes by the drug's resolved route using ROUTE_ATC_MATRIX.
 *
 * Accepts items as either bare strings or `{code, ...}` objects. For UNKNOWN
 * route, or when filtering would remove every code, returns the unfiltered
 * list, the engine never returns zero codes purely from filtering.
 */
export function filterAtcByRoute(atcCodes, route) {
  if (atcCodes.length <= 1 || route === ROUTE.UNKNOWN) return atcCodes;
  const rule = ROUTE_ATC_MATRIX[route];
  if (!rule) return atcCodes;

  const filtered = atcCodes.filter(code => {
    const c = (typeof code === 'string' ? code : code.code || '').toUpperCase();
    if (rule.mode === 'allow') {
      const ok = matchesAnyPrefix(c, rule.prefixes);
      if (!ok) console.log(`[RxCUI→ATC] Filtering out ${c}: not in allowed prefixes for route "${route}"`);
      return ok;
    } else {
      const blocked = matchesAnyPrefix(c, rule.prefixes);
      if (blocked) console.log(`[RxCUI→ATC] Filtering out ${c}: excluded local prefix for systemic route "${route}"`);
      return !blocked;
    }
  });

  if (filtered.length === 0) {
    console.log(`[RxCUI→ATC] Route filter removed all codes for route "${route}" → falling back to unfiltered list`);
    return atcCodes;
  }
  return filtered;
}
