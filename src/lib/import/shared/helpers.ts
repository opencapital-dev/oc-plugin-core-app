export function normKey(h: string): string {
  return h
    .replace(/^﻿/, '')
    .trim()
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\s+/g, ' ');
}

export function parseNum(s: string): number | null {
  const t = s.trim().replace(/,/g, '');
  if (!t) {
    return null;
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function pick(row: Record<string, string>, aliases: string[]): string {
  for (const a of aliases) {
    const v = row[normKey(a)];
    if (v !== undefined && v !== '') {
      return v;
    }
  }
  return '';
}

export function rowsToObjects(rows: string[][]): Array<Record<string, string>> {
  if (rows.length === 0) {
    return [];
  }
  const headers = rows[0]!.map((h) => h.trim());
  const keys = headers.map(normKey);
  const out: Array<Record<string, string>> = [];
  for (let r = 1; r < rows.length; r += 1) {
    const cells = rows[r]!;
    const o: Record<string, string> = {};
    for (let c = 0; c < keys.length; c += 1) {
      o[keys[c]!] = (cells[c] ?? '').trim();
    }
    out.push(o);
  }
  return out;
}

export function rowToObj(headerCols: string[], cells: string[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (let i = 0; i < headerCols.length; i += 1) {
    o[normKey(headerCols[i]!)] = (cells[i] ?? '').trim();
  }
  return o;
}

export function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/** UTC date key (YYYY-MM-DD) for a microsecond timestamp. */
export function dayKeyUtc(tsMicros: number): string {
  return new Date(tsMicros / 1000).toISOString().slice(0, 10);
}

/** UTC end-of-day micros for a YYYY-MM-DD key. */
export function endOfDayMicros(dayKey: string): number {
  return Date.parse(`${dayKey}T23:59:59Z`) * 1000;
}
