// CSV export that mirrors the on-screen table. FindingsTable passes the exact
// visible columns in display order as { header, get } pairs, so the file is a
// 1:1 copy of the page (host names and metric cells already use the same
// resolved/formatted strings the table renders).

/** Quote a field containing a comma, quote, or newline, and neutralize
 *  spreadsheet formula injection: Excel/Sheets read a cell starting with
 *  `= + - @` (or tab/CR) as a formula, so a value like `-2%/d` errors with
 *  `#NAME?`. A leading single quote forces text. */
function csvEscape(value: string): string {
  let v = value;
  if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

export interface CsvColumn<T> {
  header: string;
  get: (row: T) => string;
}

export function tableToCsv<T>(columns: Array<CsvColumn<T>>, rows: T[]): string {
  const lines: string[] = [];
  lines.push(columns.map((c) => csvEscape(c.header)).join(","));
  for (const row of rows) {
    lines.push(columns.map((c) => csvEscape(c.get(row) ?? "")).join(","));
  }
  return lines.join("\n");
}

// AppEngine's sandboxed iframe lacks `allow-downloads`, which Firefox enforces
// strictly: an `<a download>` click on a Blob URL is blocked. Chromium/Safari
// allow it. So Firefox instead opens the Blob in a new tab (top-level windows
// escape the parent sandbox) and the user saves from there.
function isFirefox(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Firefox\//i.test(navigator.userAgent);
}

export function downloadCsv(filename: string, content: string): void {
  // Leading BOM so Excel reads it as UTF-8.
  const blob = new Blob(["﻿" + content], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);

  if (isFirefox()) {
    try {
      window.open(url, "_blank", "noopener");
    } catch (err) {
      console.error("downloadCsv: window.open fallback failed", err);
    }
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return;
  }

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
