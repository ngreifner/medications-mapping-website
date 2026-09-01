/**
 * Frozen from the 100-row stratified correctness sample adjudicated 2026-09-01
 * against the live WHO ATC/DDD index. See
 * docs/superpowers/specs/2026-09-01-atc-defect-repair-design.md §2.
 */

/** Rows proven CORRECT. A repair pass that changes any of these is a regression. */
export const MUST_NOT_CHANGE = [
  { rxcui: "197940",  atc: "S01EC05", why: "methazolamide oral tablet — WHO files oral carbonic anhydrase inhibitors under S01EC" },
  { rxcui: "849506",  atc: "H01BA02", why: "desmopressin nasal spray — systemic hormone, no nasal code" },
  { rxcui: "1049670", atc: "R01BA02", why: "oral pseudoephedrine — WHO codes it as a nasal decongestant for systemic use" },
  { rxcui: "250494",  atc: "N02BE01", why: "paracetamol rectal suppository — rectal is an alternate systemic route" },
  { rxcui: "238004",  atc: "G03CA03", why: "estradiol transdermal system — systemic hormone via skin" },
  { rxcui: "2612684", atc: "S01LA04", why: "ranibizumab intravitreal — RxNorm tags only Injectable Product" },
  { rxcui: "197844",  atc: "D10BA01", why: "isotretinoin oral capsule — WHO oral acne class" },
  { rxcui: "1053658", atc: "N02AB03", why: "fentanyl sublingual — systemic opioid" },
  { rxcui: "753442",  atc: "N06BA04", why: "methylphenidate transdermal — systemic CNS stimulant" },
  { rxcui: "1047908", atc: "A03BA03", why: "hyoscyamine sublingual — systemic antispasmodic" },
  { rxcui: "1940709", atc: "J05AP57", why: "Mavyret — correct dedicated combination code already present" },
  { rxcui: "1092373", atc: "N02BE51", why: "paracetamol+diphenhydramine — correct single combination code already present" },
];

/** Rows proven WRONG, with the WHO-verified correct answer. */
export const MUST_FIX = [
  // D1 rows repaired by Task 5's pass1-combos.mjs sweep (2026-09-01, applied):
  // `current` now equals `expected` -- these three are frozen as MUST_NOT_CHANGE-style
  // regression checks (repaired), not MUST_FIX-pending anymore. Kept in this list
  // (rather than moved to MUST_NOT_CHANGE) because currentAtcOf reads only rxcui/atc
  // on MUST_NOT_CHANGE records and rxcui/current on MUST_FIX records; changing shape
  // isn't needed for the fixture to be internally consistent.
  { rxcui: "1010755", current: "N01BB52", expected: "N01BB52", defect: "D1" },
  { rxcui: "209971",  current: "N01BA53", expected: "N01BA53", defect: "D1" },
  { rxcui: "1360383", current: "A10AD05", expected: "A10AD05", defect: "D1" },
  { rxcui: "1146022", current: "A12CA01|B05BB01|B05CB01|B05XA03|S01XA03", expected: "R01AX10", defect: "D2" },
  { rxcui: "1242779", current: "A12CA01|B05BB01|B05CB01|B05XA03|S01XA03", expected: "R01AX10", defect: "D2" },
  { rxcui: "212740",  current: "D08AG02|D09AA09|D11AC06",                  expected: "G01AX11", defect: "D2" },
  { rxcui: "259021",  current: "G01AD01",                                  expected: "",        defect: "D2" },
  { rxcui: "1291292", current: "A01AC03|A07EA02|D07AA02|D07AB02|D07AB11|H02AB09|S01BA02", expected: "C05AA01", defect: "D3" },
];

/** Reads the live table and returns the current ATC cell for an rxcui. */
export function currentAtcOf(tableRows, rxcui) {
  const row = tableRows.find((r) => r.rxcui === rxcui);
  return row ? row.atc : null;
}
