// ndc-normalizer.js — convert any NDC format to 11-digit no-hyphens (HIPAA canonical).
//
// Accepted inputs (per CLAUDE.md Section 5):
//   00781-0001-01    10-digit 4-4-2
//   00781-001-01     10-digit 5-3-2
//   00781-0001-1     10-digit 5-4-1
//   0078100010       10-digit no-hyphens (ambiguous segmentation)
//   00781-00010-01   11-digit hyphenated 5-4-2
//   00781000101      11-digit no-hyphens ← target
//
// Padding rule (HIPAA): always insert a leading zero into the segment that's
// short of the 5-4-2 standard.
//   4-4-2 → pad labeler segment to 5      (0XXXX-YYYY-ZZ)
//   5-3-2 → pad product segment to 4      (XXXXX-0YYY-ZZ)
//   5-4-1 → pad package segment to 2      (XXXXX-YYYY-0Z)

export function normalizeNdc(input) {
  const raw = (input ?? "").trim();
  if (!raw) {
    return { valid: false, error: "Empty NDC." };
  }

  const digits = raw.replace(/[\s-]/g, "");
  if (!/^\d+$/.test(digits)) {
    return { valid: false, error: `"${raw}" contains non-digit characters.` };
  }
  if (digits.length !== 10 && digits.length !== 11) {
    return { valid: false, error: `NDC must be 10 or 11 digits; got ${digits.length}.` };
  }

  // Already 11 digits: canonical or hyphenated 11-digit form.
  if (digits.length === 11) {
    return {
      valid: true,
      normalized: digits,
      originalFormat: raw.includes("-") ? detectHyphenFormat(raw) : "11-digit no-hyphens",
      input: raw,
    };
  }

  // 10 digits.
  if (raw.includes("-")) {
    const segs = raw.split("-");
    if (segs.length === 3) {
      const [a, b, c] = segs;
      if (a.length === 4 && b.length === 4 && c.length === 2) {
        return ok(`0${a}${b}${c}`, "10-digit 4-4-2", raw);
      }
      if (a.length === 5 && b.length === 3 && c.length === 2) {
        return ok(`${a}0${b}${c}`, "10-digit 5-3-2", raw);
      }
      if (a.length === 5 && b.length === 4 && c.length === 1) {
        return ok(`${a}${b}0${c}`, "10-digit 5-4-1", raw);
      }
      // Some labelers ship 4-3-2 or other variants. Fall through to disambiguation
      // by digit count below.
    }
  }

  // 10 digits, no hyphens — segmentation is ambiguous. Default to assuming the
  // labeler is the short segment (4-4-2 → pad first), which is the most common
  // case for old-style FDA NDCs. Surface the assumption to the caller so the UI
  // can show "Normalized X → Y. If wrong, enter with hyphens."
  return {
    valid: true,
    normalized: `0${digits}`,
    originalFormat: "10-digit no-hyphens (ambiguous)",
    ambiguous: true,
    note: `Assumed 4-4-2 segmentation. If the labeler segment was 5 digits, re-enter with hyphens.`,
    input: raw,
  };
}

function ok(normalized, originalFormat, input) {
  return { valid: true, normalized, originalFormat, input };
}

function detectHyphenFormat(raw) {
  const segs = raw.split("-");
  if (segs.length !== 3) return "11-digit hyphenated";
  return `11-digit hyphenated ${segs.map((s) => s.length).join("-")}`;
}
