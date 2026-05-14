# ATC Resolution Logic — How MedCode Lookup gets to Level 5

This document describes the live behavior of [js/atc-resolver.js](../js/atc-resolver.js) and [js/rxnav-client.js](../js/rxnav-client.js). It does not propose changes; it explains what the engine does today.

## The endpoints in play

| Endpoint | Wrapper | Returns |
|---|---|---|
| `/rxclass/class/byRxcui.json?rxcui={x}&relaSource=ATCPROD` | `getAtcprodClasses` | Product-level ATC classes — usually **Level 4** (5 chars), curated by NLM with route built in |
| `/rxclass/class/byRxcui.json?rxcui={x}&relaSource=ATC` | `getIngredientAtcClasses` | Ingredient-level ATC classes — a mix of **Level 4 and Level 5** for every formulation the ingredient appears in |
| `/rxcui/{x}/property.json?propName=ATC` | `getAtcPropertyValues` | String list of ATC codes attached directly as RxNorm properties — codes only, no names |
| `/rxclass/classMembers.json?classId={l4}&relaSource=ATC` | `getClassMembers` | Drug members of an ATC L4 class; each member carries `nodeAttr.SourceId` = the **Level 5** code |
| `/rxcui/{x}/related.json?tty=IN` | `getIngredientRxcuis` | The RXCUI's ingredient RXCUIs (used to match the right member inside `classMembers`) |

The engine does **not** use the `rela=` query parameter (`ATC_INGREDIENT`, `isa_disposition_of`, etc.). Differentiation is entirely by `relaSource` (`ATC` vs `ATCPROD`). That's why both endpoints in row 1+2 above are the *same URL path* — only `relaSource` differs.

## When does `byRxcui` return Level 5 directly?

- **`relaSource=ATCPROD`** — practically never. ATCPROD is curated at L4 (the route-aware product class). Treat it as L4-only in the resolver.
- **`relaSource=ATC`** — sometimes. For ingredients, RxClass exposes ATC at both L4 and L5; the response mixes both. The resolver simply filters by `classId.length === 7` to grab the L5 entries, and falls back to L4 promotion when no L5 is present.

In code: [atc-resolver.js:220-234](../js/atc-resolver.js#L220-L234) filters `atcList` by `length === 7` for the L5 path, and by `length === 5` for the L4 → L5 promotion path.

## When is `classMembers` used?

`classMembers` is called only via the helper `resolveLevel5FromClassMembers(rxcui, level4ClassIds)` ([atc-resolver.js:38-76](../js/atc-resolver.js#L38-L76)). It is the **L4 → L5 promotion mechanism**. It is triggered whenever a strategy hands the resolver an L4 set and no L5 is in hand yet:

1. **Strategy 1 always** — ATCPROD returns L4; promotion is mandatory to display anything user-facing (we never show L4 in the UI except as a last-resort fallback).
2. **Strategy 2 conditionally** — ingredient ATC L5 list is empty but L4 list isn't. Apply the route filter to L4, then promote.
3. **Strategy 3 conditionally** — property API returned only L4 codes (rare).

The helper has two internal phases:

- **Primary**: for each L4, fetch its `classMembers` (using `relaSource=ATC`), find a member whose RXCUI matches the input's ingredient RXCUIs, and read `nodeAttr.SourceId` (L5) and `SourceName`.
- **Fallback**: if the primary returns nothing, query each ingredient RXCUI's ATC classes and pick the L5 codes whose value starts with one of the target L4 prefixes.

`classMembers` is **skipped entirely** for INGREDIENT_LEVEL inputs (TTY=IN/MIN/PIN) — those return ATC codes directly from the property API with no route filtering, because no specific dose form exists ([atc-resolver.js:148-156](../js/atc-resolver.js#L148-L156)).

## The three strategies (in `convertRxcuiToAtc`)

All four data sources fire **in parallel** at the top of the function. Then strategies are tried in order:

| # | Strategy | Trigger | Success path | classMembers? |
|---|---|---|---|---|
| 1 | ATCPROD | `atcprodClasses.length > 0` | L4 → `resolveLevel5FromClassMembers` → L5 | **Always** for L4 promotion |
| 2 | Ingredient ATC + route filter | Strategy 1 produced no L5 | Filter L5 directly by route → return; else filter L4 by route and promote | **Conditional** — only when L4 path is taken |
| 3 | Property API | Strategies 1 and 2 both failed | Filter L5 codes by route → return; else filter L4 and promote | **Conditional** — same as Strategy 2 |

If every L5 path fails but ATCPROD returned L4, those L4 codes ship as a last-resort fallback (UI marks them).

The ATCPROD prefix list also acts as a **whitelist** for Strategies 2 and 3. This prevents combination drugs (e.g. R03AL) from being replaced by unrelated single-ingredient codes (e.g. R03BA02) for the same ingredient.

## Three worked examples

### 1797907 — fluticasone nasal spray (TTY=SCD)

1. Not an ingredient TTY → run strategies.
2. ATCPROD typically empty for this nasal SCD → Strategy 1 doesn't fire.
3. Strategy 2: ingredient ATC byRxcui returns a **mixed L4+L5 list** for fluticasone (D07AC17, R01AD08, R03BA05, plus L4 ancestors).
4. Filter by route `nasal` (`allow: ["R01"]`) → **R01AD08** kept.
5. Returned with `rejectedL4 = [D07AC, R03BA]`, no classMembers call needed.

Net: **no classMembers call**. Strategy 2 short-circuits on the L5 path.

### 41126 — fluticasone (TTY=IN)

1. Ingredient guard hits at [atc-resolver.js:149](../js/atc-resolver.js#L149).
2. `getAtcPropertyValues` → ["D07AC17", "R01AD08", "R03BA05"].
3. All three returned as kept with status `INGREDIENT_LEVEL` and `rejectedL4: []`.

Net: **one endpoint call total**. Neither byRxcui nor classMembers fires.

### 2107616 — levodopa 42 MG Inhalation Powder (Inbrija) (TTY=SCD)

1. Not an ingredient → run strategies.
2. Strategy 1: ATCPROD hit. NLM has curated this product to **N04BA** at L4 — a nervous-system class, not respiratory — because the clinical intent is Parkinson's.
3. `resolveLevel5FromClassMembers(2107616, ["N04BA"])` is called. It fetches `classMembers` for N04BA, finds the member whose RXCUI matches the levodopa ingredient set, reads `SourceId = "N04BA01"`.
4. The kept list ships with a `routeOverride` flag because the route matrix would have rejected N04 for an inhalant — that flag drives the italic note on the kept card and the dedup of the rejected L4.

Net: **classMembers is essential here.** It's the only path that gets us from N04BA to N04BA01 for this specific drug.

### Brand-new SBD (illustrative)

A just-approved branded product that hasn't propagated to ATCPROD yet: Strategy 1 returns nothing → Strategy 2 runs against the ingredient's ATC. If the ingredient is well-known, ingredient ATC returns L5 directly and classMembers isn't needed. If the ingredient is itself novel, Strategy 2 may have only L4 → classMembers promotion fires. If even that comes back empty, Strategy 3's property API is the last chance.

## Where is `classMembers` essential vs redundant?

**Essential:**

- Every Strategy 1 success (ATCPROD never gives L5 directly).
- Strategy 2 / 3 when the ingredient route happens to return only L4 codes (rare for major drugs, common for novel ones).
- Drugs where the curated L4 covers many ingredients (e.g., N04BA contains levodopa, levodopa+carbidopa, etc.) — only `classMembers` + the input's ingredient set picks the right L5.

**Redundant in practice:**

- Cases where ingredient ATC already returns L5 directly. The engine still runs Strategy 1 first (cheaper to try than to gate on), but the classMembers call only happens if Strategy 1 succeeded.
- The fallback inside `resolveLevel5FromClassMembers` (the "query ingredient ATC classes" branch) duplicates what Strategy 2 will compute later. It exists because it can succeed when the primary classMembers walk returns nothing.

## Where could the engine be simplified?

- **Strategy 3 (property API)** rarely adds coverage beyond Strategies 1+2. It exists as a defensive last resort and could probably be removed without affecting the test fixtures — but it has zero marginal cost since the call is launched in parallel.
- **The two-phase classMembers helper** could be collapsed if we always trusted the ingredient-ATC fallback — but the primary path is preferred because it directly attributes the L5 to the input RXCUI's ingredient, whereas the fallback returns any L5 in the prefix range.

## Where is the complexity necessary?

- **ATCPROD vs ATC** — two genuinely different curations. ATCPROD encodes NLM's clinical-intent decisions (e.g., inhaled levodopa → nervous system), which the ingredient-level ATC view doesn't surface.
- **L4 → L5 promotion** — RxClass exposes L4 as a class and L5 as a class-*member* attribute. There is no direct "give me L5 for this RXCUI" endpoint; the promotion step is structural to the API.
- **INGREDIENT_LEVEL early exit** — DFGs for ingredient RXCUIs aggregate every formulation the ingredient appears in, so route resolution is meaningless. Skipping the matrix is correct, not a shortcut.
- **ATCPROD prefix whitelist** — protects combination products from being downgraded to single-ingredient L5 codes by Strategies 2/3.
