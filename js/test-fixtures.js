// test-fixtures.js, reference codes for smoke testing the filter engine.
//
// Fixtures are anchored by drug NAME, not RXCUI. The RXCUI column was resolved
// via /approximateTerm.json against the recorded name; to regenerate after a
// RxNorm release, run `node scratch/regen-fixtures.js` and paste the output.

export const TEST_CASES_RXCUI = [
  // CLEAN_FIX expected, ingredient maps to multiple ATCs, route filter keeps one
  { rxcui: "1797907", name: "fluticasone propionate 0.05 MG/ACTUAT Metered Dose Nasal Spray", expectedRoute: "nasal",      expectedKeptStartsWith: "R01" },
  { rxcui: "2702393", name: "timolol hemihydrate 5 MG/ML Ophthalmic Solution",                expectedRoute: "ophthalmic", expectedKeptStartsWith: "S01" },
  { rxcui: "861204",  name: "brimonidine tartrate 1 MG/ML Ophthalmic Solution",               expectedRoute: "ophthalmic", expectedKeptStartsWith: "S01" },
  { rxcui: "1745091", name: "LIDOCAINE 50 mg CUTANEOUS PATCH",                                expectedRoute: "topical",    expectedKeptStartsWith: "D"   },
  { rxcui: "1291082", name: "hydrocortisone acetate 25 MG Rectal Suppository",                expectedRoute: "rectal",     expectedKeptStartsWith: "C05" },
  { rxcui: "992780",  name: "miconazole nitrate 100 MG Vaginal Insert",                       expectedRoute: "vaginal",    expectedKeptStartsWith: "G01" },
  { rxcui: "1797929", name: "budesonide 0.032 MG/ACTUAT Metered Dose Nasal Spray",            expectedRoute: "nasal",      expectedKeptStartsWith: "R01" },
  { rxcui: "848956",  name: "ciprofloxacin 0.2 % Otic Solution",                              expectedRoute: "otic",       expectedKeptStartsWith: "S02" },

  // UNCHANGED expected, systemic-only mapping
  { rxcui: "617310",  name: "atorvastatin 20 MG Oral Tablet",                                 expectedRoute: "oral",       expectedKeptStartsWith: "C10" },
  { rxcui: "314076",  name: "LISINOPRIL 10 mg ORAL TABLET",                                   expectedRoute: "oral",       expectedKeptStartsWith: "C09" },
  { rxcui: "197361",  name: "amlodipine 5 MG Oral Tablet",                                    expectedRoute: "oral",       expectedKeptStartsWith: "C08" },

  // PIN-attributed L5: clorazepate dipotassium is a salt form whose L5 sits
  // on the PIN concept (RxCUI 2607) instead of the bare IN (2353). Without
  // the IN+PIN union in resolveLevel5FromClassMembers, this falls through
  // to the L4 fallback (N05BA only). With the fix it resolves to N05BA05.
  { rxcui: "197464",  name: "clorazepate dipotassium 15 MG Oral Tablet",                      expectedRoute: "oral",       expectedKeptStartsWith: "N05BA" },

  // Other route resolutions
  { rxcui: "630208",  name: "albuterol 0.83 MG/ML Inhalation Solution",                       expectedRoute: "inhalant",   expectedKeptStartsWith: "R03" },
  { rxcui: "283504",  name: "ondansetron 2 MG/ML Injectable Solution",                        expectedRoute: "injectable" },

  // INGREDIENT_LEVEL, TTY=IN, no route resolvable
  { rxcui: "41126",   name: "fluticasone",                                                    expectedVerdict: "INGREDIENT_LEVEL" },
  { rxcui: "10600",   name: "timolol",                                                        expectedVerdict: "INGREDIENT_LEVEL" },
];

export const TEST_CASES_ATC = [
  { atc: "R01AD", level: 4, expectedExpansion: true },
  { atc: "S01ED", level: 4, expectedExpansion: true },
];

export const TEST_CASES_NDC = [
  { input: "00781-0001-01", expectedNorm: "00781000101" },
  { input: "0078100010",    expectedNorm: "00781000101" }, // ambiguous 10-digit
  { input: "00781000101",   expectedNorm: "00781000101" },
  { input: "asdf",          expectedValid: false },
];
