/** RFC-style CSV parsing with double-quote escapes. */
export function parseCsv(text: string): string[][] {
  // Some Excel exports include a UTF-8 BOM; strip it so header matching works.
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }

  // Excel exports sometimes use `;` depending on locale. Heuristic: pick the
  // delimiter with the higher count in the first non-empty line.
  const firstLine = (() => {
    const idx = text.search(/\S/);
    if (idx < 0) {
      return '';
    }
    const end = text.indexOf('\n', idx);
    return (end === -1 ? text.slice(idx) : text.slice(idx, end)).replace(/\r/g, '');
  })();
  const commaCount = (firstLine.match(/,/g) ?? []).length;
  const semiCount = (firstLine.match(/;/g) ?? []).length;
  const delimiter = semiCount > commaCount ? ';' : ',';

  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let i = 0;
  let inQuotes = false;

  while (i < text.length) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cur += c;
      i += 1;
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === delimiter) {
      row.push(cur);
      cur = '';
      i += 1;
      continue;
    }
    if (c === '\r') {
      i += 1;
      continue;
    }
    if (c === '\n') {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = '';
      i += 1;
      continue;
    }
    cur += c;
    i += 1;
  }
  row.push(cur);
  if (row.length > 1 || (row.length === 1 && row[0] !== '')) {
    rows.push(row);
  }
  return rows;
}
