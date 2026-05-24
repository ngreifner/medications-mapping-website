# CLAUDE.md — MedCode Lookup (v7, descriptive)

> Read this file at the start of every session. It documents what HAS been built and how it actually works. When the user asks for something, check this document first.

> v7 amends v6 with: all five modes now built (1 through 5 functional), Mode 3 narrowed to Level 5 ATC only, Modes 4 + 5 cover RXCUI → NDCs (single + batch), About page rebuilt as an in-app section (`?mode=about`), theme toggle now binary light↔dark, and the footer carries explicit attribution.

---

## 1. Mission

**MedCode Lookup** is a route-aware medical code translator covering RxNorm (RXCUI), WHO ATC, and FDA NDC. It corrects the ingredient-pollution flaw in standard mapping: that a single ingredient returns ATC codes spanning every formulation route, regardless of which specific product was queried.

The tool resolves the dose form group of the input drug from RxNorm, derives a route (nasal, ophthalmic, topical, oral, etc.), and filters out wrong-route codes. Every kept and rejected code comes with a plain-English explanation.

**The differentiator:** Other RXCUI→ATC tools exist. None of them *explain why* a code was kept or rejected. MedCode Lookup does — both technically (the rule that matched) and clinically (the substance's alternative uses).

**Target users:** medical informaticists validating drug mappings, clinical product teams authoring rules, EHR/HIE data engineers, pharmacy and quality-measure teams.

**Not for:** patient care decisions, prescribing reference, authoritative classification (RxNorm/WHO/FDA are authoritative).

---

## 2. Architecture (as built)

### Tech stack
- **Vanilla JavaScript (ES modules), HTML, CSS** — zero build step, zero dependencies
- **No backend** — all API calls go from the browser directly to RxNav
- **Deploy-anywhere static** — works on GitHub Pages, Vercel, Netlify, or any static host
- **Themes via CSS custom properties + `[data-theme]` attribute** on `<html>`

### Folder structure (actual)
```
medications mapping website/
├── CLAUDE.md
├── README.md
├── index.html                          ← entry; 5 tabs, Mode 1 active
├── styles.css                          ← CSS vars; light + dark; 768px breakpoint
├── scratch/
│   ├── test-engine.js                  ← Node verification harness
│   └── regen-fixtures.js               ← name → RXCUI regen
└── js/
    ├── app.js                          ← controller (theme, tabs, URL state, paste-detect, keyboard)
    ├── filter-engine.js                ← pure logic: route resolution + matrix filter
    ├── rxnav-client.js                 ← all RxNav API calls + 30-day cache + 15 req/s rate limit
    ├── atc-resolver.js                 ← 3-strategy orchestrator (ATCPROD → DFG filter → property API)
    ├── atc-anatomy.js                  ← code anatomy renderer + async enrichment
    ├── code-detection.js               ← auto-detect RXCUI / ATC / NDC from input
    ├── ndc-normalizer.js               ← NDC format normalization (legacy, currently unused)
    ├── explanations.js                 ← human-readable reason templates
    ├── ui-components.js                ← reusable DOM card renderers
    ├── csv-export.js                   ← shared CSV writer + download trigger
    ├── test-fixtures.js                ← name-based fixtures, RXCUIs resolved at runtime
    └── modes/
        ├── mode1-single-forward.js         ← Mode 1 UI logic (also exports renderInto for row-expand reuse)
        ├── mode2-batch-forward.js          ← Mode 2 batch UI
        ├── mode3-atc-to-rxcuis.js          ← Mode 3 (L5-only after v7)
        ├── mode4-rxcui-to-ndcs.js          ← Mode 4 single RXCUI → NDCs
        └── mode5-batch-rxcui-to-ndcs.js    ← Mode 5 batch RXCUI → NDCs
        └── mode6-batch-ndc-details.js      ← Mode 6 batch NDC → FDA details (OpenFDA)
        └── mode7-batch-ndc-to-rxcui.js     ← Mode 7 batch NDC → RxCUI (RxNav /ndcstatus)
```

### Module responsibilities (as built)
| Module | Role |
|---|---|
| `filter-engine.js` | Pure data + logic. `DFG_ROUTE_MAP`, `DFG_PRIORITY`, `ROUTE_ATC_MATRIX`, `resolveRoute`, `filterAtcByRoute`. No API calls. |
| `rxnav-client.js` | ALL `fetch()` calls. Caching (30-day TTL, separate keys for RXCUI/ATC/NDC). Rate limiter (15 req/sec global, token-bucket). Retry with exponential backoff. |
| `atc-resolver.js` | Multi-strategy orchestrator. `convertRxcuiToAtc(rxcui)` runs Strategy 1 (ATCPROD), Strategy 2 (DFG-filtered ingredient ATC), Strategy 3 (property API on input), and the ATCPROD-Level-4 last-resort fallback. Contains `resolveLevel5FromClassMembers` — the Level 5 promotion mechanism. |
| `atc-anatomy.js` | Code anatomy card renderer. Pure functions for parsing + DOM construction. Async enrichment fetches class names via `rxnav-client`. |
| `code-detection.js` | Pattern matching for input. Returns `{type, value, level?}`. |
| `ndc-normalizer.js` | NDC format conversion to 11-digit canonical. Used by Modes 4/5 when implemented. |
| `explanations.js` | All human-readable strings. Templates take parameters, return prose. No inline strings anywhere in mode files. |
| `ui-components.js` | DOM-based card renderers. Each returns an `HTMLElement`. |
| `modes/mode1-*.js` | Mode 1 UI logic. Thin: collects input, calls resolver, renders cards. Does NOT contain filter logic, API calls, or explanation strings. |

### Process rules (enforced)
1. **Never call `fetch()` outside `rxnav-client.js`.** Modes call client functions.
2. **Never write filter logic outside `filter-engine.js` or `atc-resolver.js`.**
3. **Never write inline explanation strings.** Use templates from `explanations.js`.
4. **Never add dependencies** without explicit user confirmation. Zero-deps is a feature.
5. **DOM-based components, not innerHTML strings.** Match the `ui-components.js` convention.
6. **Update test fixtures** when filter/matrix changes.
7. **Update this CLAUDE.md** when architecture changes.

---

## 3. The Five Modes

| # | Name | Status | Input | Cap | Runtime |
|---|---|---|---|---|---|
| 1 | RXCUI → ATC (single) | ✅ BUILT | 1 RXCUI | — | ~2 sec |
| 2 | RXCUI → ATC (batch) | ✅ BUILT | RXCUIs list | 200 | ~30 sec |
| 3 | ATC → RXCUIs | ✅ BUILT | 1 Level-5 ATC | — | 15-60 sec |
| 4 | RXCUI → NDCs (single) | ✅ BUILT | 1 RXCUI | — | ~2 sec |
| 5 | RXCUI → NDCs (batch) | ✅ BUILT | RXCUIs list | 200 | ~30-90 sec |
| 6 | NDC → FDA details (batch) | ✅ BUILT | NDCs list | 200 | ~5-30 sec |
| 7 | NDC → RXCUI (batch)       | ✅ BUILT | NDCs list | 200 | ~10-60 sec |
| About | Educational explainer | ✅ BUILT | n/a | n/a | static page |

**Mode 3 narrowing (v7):** Mode 3 now only accepts Level 5 ATC codes (7 characters, e.g. R01AD08). Level 1–4 inputs are rejected at validation with an amber info card. The earlier L4 expansion gate and "Group by Level 5" toggle have been removed — the L5-only constraint makes them obsolete.

**Mode 3 L4 family expansion (v8):** Level 4 inputs are now accepted again, but with a different output shape. Auto-detected by length: 5 chars → L4 family card; 7 chars → existing L5 RxCUI lookup (unchanged). The L4 path renders a distinct `card-family` showing the L4 header + a list of Level 5 "cousins" observable through RxClass's ATC source. Each cousin row has a `Query →` button that re-runs Mode 3 on that specific L5, an `Export this list` CSV download (`parent_atc, parent_name, child_atc, child_name, is_combination`), and a `Query all N cousins as batch` button that runs the standard verify path against the L4's classMembers with an L4-prefix acceptance predicate.

The cousin source is `getLevel5ChildrenForL4(L4)` → `getClassMembers(L4, "ATC")` distinct `SourceId` values. RxClass's `classTree.json` only exposes L1–L4 as classes, so it cannot enumerate L5 children directly. The cousin list therefore reflects "L5s with at least one drug member in RxNorm," which is a subset of WHO's full L5 catalog — same coverage shape documented for MIN-matching in §4. The live input hint below the field updates as the user types to indicate which mode the engine will use ("Level 4 family code…" vs. "Level 5 code…").

Combinations are flagged with a soft italic "combination" tag using two signals: WHO's L5 numbering convention (6th character is 5 or 7) or the L4's class name containing "combinations of". For J01EE — whose L4 name is "Combinations of sulfonamides and trimethoprim" — every cousin is correctly tagged even though the L5 numbering doesn't flip into the combination range until index 50.

**Mode 3 progress + cancellation (v8):** Mode 3 mounts a rich progress card (`mode3ProgressCard`) the moment the user clicks Look up — before the roster fetch returns — so the user always has feedback within ~100ms. The card shows a status line ("Fetching family roster…" → "Verifying N members…"), a smoothly animated bar, count (`done of total`), an ETA (rolling 5-completion average; "Estimating…" until five members complete), the most-recent completed member, and a soft-amber Stop button.

Per-member completion drives progress. `verifyAndRender` fires all member promises in parallel through the shared rate limiter and attaches a `.then()` handler that records the result into `records[i]`, pushes a timestamp, and updates the card. The function awaits `Promise.race([allDonePromise, cancel.promise])` so it wakes immediately on either condition.

Cancellation uses a per-run token (`makeCancelToken()`) — Stop fires the token, which both sets `cancelled` and resolves the promise. Late-arriving member handlers check the flag and bail without touching the records array. The function then renders whatever partial results exist with a "Stopped at X of N. Showing partial results." status. In-flight fetches are NOT aborted — they continue in the background, fill the cache, and their results are simply ignored.

A new submit calls `startRun()`, which fires the previous run's cancel token; this keeps superseded `verifyAndRender` awaiters from leaking (they wake via `cancel.promise`, see the `runId !== activeRunId` check, and return). ETA derives from inter-completion intervals (`(timestamps[end] − timestamps[end−5]) / 5 × remaining`) — under parallel rate-limited fetches, throughput-per-completion is a more honest signal than per-member wall time.

**Modes 4 + 5 (v7):** the previous "NDC → ATC" placeholders have been repurposed. Mode 4 takes a single RXCUI and returns its active NDCs with rich metadata (labeler, packaging, marketing category, FDA approval number) in a sortable table. Mode 5 is the batch version. Both call `/ndcproperties.json?id={rxcui}` via the `getNdcPropertiesForRxcui` helper in `rxnav-client.js`.

**Mode 5 cap raised to 200 (v8):** Mode 5's cap matches Mode 2's. Per-item API cost is lighter than Mode 2's: each RXCUI in Mode 5 makes 2 fetches (`getProperties` + `getNdcPropertiesForRxcui`) versus 3-5 fetches per RXCUI through Mode 2's resolver chain, so the previous 20-item cap was overly conservative. The progress card now uses `mode3ProgressCard` so long runs are interruptible: Stop button preserves partial results, a new submit fires the previous run's cancel token via `startRun()` to prevent leaked Promise.race awaiters, and the bar uses the same time-based interpolation as Mode 3 (`EST_MS_PER_RXCUI` initial guess, switches to measured pace after 3 completions). When the pasted input exceeds the cap, the warning card carries a "Trim to 200 and run" action instead of just blocking submission. A duration hint (`Estimated time: ~Xs`) appears below the input when the count crosses `DURATION_HINT_THRESHOLD` (5). Mode 5's output is a single flat NDC table (one row per NDC across all input RXCUIs) with parent RXCUI/drug/TTY columns; zero-NDC inputs surface in a separate "RXCUIs without NDC rows" section below.

**Mode 7 — Batch NDC → RxCUI (v8):** New tab. Reverse direction of Mode 5. Takes a list of NDC codes (up to 200; 10- or 11-digit, dashed or undashed) and returns the parent RxCUI plus the drug's concept name, RxNorm status (ACTIVE / OBSOLETE / ALIEN), the canonical 11-digit form, the marketing-range history window, and the source list. Calls RxNav's `/ndcstatus.json` via the new `getNdcStatus` helper in `rxnav-client.js` (single fetch per NDC, cached under `medcode_cache_ndcstatus_v1` with the standard 30-day TTL). Same input/cap/progress/Stop shape as Modes 5/6: textarea + counter + "Trim to 200 and run" prompt, `mode3ProgressCard` with Stop and partial results, sortable flat table, single CSV download (`medcode-mode7-ndc-to-rxcui-{YYYYMMDD}.csv`, 14 columns: input NDC, RxCUI, concept name, canonical NDC-11, NDC status, active flag, rxnorm_ndc flag, concept status, alt_ndc flag, marketing start/end (YYYYMM), pipe-joined source list, matched flag, skipped flag). NDCs not in RxNorm aren't dropped — they render as "Not in RxNorm" in the Drug column with the rest of the cells dashed.

**Mode 6 — Batch NDC → FDA details (v8):** New tab. Takes a list of NDC codes (up to 200; 10- or 11-digit, dashed or undashed) and returns FDA product metadata that RxNav doesn't expose: brand name (e.g. *Lipitor*), generic name, labeler, dosage form, route, strength, marketing category/status, marketing start/end dates, packaging description, product type, application number. Data source is OpenFDA's `api.fda.gov/drug/ndc.json` via the new `js/openfda-client.js` module, which is the only module allowed to call api.fda.gov (mirrors rxnav-client's pattern: 30-day localStorage cache, retry+backoff, ~4 req/sec rate limit). The client OR-batches up to 25 NDCs per request against `packaging.package_ndc`, and generates 4-4-2 / 5-3-2 / 5-4-2 segmentation candidates for hyphenless inputs so HIPAA-padded 11-digit forms and the three real FDA segmentations all match. Each input maps to a record or to `null` (cached miss for inputs not in OpenFDA's live index). Same input/cap/progress/Stop shape as Mode 5: textarea + counter + "Trim to 200 and run" prompt, `mode3ProgressCard` with Stop and partial results, flat sortable table, single CSV download (`medcode-mode6-ndc-details-{YYYYMMDD}.csv`, 19 columns). Missing rows aren't dropped — they appear with "Not in OpenFDA" in the brand column and the rest of the cells dashed out.

**Mode 3 NDC extension (v8):** After a Mode 3 query finishes, an "Extend with NDCs" action card appears below the summary. Clicking it runs `getNdcPropertiesForRxcui` (the same client helper Mode 5 uses) for every KEPT RxCUI in the result, then flips the table to a three-level view (`ATC L5 → RxCUI → NDC`). The cap is inherited from Mode 5 — `NDC_EXTENSION_CAP = 200`; results larger than the cap show a confirm prompt with "Process first 200 / Cancel" and a trim note (`Showing NDCs for the first 200 of N verified RxCUIs…`) appears in the final view. The extension reuses `mode3ProgressCard` with its own cancel token via `startExtensionRun()` (a bumpRunAndSupersede variant that preserves `currentRun`). The fetched NDC data lives in `currentRun.ndcs: Map<rxcui, NdcEntry[]>` for the lifetime of that run; a small **View: RxCUI-level / NDC-level** toggle in the action row flips between renderings instantly with no re-fetch. A new ATC query supersedes via `startRun()`, which clears `currentRun` and the cached NDC data. CSV: from the NDC view the download is `medcode-mode3-with-ndcs-{ATC}-{YYYYMMDD}.csv` with 17 columns (parent ATC L5 + class name + RxCUI/TTY/route + NDC fields + marketing dates + resolved ATC + status); the original RxCUI-level compact and audit CSVs remain unchanged when the extension hasn't run. RxCUIs with zero active NDCs emit one row with an empty NDC cell labelled "no active NDCs" so they aren't silently dropped.

### Mode 1 — Single Forward (as built)

**Input:** one RXCUI. Submit via Enter key or "Look up" button. Three example chips below input: 1797907 (fluticasone nasal spray), 2702393 (timolol eye drops), 617310 (atorvastatin oral).

**Result cards (in order):**
1. **Drug Identity** — RXCUI, TTY badge, drug name in monospace, action row
2. **Route Resolution** — resolved route label, list of DFGs with the selected one highlighted, "why this route" explanation
3. **Kept ATC card(s)** — one per kept code, green left border, includes ATC class name, "matches the {route} route (allowed prefix: {prefix})" reason
4. **Code Anatomy card(s)** — one per kept code, hierarchical breakdown with five-color level scheme, async-enriched class names from RxNav, completeness bar
5. **Rejected ATC card(s)** — one per rejected code (when any exist), red left border, technical rule + clinical context line in italics
6. **Action bar** — copy, look up another

**Special cases:**
- **Ingredient-level input (TTY=IN, MIN, PIN):** No route resolution, no rejected cards. All Level 5 ATCs from the property API render as kept (no route filtering). Small blue info note: "Ingredient-level lookup — no route filtering applied."
- **RXCUI not found:** Red error card with "Verify on RxNav" button.
- **Invalid input format:** Amber info card. Validation happens before API call.
- **No ATC available:** Info card explaining the RXCUI exists but has no ATC mapping.
- **Network error:** Amber error card with retry button.

**Auto-detection banner:** When user pastes input that doesn't match RXCUI format (e.g., an ATC code or NDC), a blue-left-border banner appears: "Looks like a {detected_type}. Switch to {suggested_mode}?" with Switch / Continue anyway buttons.

**URL state:** Lookup updates URL to `?mode=1&rxcui={rxcui}`. Reloading auto-runs. Browser back/forward navigates lookup history.

**Keyboard:** Enter submits. Esc clears input + result + URL.

**Theme:** Toggle cycles system → light → dark → system. Persists in localStorage. CSS vars + `[data-theme]` attribute.

**Mobile:** Functional at 375px. Input + button stack vertically. Tabs scroll horizontally. Cards reduce to 16px padding.

### Modes 2–5 (placeholder state)
All tabs visible in the UI. Clicking a placeholder tab shows a dashed-border card: "Coming soon — {description}". URL updates to `?mode=N`.

---

## 4. The Filter Engine

### Core principle
The engine resolves an RXCUI to a route-correct ATC code via a three-strategy orchestrator. **All four strategy data sources fire in parallel** via `Promise.all` (each `.catch(() => null)` for resilience). Then the orchestrator processes results in priority order.

### Strategy 1 — ATCPROD (NLM's product-level mapping)
- **Endpoint:** `/rxclass/class/byRxcui.json?rxcui={rxcui}&relaSource=ATCPROD`
- **Returns:** Level 4 codes (4–5 chars), already route-pre-filtered by NLM
- **Action:** If Level 4 codes returned, call `resolveLevel5FromClassMembers(rxcui, level4Ids)` to promote to Level 5. If Level 5 found → return. If not → save Level 4 codes as `atcprodFallback` and as `atcprodPrefixes` (whitelist for downstream strategies).
- **Coverage:** ~97% of common Medicare Part-D RxNorm products.

### Strategy 2 — DFG-filtered ingredient ATC
- **Used when:** Strategy 1 returned no Level 5 (either empty or Level-4-only).
- **Method:**
  1. Resolve route from DFGs (via `resolveRoute(dfgNames)`, using `DFG_PRIORITY` priority order)
  2. Filter ingredient-level ATC codes (from `relaSource=ATC`) via `filterAtcByRoute`
  3. Apply ATCPROD prefix whitelist on top (if Strategy 1 produced Level 4 codes)
  4. If filter produces Level 5 codes → return them
  5. If filter produces Level 4 codes only → call `resolveLevel5FromClassMembers` to promote

### Strategy 3 — Property API (last resort)
- **Endpoint:** `/rxcui/{rxcui}/property.json?propName=ATC`
- **Used when:** Strategies 1 and 2 both failed
- **Method:** Filter `propConcept[].propValue` codes by route + ATCPROD prefix
- **Parsing gotcha:** Filter on `propName === "ATC"`, read code from `propValue` (NOT `propValue` starting with "ATC")

### Last-resort fallback
If all Level 5 paths failed but ATCPROD returned Level 4 codes, return those Level 4 codes rather than nothing.

### `resolveLevel5FromClassMembers(rxcui, level4ClassIds)` — the key mechanism
Given an input RXCUI and a list of Level 4 class IDs, returns the matching Level 5 codes by:

1. **Get matchIds:** input RXCUI plus its IN ingredients **and** its PIN ingredients (parallel fetches of `/rxcui/{rxcui}/related.json?tty=IN` and `tty=PIN`, unioned). Including the PIN form matters because RxClass routinely attributes L5 SourceIds to the salt-named PIN rather than the bare IN — e.g. clorazepate dipotassium PIN 2607 carries N05BA05 while the bare clorazepate IN 2353 carries only L4 N05BA. Pass 2's "is this a combination?" guard still counts IN ingredients only, so a single-ingredient salt product can't be misread as a combo.
2. **For each Level 4 class:** call `/rxclass/classMembers.json?classId={l4}&relaSource=ATC` and try three matching passes (first hit wins):

   **Pass 1 — single-ingredient direct match.** Find a member whose `minConcept.rxcui` is in `matchIds`. Read `nodeAttr[SourceId]` (7-char L5) and `SourceName`. This handles every single-ingredient drug (e.g. fluticasone nasal SCD → R01AD08 because R01AD's members include fluticasone IN).

   **Pass 2 — MIN-equality match for combination products.** For combination L4 classes, RxClass returns Multiple Ingredient (TTY=MIN) members — e.g. J01EE returns six MIN concepts (sulfamethoxazole/trimethoprim, sulfadiazine/tetroxoprim, etc.), each with its own L5 SourceId. Pass 1 fails for combos because the MIN's RXCUI (e.g. 10831) isn't in the input's ingredient set ({10180, 10829}). Pass 2 resolves this: for each MIN member, fetch its ingredient RXCUIs and compare the set; if **equal** to the input's ingredient set, take the MIN's SourceId as L5.

   *Clinical rationale:* a combination product belongs to the multi-ingredient concept that combines exactly the same ingredients, not to any one ingredient's standalone class. Bactrim ({sulfa, TMP}) belongs to J01EE01 (sulfa+TMP), not J01EC01 (sulfa) or J01EA01 (TMP).

   *Why equality (not subset):* a single-ingredient drug whose ingredient appears in a wider MIN would false-positive match (e.g. sulfa alone matching the sulfa+TMP MIN as a subset). Equality is safe; subset isn't.

   Pass 2 is skipped when the input has fewer than 2 ingredients — no benefit and no risk of false positives.

3. **Fallback:** If both passes fail across all L4 classes, iterate over each ingredient RXCUI and call `/rxclass/class/byRxcui.json?rxcui={ing}&relaSource=ATC`. Pick Level 5 codes (length 7) whose value starts with one of the target Level 4 prefixes.

#### What Pass 2 does and why

Pass 2 closes the engine's biggest gap on combination products. Before it, every combo whose L4 was returned by ATCPROD failed to resolve to its specific L5 because the L4's classMembers are MIN concepts (RXCUIs like 10831 = "sulfamethoxazole/trimethoprim") and the combo product's ingredient set (e.g. {10180, 10829}) never contains those MIN RXCUIs directly. Pass 2 reframes the match: it asks "does this MIN combine the same ingredients my product does?" rather than "is this MIN one of my ingredients?" That's the right question for combos.

Concrete impact: Mode 3 for J01EE01 (sulfa+TMP) previously showed every Bactrim product flagged because the resolver couldn't link them back. Pass 2 makes those products KEPT.

#### Known limitation — when Pass 2 cannot help

Pass 2 only succeeds when RxClass's ATC source has a MIN concept attributed at the L5 we need. Coverage is uneven across the ATC tree:

- **Good coverage:** J01EE returns six MIN concepts in classMembers, one per WHO L5 (J01EE01…J01EE07). Every WHO combo in this class is reachable through Pass 2.
- **Sparse coverage:** N04BA returns one member — levodopa as an IN — with SourceId=N04BA01. There is no MIN for carbidopa+levodopa at N04BA02, even though WHO defines N04BA02. So Sinemet products resolve to N04BA01 (single-ingredient levodopa class) instead of N04BA02 (the combo class). Pass 2 cannot rescue this because the data simply isn't in RxClass's ATC mapping.

Cases like N04BA02 will continue to surface in Mode 3 as ROUTE_MISMATCH or NEEDS_REVIEW. That's a faithful reflection of the public infrastructure, not an engine bug.

PIN-attributed L5 codes are a *different* shape of coverage gap that we **do** handle. Some L5 SourceIds in RxClass live on the PIN (salt) form rather than the IN — clorazepate is the canonical example: RxCUI 2607 (PIN, "clorazepate dipotassium") carries N05BA05, while RxCUI 2353 (IN, "clorazepate") carries only L4 N05BA. The Pass 1 matchIds set therefore unions IN + PIN ingredients, so SCDs like 197464 ("clorazepate dipotassium 15 MG Oral Tablet") resolve to N05BA05 instead of falling back to the L4 fallback. Watch for this same pattern in salt-named CNS / cardio / antibiotic / antineoplastic classes.

#### What it would take to close that gap

Three plausible paths, in increasing complexity:

1. **Accept NEEDS_REVIEW as the long-term answer for these cases.** RxClass's mapping is what it is. We document the limitation (this file + Mode 3's status copy) and leave it to the human reviewer. Lowest cost, lowest false-positive risk.
2. **Curated supplementary table.** Ship a small hand-maintained map of `(L5 ATC, [ingredient RXCUI set])` for combos that RxClass doesn't carry — e.g. `N04BA02 ↔ {levodopa, carbidopa}`. Pass 2's match logic would then fall back to this table when classMembers comes up short. Real cost is governance (who updates it when WHO publishes a new L5, how do we audit drift).
3. **Fuzzy name match against WHO ATC.** Pull the official WHO ATC L5 catalog (offline, periodically refreshed), match the combo product's ingredient names against the L5 description text. More automated but introduces a string-matching layer with its own false-positive surface; only worth the investment if the curated table grows beyond a few dozen entries.

The current choice is path 1, with the algorithm in place to take path 2 if and when the limitation becomes a real problem in practice.

#### Regression coverage for single-ingredient queries

Pass 2 is skipped whenever `inputIngredients.size < 2`, so single-ingredient drugs cannot be affected by it. Verified on every fixture and the standard example chips:

- **1797907** (fluticasone nasal spray, SCD): Pass 1 matches fluticasone IN under R01AD → R01AD08. Unchanged.
- **2702393** (timolol ophthalmic): Pass 1 matches timolol IN under S01ED → S01ED01. Unchanged.
- **617310** (atorvastatin oral): Pass 1 matches atorvastatin IN under C10AA → C10AA05. Unchanged.
- **41126** (fluticasone IN): early-exit via the ingredient guard; never reaches the L4 promotion path at all. Unchanged.

For combos, the only behavior change is *adding* matches that previously failed — Pass 2 cannot produce a different match than Pass 1 because Pass 1 always runs first.

### Ingredient-level handling (TTY = IN, MIN, PIN)
**Before any of the three strategies run, the engine checks the input's TTY.** If it's IN, MIN, or PIN:
- Skip route resolution and route filtering (no specific dose form means no route can be determined)
- Fetch the ingredient's ATCs via the property API directly
- Return all Level 5 codes as kept, with status `INGREDIENT_LEVEL`
- The UI shows them as kept cards with an info note explaining no route filtering was applied

**Why this matters:** Earlier iterations tried to pick a "best route" from the ingredient's DFG list. That's meaningless — the DFG list at ingredient level represents all routes the ingredient is formulated in, not "this product's route." Picking one arbitrarily produces wrong results (aminophylline being classified as rectal because Rectal Product was highest in priority order).

### Combination detection (v8)
**Runs in parallel with the three strategies.** After the input's TTY guard passes (i.e., not IN/MIN/PIN), the resolver fetches the input's IN ingredients via `getIngredientRxcuis` in the same parallel wave as ATCPROD/DFG/ingredient-classes/property fetches. The result is fed to `looksLikeCombination({ inIngredientCount, hasMinAncestor, name })` which fires on **any** of these signals:

- two or more IN ingredients (the gold-standard signal — combinations always have ≥2 INs)
- `/ ` or ` and ` in the drug name
- a `\d+\s*MG.*\d+\s*MG` pattern in the name (catches strength-pairs like "12.5 MG / 80 MG")

If combination is detected, `fetchIngredientResolutions(inIds, route)` runs in parallel with the strategy chain and produces a `combinationIngredients` array — one entry per IN ingredient — each carrying:
- `rxcui`, `name`, `tty`
- `codes`: route-filtered Level 5 ATCs reachable via `getAtcPropertyValues(ingredientRxcui)`
- `allCodes`: unfiltered list (for audit / row-expand contexts)

The array is attached to whatever the strategy chain returns. The L5 route filter applied per ingredient uses the SCD's resolved route — so a HCTZ ingredient under an oral product surfaces C03AA03 only, not topical D codes.

### Verdict states
- `KEEP` — at least one Level 5 (or, as last resort, Level 4) code reachable; route filter applied. The `codes` array may contain L5 codes (preferred), L4 codes (when L4→L5 promotion failed), or a mix.
- `INGREDIENT_LEVEL` — input was TTY=IN/MIN/PIN; all ingredient ATCs returned without route filtering.
- `COMBINATION_NO_DEDICATED_CODE` — input was detected as a combination AND the engine could only reach an L4 combination class (e.g., C09DA for HCTZ+valsartan) OR nothing. The L4 code (when present) sits in `codes`, and `combinationIngredients` carries the per-ingredient L5 breakdown. This is an **expected outcome**, not a failure — it reflects RxClass's classMembers gap for combination L4s (the `relaSource=ATC` source returns zero members for combination L4s, so the existing Pass-2 MIN-equality cannot fire).
- `NO_ATC` — all strategies exhausted, no ATC available, and combination detection didn't fire either.

### Status decision priority
Inside the resolver, the strategy chain runs first, then `withCombination(result)` post-processes in six ordered rules. Rules 2 and 3 are non-RxNav-strategy paths that fire BEFORE the L4-fallback / partial-coverage escalation, because both are more authoritative than what the strategy chain returns when they have data.

1. **Not a combination** → return result unchanged.
2. **Combination + MIN ancestor has an L5 in its property API** (Phase-2B) → `KEEP` with that L5, override the strategy chain's codes. Example: RxCUI 1799213 (Epclusa) — MIN ancestor 1799211 ("sofosbuvir / velpatasvir") has `J05AP55` in its `/property.json?propName=ATC`. RxClass's classMembers does NOT expose J05AP55 (classMembers for J05AP returns SCDs whose SourceId is the RxCUI itself, never an L5); ATCPROD does NOT expose it; byId for J05AP55 returns `{}`. The MIN's RxNorm property is the only public surface that carries this code. The resolver consults it, and when it returns an L5 the result envelope is stamped with `minProvenance: { minRxcui, code }` so the UI shows a "Reached via the MIN concept's RxNorm property API" note on the kept card. Same path also catches Bactrim (MIN 10831 → J01EE01) and Glyxambi (MIN 1598392 → A10BD19).
3. **Combination + Navina-curated combination catalog has an ingredient-set match** (Phase-2C) → `KEEP` with the curated L5, stamp `curatedProvenance` on the envelope. Example: RxCUI 200284 (HCTZ + valsartan) → C09DA03 ("valsartan and diuretics"). This rule covers the L5s that WHO defines but NO RxNav surface exposes — empirically verified by exhaustive probing of classMembers across all 13 working relaSources (ATC, ATCPROD, DAILYMED, MEDRT, NDFRT, MESH, SNOMEDCT, VA, RXNORM, EPC, CDC, FDASPL, FMTSME), byRxcui across all the same sources, allProperties, classTree, classContext, byId, byName, findSimilarClasses, and the Prescribable API. The catalog lives in `js/atc-combinations-curated.js` — hand-authored, no upstream license dependency. Match is exact ingredient-set equality on RxNorm IN names (no fuzzy matching, no synonym tables, no name parsing). To add an entry, append `{ l5, name, ingredients }` to `CURATED_COMBINATIONS`.
4. **Combination, L4-only or NO_ATC** → escalate to `COMBINATION_NO_DEDICATED_CODE`. After Rules 2 and 3 ship, this fires only for combinations where neither the MIN concept nor the curated catalog has the L5 (e.g. a niche combo we haven't curated yet). Example before curation: RxCUI 200284 used to land here.
5. **Combination, KEEP with L5 — but partial coverage** → escalate to `COMBINATION_NO_DEDICATED_CODE`. The `shouldEscalateToCombinationNoCode` discriminator decides: if every kept L5 also appears in some ingredient's property-API codes, then the kept L5 is just one ingredient's monotherapy code. Advil PM is the canonical case after Phase 2C (MIN 644895 → empty; not in curated catalog because WHO doesn't define a combo L5 for diphenhydramine+ibuprofen): Strategy 1's M01AE01 (ibuprofen mono) escalates to L4 M01AE.
6. **Combination, KEEP with L5 — full coverage via Pass-2 MIN-equality** → stay `KEEP`, attach ingredients. In practice this path is dead after Rules 2 and 3 ship; it remains as a safety net for edge cases.

The single check `looksLikeCombination` handles both same-family and cross-family combinations uniformly — no separate multi-family safety check.

### Why partial coverage gets escalated (and why this changed)
Earlier the engine returned KEEP for any combination drug where Strategy 1 produced any L5, even when that L5 only represented one ingredient. Users got a misleading green-badge KEPT card whose code was the wrong answer:
- Epclusa (sofosbuvir + velpatasvir) showed J05AP08 (sofosbuvir mono), missing velpatasvir entirely.
- Advil PM (diphenhydramine + ibuprofen) showed M01AE01 (ibuprofen NSAID), missing the antihistamine half.

The `shouldEscalateToCombinationNoCode` rule reads the resolver's own evidence to tell partial from full coverage. A true combination L5 (J01EE01, A10BD19) lives only on the MIN concept and never appears in either IN's property codes. A partial-coverage L5 (J05AP08 for Epclusa, M01AE01 for Advil PM) appears in exactly one IN's property codes. Equality between the kept set and the union of IN property codes → escalate.

This means **RxCUI 901814 (Advil PM) now escalates to COMBINATION_NO_DEDICATED_CODE** (was: KEEP M01AE01). Intentional behavior change for consistency — the Mode 1 UI now renders M01AE (NSAIDs, propionic acid derivatives) as the L4 combination class card, with diphenhydramine and ibuprofen each surfaced as ingredient blocks below.

### Display rules
- **Level 4 codes ARE rendered in result cards** when the engine couldn't reach L5. The L4 surfaces in a `combinationClassCard` (the `card-info` variant with a "Combination class · L4" title) carrying an explicit note: "RxClass's classMembers source does not expose a Level 5 attribution for this product, so no dedicated L5 was reachable. This is faithful reporting, not a degraded result." Previously L4 codes were silently dropped, which produced empty Mode 1 results for combination products like RxCUI 200284 — that bug is fixed in v8.
- **Combination context is rendered as ingredient blocks** (`ingredientAtcBlock`) after the kept cards. One block per IN, each showing the route-filtered Level 5 ATC(s) reachable through the property API.
- **Hierarchy ancestors never appear in rejected cards.** If R01AD08 is kept, R01AD (its Level 4 parent) is suppressed from the rejected list. Filtering happens in `mode1-single-forward.js` before rendering.
- **Mode 2 maps `COMBINATION_NO_DEDICATED_CODE` to `NEEDS_REVIEW`** with the reason "Combination drug, no dedicated Level 5 reachable through RxNav". Row-expand renders the full Mode 1 combination view (banner + L4 card + ingredient blocks).

---

## 5. Filter Data Tables (verbatim from working code)

These are the route-mapping tables in `filter-engine.js`. They evolved through real-drug testing in the original browser app — preserve them as-is.

```js
export const DFG_ROUTE_MAP = {
  "Buccal Product":      "buccal",
  "Inhalant Product":    "inhalant",
  "Injectable Product":  "injectable",
  "Mucosal Product":     "mucosal",
  "Nasal Product":       "nasal",
  "Ophthalmic Product":  "ophthalmic",
  "Oral Product":        "oral",
  "Otic Product":        "otic",
  "Rectal Product":      "rectal",
  "Sublingual Product":  "sublingual",
  "Topical Product":     "topical",
  "Transdermal Product": "transdermal",
  "Vaginal Product":     "vaginal",
};

// Most-specific local routes win over broader systemic ones
export const DFG_PRIORITY = [
  "Ophthalmic Product",
  "Otic Product",
  "Nasal Product",
  "Vaginal Product",
  "Rectal Product",
  "Buccal Product",
  "Sublingual Product",
  "Mucosal Product",
  "Inhalant Product",
  "Topical Product",
  "Transdermal Product",
  "Oral Product",
  "Injectable Product",
];

// Tested against many real drugs in the original browser app.
// Keep prefixes sorted longest-first within each rule.
export const ROUTE_ATC_MATRIX = {
  ophthalmic:  { mode: "allow",   prefixes: ["S01", "S03"] },
  otic:        { mode: "allow",   prefixes: ["S02", "S03"] },
  nasal:       { mode: "allow",   prefixes: ["R01"] },
  inhalant:    { mode: "allow",   prefixes: ["R03", "R07"] },
  vaginal:     { mode: "allow",   prefixes: ["G01", "G02", "G03C"] },
  rectal:      { mode: "allow",   prefixes: ["A06", "A07E", "C05", "G01", "D07"] },
  topical:     { mode: "allow",   prefixes: ["D", "M02", "N01B", "C05"] },
  transdermal: { mode: "allow",   prefixes: ["D", "M02", "N01B", "C05"] },
  buccal:      { mode: "allow",   prefixes: ["A01", "R02"] },
  sublingual:  { mode: "allow",   prefixes: ["A01", "R02", "C01"] },
  mucosal:     { mode: "allow",   prefixes: ["D", "M02", "C05"] },
  oral:        { mode: "exclude", prefixes: ["S01", "S02", "R01", "R02", "D", "G01", "G02", "M02", "B05X"] },
  injectable:  { mode: "exclude", prefixes: ["S01", "S02", "R01", "R02", "D", "G01", "M02"] },
};
```

**Safety valve:** If route filtering removes ALL candidate codes, the engine returns the unfiltered list instead of zero. This prevents pathological matrix gaps from producing empty results.

---

## 6. RxNav API (as used)

Base URL: `https://rxnav.nlm.nih.gov/REST`

### Endpoints in use (Mode 1)
| Endpoint | Used by |
|---|---|
| `/rxclass/class/byRxcui.json?rxcui={x}&relaSource=ATCPROD` | Strategy 1 |
| `/rxclass/class/byRxcui.json?rxcui={x}&relaSource=ATC` | Strategy 2 (ingredient ATCs) |
| `/rxcui/{x}/related.json?tty=DFG` | Strategy 2 (route resolution) |
| `/rxcui/{x}/property.json?propName=ATC` | Strategy 3, INGREDIENT_LEVEL path |
| `/rxcui/{x}/related.json?tty=IN` | `fetchIngredientRxcuis` for Level 5 promotion |
| `/rxclass/classMembers.json?classId={l4}&relaSource=ATC` | `resolveLevel5FromClassMembers` primary path |
| `/rxcui/{x}/properties.json` | Drug name + TTY display |
| `/rxclass/class/byId.json?classId={atc}` | Anatomy card class name enrichment (v7 fix: was `/rxclass/byId.json` and 404'ing silently) |
| `/drugs.json?name={name}` | Test fixture resolution (RXCUI from drug name) |
| `/rxclass/classMembers.json?classId={l4}&relaSource=ATCPROD` | Mode 3 primary member fetch |
| `/rxclass/classMembers.json?classId={l4}&relaSource=ATC` | Mode 3 fallback member fetch |
| `/ndcproperties.json?id={rxcui}` | Mode 4 + 5 — rich NDC metadata (labeler, packaging, marketing category, FDA approval) |

**API quirks discovered during the build (don't re-trip on these):**

1. `/rxclass/classMembers.json` is **L4-only**. L5 classId queries return 0 regardless of `relaSource`. Mode 3 (L5-only after v7) handles this by fetching the L4 parent and filtering members where the resolver returns the queried L5.
2. **ATCPROD vs ATC schemas differ.** ATCPROD members carry `nodeAttr.SourceId = the RXCUI itself` (no declared L5). ATC members carry `nodeAttr.SourceId = L5 ATC code`. Code that relies on declared L5 attribution only works for the ATC-source path.
3. `/rxclass/class/byId.json` returns `{}` for L5 classIds. L5 is modeled as a class-member attribute, not a class, in RxClass. So L5 entries in the anatomy/breadcrumb have no className from this endpoint — substance names come from `keptCode.name` on the resolver result instead.

### Rate limiting (as implemented)
- Token-bucket limiter, **15 req/sec global** ceiling (under NLM's documented 20 req/sec)
- Single `requests.Session` equivalent (browser fetch with connection reuse)
- Retry: 3 attempts with exponential backoff (1s, 2s, 4s) on 5xx/timeout
- 404 / empty response → cache as "no data" and continue (not a fatal error)

### Caching (as implemented)
- localStorage, four separate keys:
  - `medcode_cache_rxcui_v1` (drug name, TTY, DFGs per RXCUI)
  - `medcode_cache_ndc_v1` (NDC status + RXCUI mapping — currently unused; reserved)
  - `medcode_cache_atc_v1` (ATC class names + classMembers, keyed by classId; class-members sub-keyed by relaSource to keep ATCPROD and ATC results separate)
  - `medcode_cache_ndcprops_v1` (rich `/ndcproperties` records per RXCUI — Modes 4 + 5)
- 30-day TTL
- "Clear cache" button in footer wipes all four

### Property API parsing — documented gotcha
Response structure for `/property.json?propName=ATC`:
```json
{ "propConceptGroup": { "propConcept": [
  { "propCategory": "CODES", "propName": "ATC", "propValue": "R01AD08" }
] } }
```
**Correct parse:** Filter items where `propName === "ATC"`, read code from `propValue`. **Do NOT** filter on `propValue` starting with "ATC" — that's incorrect (propValue is the code itself).

---

## 7. UI Conventions (as built)

### Visual identity
- Modern, tech-forward, restrained. Not playful, not corporate-clinical.
- Card-based layout. Cards have 24px padding, 16px gap, 8px border-radius, 1px border.
- Generous whitespace.

### Colors (CSS variables in `styles.css`)
```
--accent:  #3B82F6   (saturated blue, brand)
--success: #10B981   (KEPT)
--error:   #EF4444   (REJECTED)
--warning: #F59E0B   (info/edge cases)
```

Light theme: white bg, dark text, subtle borders. Dark theme: near-black bg, near-white text. CSS vars flip via `[data-theme="dark"|"light"]` on `<html>`.

**Theme toggle (v7):** binary light ↔ dark only. The toggle button cycles between the two; system preference is read once on first visit (no localStorage value) to pick an initial theme, then the user's explicit choice persists. An inline `<head>` script syncs `data-theme` and `data-mode` onto `<html>` *before* body paints, so the page doesn't flash a wrong theme on load.

### Header / footer chrome
- Header: brand link (returns to Mode 1), theme toggle (sun ☀ / moon ☾), About link (`?mode=about`).
- Footer: explicit attribution — "Built by Netanel Greifner, MD MHA — Navina.ai" — then the RxNav data-source notice, Clear cache button, and version. Right-aligned version is pushed to the far edge via `.version { margin-left: auto; }`.

### Anatomy card uses five distinct level colors
- Level 1: purple (`#7c3aed`)
- Level 2: blue (`#3b82f6`)
- Level 3: teal (`#0d9488`)
- Level 4: green (`#10b981`)
- Level 5: amber (`#f59e0b`)

These intentionally diverge from the four-color status palette because the anatomy is hierarchical, not status-based.

### Typography
- System font stack
- Monospace for codes (RXCUI, ATC, NDC) — slightly larger than surrounding text
- Code anatomy visual segments at 28px (22px on mobile)

### Status visual cues
- Kept cards: green left border (4px), 8% green-tinted background
- Rejected cards: red left border (4px), 6% red-tinted background
- Ingredient info card: blue left border (4px), 8% blue-tinted background
- Anatomy card: card chrome, expanded by default, collapsible via ▼ chevron

### Icons
- Unicode glyphs for chevron (▼) and info (ⓘ)
- Unicode emojis for anatomical groups in anatomy card (🫁 ❤️ 🧠 👁️ etc.)
- No external icon library; the project is zero-dependency

### Accessibility
- `aria-label` on icon-only buttons
- `aria-live="polite"` on result area
- WCAG AA contrast minimum in both themes
- Visible focus styles
- Keyboard navigation: Tab, Enter, Esc

### Mobile (375px breakpoint)
- Modes 1 and 4 fully functional on mobile
- Input + button stack vertically
- Tab bar scrolls horizontally
- Cards reduce to 16px padding
- Anatomy code visual font shrinks to 22px

### Batch input UX (Modes 2 + 5, v7)
The "up to N RXCUIs" cap is a **separate label** above the textarea, not inside the placeholder. The textarea placeholder shows just example values (one per line). The cap label sits in `.batch-input-header` (`<h2 class="batch-input-title">` + `<p class="batch-input-hint">`), which keeps the cap visually prominent without crowding the input. Counter (`N / cap`) and Analyze button stay in the row below the textarea.

---

## 7b. About page

The About page is an in-app section (not a separate file) accessed via `?mode=about`. It's structured as a single scrollable doc with TOC + five sections: *What is this tool?*, *What do these codes mean?*, *How does it work?*, *Who is this for?*, *Limitations*. Section anchors work: `?mode=about#what-codes`, `#how-it-works`, etc.

- Hero + tab bar are hidden when `html[data-mode="about"]` (via CSS).
- Tone: educational, doc-style — closer to Stripe docs than to a SaaS marketing page.
- Section 2 uses four code-explainer cards (RXCUI / ATC / NDC / DFG), each with a colored top stripe, badge, glyph, example, and source attribution.
- Section 3 has a CSS-only vertical flow diagram with colored left-borders per step, plus three callouts underneath.
- All visuals are CSS-only — no SVG diagram libraries, no external assets.

The old `about.html` file is unused after v7; the header link routes to `?mode=about` instead.

---

## 8. Code Anatomy Card (Mode 1)

The anatomy card appears after each kept ATC card in Mode 1. It's an educational view of how the ATC code is structured.

### Components
- **Visual code segments:** the code split into five visual chunks, each color-coded by level (e.g., `R | 01 | A | D | 08`)
- **Per-level rows:** one row per level present in the code, with a colored connector, the level's code as a pill, a title (class name), and a sub-label ("Level N — {description}")
- **Completeness bar:** shows what fraction of the full 7-character code is filled in. 100% for Level 5 results.

### Async enrichment
On card render, all level titles are placeholder text. The card then fires async fetches to `/rxclass/byId.json?classId={code}` for levels 2-4 and patches each row's title in-place via `element.querySelector('[data-atc-title="N"]')`. Element-scoped queries (not document-scoped) ensure multiple anatomy cards on the same page enrich independently.

### Level 1 hardcoded
Anatomical groups (the 14 ATC Level 1 letters) are hardcoded in `ATC_LEVEL1` constant with emoji prefixes. No API call needed.

### Animation
Row reveals stagger at 80ms intervals. Creates a quick cascade effect when the card appears.

---

## 9. Explanation Templates (`explanations.js`)

All human-readable strings live here. Mode files never write strings inline.

### Categories
- **Route resolution:** "The drug's dose form group is {dfg}." / "Selected {dfg} as the highest-priority DFG. The most-specific local route wins over more general ones."
- **Kept:** "{atc} matches the {route} route (allowed prefix: {prefix})."
- **Rejected (allow mode):** "{atc} does not match the {route} route. The ATC anatomical group for {route} products is limited to {prefixes}. This code likely came from the ingredient's use in a different formulation."
- **Rejected (exclude mode):** "{atc} starts with {prefix}, which is reserved for local routes. A {route} product should not have this code."
- **Clinical context:** Looked up by `${route}_${atc_prefix}`. Examples:
  - `nasal_R03`: "This ingredient is also formulated as an asthma inhaler — but a nasal spray treats allergies, not asthma."
  - `ophthalmic_C07`: "This ingredient is also formulated as a cardiac beta blocker — but eye drops for glaucoma act locally on the eye."
  - `ophthalmic_H02`: "This ingredient is also formulated as a systemic steroid pill — but an eye drop acts locally."
- **Ingredient-level:** "Ingredient-level lookup — showing canonical Level 5 ATC code(s) for this substance. No route filtering applied since no specific dose form was given."
- **Error states:** "RXCUI {n} not found", "{input} doesn't look like an RXCUI", "Couldn't reach RxNav", etc.

---

## 10. Known Limitations

### Combination products
Drugs like Symbicort (R03AK07) work correctly when ATCPROD has them. If ATCPROD doesn't cover a specific combo, the engine may produce multiple Level 5 codes (one per component) rather than the combo code. Acceptable for v1.

### Pack codes (BPCK / GPCK)
Have RXCUIs but typically no DFG. The engine treats them like ingredients (returns all ATCs without route filtering). Reasonable behavior — packs span multiple administration routes by definition.

### Drugs with legitimate multi-route ATC
Some drugs are correctly assigned to multiple anatomical groups in WHO ATC. The matrix is a strong heuristic, not perfect ground truth. The disclaimer in the footer covers this.

### Newer drugs
ATCPROD coverage is ~97% of Medicare Part-D drugs but lower for very new or rare drugs. The DFG-filter fallback (Strategy 2) catches these in most cases.

### NDC freshness
When Modes 4/5 are built: the active/obsolete distinction is RxNorm's view as of its last monthly release. Just-approved FDA NDCs may not appear.

---

## 11. Test Fixtures

`js/test-fixtures.js`. Fixtures use **drug names**, not RXCUIs. The test runner resolves names to current RXCUIs via `/drugs.json?name={name}` at setup time, so fixtures survive RxNorm release changes.

### Verified scenarios (all Mode 1 working)
- Multi-route ingredient with route filtering: fluticasone nasal spray → R01AD08 (Strategy 2, filters out D07AC17/R03BA05)
- Ingredient-level lookup: fluticasone IN → three kept codes (D07AC17, R01AD08, R03BA05), no rejections
- Strategy 1 ATCPROD hit: atorvastatin oral → C10AA05 (no rejections, no parallel route)
- Strategy 1 ATCPROD with parallel rejection: timolol ophthalmic → S01ED01 kept, C07AA rejected with clinical context
- Other ingredients: metformin IN → A10BA02, aminophylline IN → R03DA05
- RXCUI not found: 999999999 → error card
- Invalid input: "asdf" → format-validation error card before any fetch fires

### Combination scenarios (verified against live RxNav)
- **Curated-catalog L5 — HCTZ + valsartan**: **RxCUI 200284** → `KEEP`, codes `[C09DA03]` ("valsartan and diuretics") via the Navina-curated combination catalog. WHO defines C09DA03 but no RxNav surface exposes it (exhaustively probed). The catalog match keys on the exact RxNorm IN ingredient set `{hydrochlorothiazide, valsartan}`. Same path catches RxCUI 999967 (3-ingredient combo) → `[C09DX03]`, RxCUI 724598 (Sinemet) → `[N04BA02]`, RxCUI 197885 (lisinopril+HCTZ) → `[C09BA03]`.
- **MIN-property L5 bypass — Epclusa**: **RxCUI 1799213** (Epclusa, BN) and the SCD/pellet variants (1799212 / 2584199 / 2584201 / 2584196) → `KEEP`, codes `[J05AP55]`, via MIN 1799211's `/property.json?propName=ATC`. classMembers for J05AP exposes no L5; ATCPROD only gives J05AP; byId for J05AP55 is empty. The MIN's RxNorm property is the only public surface that carries J05AP55, and Rule 2 of `withCombination` reaches it. `minProvenance` is stamped on the result envelope; Mode 1 surfaces the provenance line on the kept card.
- **MIN-property L5 (used to be Pass-2)**: **RxCUI 151399** (Bactrim, sulfa + TMP) → `KEEP`, `[J01EE01]` via MIN 10831. **RxCUI 1602115** (Glyxambi, linagliptin + empagliflozin) → `KEEP`, `[A10BD19]` via MIN 1598392. Both used to resolve via Pass-2 MIN-equality; after Phase 2B they resolve a step earlier via Rule 2 (same answer, simpler provenance).
- **Same-family combination, no L5 reachable**: **RxCUI 200284** (HCTZ 12.5 / valsartan 80 oral) → `COMBINATION_NO_DEDICATED_CODE`, codes `[C09DA]`. MIN 214626's property API is empty (confirmed live), classMembers for C09DA returns 0 under relaSource=ATC, ATCPROD only gives L4 → fall through to Rule 3. WHO defines C09DA01; genuinely not reachable. Ingredients: HCTZ → C03AA03, valsartan → C09CA03.
- **Three-ingredient combination, no L5 reachable**: **RxCUI 999967** (amlodipine + HCTZ + olmesartan) → `COMBINATION_NO_DEDICATED_CODE`, codes `[C09DX]`. MIN 1008801's property API is empty → Rule 3 fallback.
- **Partial-coverage escalation (no MIN-property L5 either)**: **RxCUI 901814** (Advil PM = diphenhydramine + ibuprofen) → `COMBINATION_NO_DEDICATED_CODE`, codes `[M01AE]`. MIN 644895's property API is empty, so the Phase-2B bypass doesn't fire; Strategy 1 returns M01AE01 (ibuprofen mono); `shouldEscalateToCombinationNoCode` detects M01AE01 ∈ ibuprofen.codes → Rule 4 escalation to L4 M01AE. Ingredients: diphenhydramine → R06AA02, ibuprofen → C01EB16, M01AE01, R02AX02.
- **Retired/invalid**: **RxCUI 859038** → `props.found = false` → "RXCUI not found" error card (existing behavior, untouched).

### Regression baseline (all unchanged through every combination revision)
- RxCUI 1797907 (fluticasone nasal) → `KEEP`, codes `[R01AD08]`, no combination context.
- RxCUI 617310 (atorvastatin oral) → `KEEP`, codes `[C10AA05]`, no combination context.
- RxCUI 2107616 (Inbrija inhaled levodopa) → `KEEP`, codes `[N04BA01]`, no combination context.

---

## 12. Disclaimer (in footer, verbatim)

> **MedCode Lookup** is a validation and exploration tool, not a clinical decision support system. Results are derived from public RxNorm data and a curated route-classification heuristic. The mapping logic may produce false positives or false negatives, particularly for combination products, ingredient-level concepts, and drugs with legitimate cross-route ATC assignments. Always verify results against authoritative sources (WHO ATC, RxNorm, FDA NDC Directory) before use in production systems. Not for use in patient care decisions.

> Data source: NIH RxNav API. Independent project, not endorsed by NIH, NLM, WHO, or FDA.

---

## 13. How to Extend

### Adding a new route to the matrix
1. Add the DFG → route mapping to `DFG_ROUTE_MAP`
2. Add the DFG to `DFG_PRIORITY` at the correct precedence (local routes beat broader ones)
3. Add to `ROUTE_ATC_MATRIX` with allow/exclude mode and prefixes
4. Add clinical context strings to `explanations.js` if applicable (`${route}_${prefix}`)
5. Add a test fixture
6. Update this CLAUDE.md if behavior is non-obvious

### Adding a new mode
1. Create `js/modes/modeN-{name}.js`
2. Import from `atc-resolver`, `rxnav-client`, `explanations`, `ui-components`
3. NEVER call `fetch()` directly; NEVER write inline explanation strings
4. Add tab routing in `app.js`
5. Document the mode contract in Section 3 of this file

### Refining the matrix
1. Document the failing fixture (drug, expected verdict, actual verdict)
2. Decide: matrix bug or genuine ambiguity?
3. Fix or comment the limit
4. Update the fixture's expected outcome
5. Re-run all fixtures (regression check)

---

## 14. Quick Reference

| Task | Where to look |
|---|---|
| Why was RXCUI X mapped to ATC Y? | `atc-resolver.js` → strategy logs |
| Why was code X rejected? | `filter-engine.js` → `filterAtcByRoute` |
| DFG priority order | Section 5 |
| Mode contracts | Section 3 |
| RxNav endpoint list | Section 6 |
| Property API parsing gotcha | Section 6 |
| Anatomy card behavior | Section 8 |
| Explanation templates | `explanations.js`, Section 9 |
| Test fixtures | `js/test-fixtures.js`, Section 11 |
| Add a new route | Section 13 |
| Add a new mode | Section 13 |
