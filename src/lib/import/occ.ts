// TS mirror of lib/finance/occ.py. Both implementations MUST emit the same
// canonical_id for the same input — re-uploads must yield identical
// instrument_id.

export type OptionType = 'C' | 'P';

export type OccParts = {
  underlying: string;
  expiry: Date;
  strike: number;
  optionType: OptionType;
  canonicalId: string;
};

const MONTHS: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

const MONTH_NAMES = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

const OCC_RE = /^\s*([A-Z][A-Z0-9.]*)\s+(\d{1,2})([A-Z]{3})(\d{2})\s+(\d+(?:\.\d+)?)\s+([CP])\s*$/;

export function parseOcc(s: string): OccParts {
  const m = OCC_RE.exec(s.toUpperCase());
  if (!m) {
    throw new Error(`not an OCC ticker: ${JSON.stringify(s)}`);
  }
  const [, underlying, dayStr, monName, yyStr, strikeStr, otype] = m;
  const mon = MONTHS[monName];
  if (mon === undefined) {
    throw new Error(`invalid OCC month ${monName} in ${JSON.stringify(s)}`);
  }
  const day = Number(dayStr);
  const year = 2000 + Number(yyStr);
  const strike = Number(strikeStr);
  // UTC midnight for the expiry day — date-only field, no tz drift.
  const expiry = new Date(Date.UTC(year, mon - 1, day));
  if (
    expiry.getUTCFullYear() !== year ||
    expiry.getUTCMonth() !== mon - 1 ||
    expiry.getUTCDate() !== day
  ) {
    throw new Error(`invalid OCC date in ${JSON.stringify(s)}: ${year}-${mon}-${day}`);
  }
  const canonicalId = formatOcc(underlying, expiry, strike, otype as OptionType);
  return {
    underlying,
    expiry,
    strike,
    optionType: otype as OptionType,
    canonicalId,
  };
}

export function formatOcc(
  underlying: string,
  expiry: Date,
  strike: number,
  optionType: string,
): string {
  const monName = MONTH_NAMES[expiry.getUTCMonth()];
  const yy = expiry.getUTCFullYear() % 100;
  const yyStr = yy.toString().padStart(2, '0');
  const dayStr = expiry.getUTCDate().toString().padStart(2, '0');
  const strikeS =
    strike === Math.trunc(strike)
      ? String(Math.trunc(strike))
      : strike.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return `${underlying.toUpperCase()} ${dayStr}${monName}${yyStr} ${strikeS} ${optionType.toUpperCase()}`;
}
