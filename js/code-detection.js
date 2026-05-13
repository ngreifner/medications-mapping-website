// code-detection.js — detect whether pasted input is RXCUI, ATC, or NDC.
// Used in two places:
//   1. Auto-switch banner when user pastes wrong type in current mode
//   2. Batch input validation to filter malformed lines before fetching

// ATC structure:
//   Level 1: one letter           e.g. "A"
//   Level 2: letter + 2 digits    e.g. "A10"
//   Level 3: + 1 letter           e.g. "A10B"
//   Level 4: + 1 letter           e.g. "A10BA"
//   Level 5: + 2 digits           e.g. "A10BA02"
const ATC_RE = /^[ABCDGHJLMNPRSV](\d{2}([A-Z]([A-Z](\d{2})?)?)?)?$/;

// NDC: hyphenated 10/11-digit formats or pure 10/11-digit run.
const NDC_HYPHENATED_RE = /^\d{4,5}-\d{3,4}-\d{1,2}$/;
const NDC_DIGITS_RE = /^\d{10,11}$/;

// RXCUI: pure numeric, 1-8 digits (RxNav RXCUIs fit comfortably in 7).
const RXCUI_RE = /^\d{1,8}$/;

export function atcLevel(atc) {
  const s = (atc || "").trim().toUpperCase();
  if (!ATC_RE.test(s)) return null;
  switch (s.length) {
    case 1: return 1;
    case 3: return 2;
    case 4: return 3;
    case 5: return 4;
    case 7: return 5;
    default: return null;
  }
}

export function detectCodeType(input) {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return { type: "UNKNOWN", value: "" };

  const upper = trimmed.toUpperCase();

  // ATC check first — ATC codes start with a letter so they can't collide with NDC/RXCUI.
  if (ATC_RE.test(upper)) {
    return { type: "ATC", value: upper, level: atcLevel(upper) };
  }

  // NDC: hyphenated form, or 10/11-digit numeric. The 10/11-digit form would
  // also match RXCUI's broader regex, so check NDC first when length is 10-11.
  if (NDC_HYPHENATED_RE.test(trimmed)) {
    return { type: "NDC", value: trimmed };
  }
  if (NDC_DIGITS_RE.test(trimmed)) {
    // Ambiguous between a long RXCUI and an NDC. RXCUIs of 10-11 digits are
    // exceedingly rare in practice (current RxNav IDs are 7 digits), so we
    // prefer NDC here. The auto-switch banner gives users the escape hatch.
    return { type: "NDC", value: trimmed };
  }

  if (RXCUI_RE.test(trimmed)) {
    return { type: "RXCUI", value: trimmed };
  }

  return { type: "UNKNOWN", value: trimmed };
}
