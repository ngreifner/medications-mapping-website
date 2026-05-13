// csv-export.js — tiny CSV writer + browser download trigger.
// Shared by Mode 2 (batch RXCUI) and (eventually) Mode 5 (batch NDC).
//
// rows = [[header1, header2, ...], [val1, val2, ...], ...]
// Strings are escaped per RFC 4180: fields containing comma / quote / newline
// are wrapped in double quotes; embedded quotes are doubled.

function quoteField(v) {
  const s = v == null ? "" : String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function rowsToCsv(rows) {
  return rows.map(r => r.map(quoteField).join(",")).join("\r\n");
}

export function downloadCsv(filename, rows) {
  const csv = rowsToCsv(rows);
  // BOM so Excel reads UTF-8 cleanly
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
