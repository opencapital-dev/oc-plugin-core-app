import type {
  BrokerImportResult,
  CashflowRequest,
  CashflowType,
  DividendRequest,
  FxConversionRequest,
  IbkrStatementMeta,
  ImportOptions,
  InstrumentRegistration,
  OptionAssignmentRequest,
  OptionExerciseRequest,
  OptionExpiryRequest,
  OptionMarkRequest,
  TradeRequest,
  TradeSide,
} from '../types';
import { parseOcc } from '../occ';
import { normKey, parseNum, rowToObj } from '../shared/helpers';

const IBKR_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[ ,]+(\d{2}):(\d{2}):(\d{2})$/;

/**
 * Convert an IBKR `"YYYY-MM-DD, HH:MM:SS"` Eastern-Time stamp to UTC
 * micros. US DST runs second Sunday of March - first Sunday of November.
 */
export function parseIbkrEt(timeStr: string): number | null {
  const m = timeStr.trim().match(IBKR_TIME_RE);
  if (!m) {return null;}
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  const offsetHours = isUsDst(year, month, day) ? 4 : 5;
  const utcMs = Date.UTC(year, month - 1, day, hour + offsetHours, minute, second);
  return utcMs * 1000;
}

function isUsDst(year: number, month: number, day: number): boolean {
  const dstStart = nthWeekdayOfMonth(year, 3, 0, 2); // 2nd Sunday March
  const dstEnd = nthWeekdayOfMonth(year, 11, 0, 1); // 1st Sunday November
  const dt = day + month * 100 + year * 10000;
  return dt >= dstStart && dt < dstEnd;
}

function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): number {
  const firstOfMonth = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const offset = (weekday - firstOfMonth + 7) % 7;
  const day = 1 + offset + (n - 1) * 7;
  return day + month * 100 + year * 10000;
}

const IBKR_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const IBKR_DATE_RE = /^([A-Za-z]+)\s+(\d+),\s+(\d{4})$/;

function parseIbkrPeriod(value: string): { start: number; end: number } | null {
  // Format: "January 1, 2024 - December 31, 2024". Parsed against an explicit
  // month table so the result is timezone-independent — Date.parse on a
  // locale-formatted date drifts by the user's offset.
  const parts = value.split(/\s+-\s+/);
  if (parts.length !== 2) {return null;}
  const parseDate = (s: string): number | null => {
    const m = s.trim().match(IBKR_DATE_RE);
    if (!m) {return null;}
    const monthIdx = IBKR_MONTHS.indexOf(m[1]!);
    if (monthIdx < 0) {return null;}
    return Date.UTC(Number(m[3]), monthIdx, Number(m[2]));
  };
  const startMs = parseDate(parts[0]!);
  const endMs = parseDate(parts[1]!);
  if (startMs === null || endMs === null) {return null;}
  return { start: startMs * 1000, end: (endMs + 86_400_000) * 1000 };
}

const IBKR_DIV_DESCRIPTION_RE = /^([A-Z][A-Z0-9 .]*)\(([A-Z0-9]{12})\)/;

type IbkrTradeKind = 'stocks' | 'forex' | 'options';

const DEFAULT_OPTION_MULTIPLIER = 100;

type IbkrSection = {
  name: string;
  headerCols: string[];
  dataRows: string[][];
  tradeKind?: IbkrTradeKind;
};

type SectionWalkContext = {
  sections: IbkrSection[];
};

function startSection(ctx: SectionWalkContext, name: string, headerCols: string[]): void {
  let tradeKind: IbkrTradeKind | undefined;
  if (name === 'Trades') {
    tradeKind = undefined;
  }
  ctx.sections.push({
    name,
    headerCols,
    dataRows: [],
    tradeKind,
  });
}

function ibkrSectionWalk(grid: string[][]): IbkrSection[] {
  const ctx: SectionWalkContext = { sections: [] };
  for (const row of grid) {
    if (row.length < 2) {continue;}
    const name = row[0]!.replace(/^﻿/, '').trim();
    const kind = row[1]!.trim();
    if (!name || !kind) {continue;}
    if (kind === 'Header') {
      startSection(ctx, name, row.slice(2).map((s) => s.trim()));
      continue;
    }
    if (kind !== 'Data') {continue;}
    // Find the most recent section by name — that's our active header.
    for (let i = ctx.sections.length - 1; i >= 0; i -= 1) {
      if (ctx.sections[i]!.name === name) {
        ctx.sections[i]!.dataRows.push(row.slice(2));
        break;
      }
    }
  }
  return ctx.sections;
}

function ibkrSectionData(
  sections: IbkrSection[],
  name: string,
): Array<{ headerCols: string[]; dataRows: string[][] }> {
  return sections
    .filter((s) => s.name === name)
    .map((s) => ({ headerCols: s.headerCols, dataRows: s.dataRows }));
}

function buildIbkrStockTrade(
  obj: Record<string, string>,
  options: ImportOptions,
  account: string,
  errors: string[],
): TradeRequest | null {
  const symbol = (obj[normKey('Symbol')] ?? '').trim();
  if (!symbol) {return null;}
  const ts = parseIbkrEt(obj[normKey('Date/Time')] ?? '');
  if (ts === null) {
    errors.push(`IBKR trade ${symbol}: bad Date/Time "${obj[normKey('Date/Time')] ?? ''}"`);
    return null;
  }
  const qtyRaw = parseNum(obj[normKey('Quantity')] ?? '');
  const displayPrice = parseNum(obj[normKey('T. Price')] ?? '');
  if (qtyRaw === null || qtyRaw === 0 || displayPrice === null || displayPrice <= 0) {
    errors.push(`IBKR trade ${symbol} @ ${ts}: invalid quantity/price`);
    return null;
  }
  const ccy = (obj[normKey('Currency')] ?? '').toUpperCase();
  if (!ccy) {
    errors.push(`IBKR trade ${symbol} @ ${ts}: missing Currency`);
    return null;
  }
  const fees = Math.abs(parseNum(obj[normKey('Comm/Fee')] ?? '') ?? 0);
  const side: TradeSide = qtyRaw < 0 ? 'sell' : 'buy';
  const quantity = Math.abs(qtyRaw);
  // IBKR's "T. Price" is a rounded display value; for fractional-share
  // trades `quantity * T.Price` drifts from the real cash moved. The
  // "Proceeds" column is authoritative — derive the effective
  // cash-per-share from it so `quantity * price` reproduces it exactly.
  // Fall back to the display price when Proceeds is absent.
  const proceeds = parseNum(obj[normKey('Proceeds')] ?? '');
  const price =
    proceeds !== null && proceeds !== 0
      ? Math.abs(proceeds) / quantity
      : displayPrice;
  return {
    portfolio_id: options.portfolio_id,
    instrument_id: symbol,
    side,
    price,
    quantity,
    currency: ccy,
    venue: options.venue_default,
    updated_by: options.updated_by,
    event_ts: ts,
    ...(fees > 0 ? { fees } : {}),
    // trade_id stays keyed on the display price so the dedup key is
    // byte-identical to prior imports.
    trade_id: `ibkr-${account}-${symbol}-${ts}-${quantity}-${displayPrice}`,
  };
}

function buildIbkrForexConversion(
  obj: Record<string, string>,
  options: ImportOptions,
  account: string,
  baseCurrency: string,
  errors: string[],
): FxConversionRequest | null {
  const symbol = (obj[normKey('Symbol')] ?? '').trim();
  // Symbols look like "EUR.CHF" — left side is the currency BOUGHT when the
  // row's Quantity is positive (to_ccy); right side is the settlement
  // currency (from_ccy, and the row's Currency col matches it).
  const m = symbol.match(/^([A-Z]{3})\.([A-Z]{3})$/);
  if (!m) {
    errors.push(`IBKR forex: unrecognised symbol "${symbol}"`);
    return null;
  }
  const toCcy = m[1]!;
  const rowCcy = (obj[normKey('Currency')] ?? '').toUpperCase();
  const fromCcy = m[2]!;
  if (rowCcy && rowCcy !== fromCcy) {
    errors.push(
      `IBKR forex ${symbol}: row currency ${rowCcy} differs from pair settlement currency ${fromCcy}`,
    );
    return null;
  }
  // Raw broker timestamp ships through to Kafka. The simulator handles
  // intra-day AutoFx reporting lag by aggregating per calendar day, not by
  // mutating event_ts here.
  const ts = parseIbkrEt(obj[normKey('Date/Time')] ?? '');
  if (ts === null) {
    errors.push(`IBKR forex ${symbol}: bad Date/Time`);
    return null;
  }
  const quantity = parseNum(obj[normKey('Quantity')] ?? '');
  const proceeds = parseNum(obj[normKey('Proceeds')] ?? '');
  if (quantity === null || quantity === 0 || proceeds === null) {
    errors.push(`IBKR forex ${symbol}: invalid quantity/proceeds`);
    return null;
  }
  // Quantity sign: positive = bought to_ccy (FX buy); negative = sold to_ccy.
  // Normalize so from_amount and to_amount are always positive and the pair
  // direction tracks the sign.
  let fromCurrency = fromCcy;
  let toCurrency = toCcy;
  let fromAmount: number;
  let toAmount: number;
  if (quantity > 0) {
    toAmount = quantity;
    fromAmount = Math.abs(proceeds);
  } else {
    toAmount = Math.abs(proceeds);
    fromAmount = Math.abs(quantity);
    [fromCurrency, toCurrency] = [toCurrency, fromCurrency];
  }
  if (fromAmount <= 0 || toAmount <= 0) {
    errors.push(`IBKR forex ${symbol}: zero leg`);
    return null;
  }
  const rate = toAmount / fromAmount;
  // IBKR reports the commission as "Comm in CHF" (label hard-codes the
  // account's base currency, irrespective of which pair was traded). Tag
  // fees_currency accordingly, not the row currency.
  const feesNative = Math.abs(parseNum(obj[normKey('Comm in CHF')] ?? '') ?? 0);
  return {
    portfolio_id: options.portfolio_id,
    from_currency: fromCurrency,
    from_amount: fromAmount,
    to_currency: toCurrency,
    to_amount: toAmount,
    rate,
    updated_by: options.updated_by,
    event_ts: ts,
    ...(feesNative > 0
      ? { fees_native: feesNative, fees_currency: baseCurrency || fromCcy }
      : {}),
    fx_conversion_id: `ibkr-fx-${account}-${ts}-${fromAmount}-${toAmount}`,
  };
}

type OccBag = {
  parts: ReturnType<typeof parseOcc>;
  currency: string;
};

function parseOccOrError(symbol: string, errors: string[]): OccBag['parts'] | null {
  try {
    return parseOcc(symbol);
  } catch (e) {
    errors.push(`IBKR option ${symbol}: ${(e as Error).message}`);
    return null;
  }
}

// Direction of the underlying delivery on Ex/A. See HANDOFF.md / models.py
// _OptionDeliveryCreate: long call exercised or short put assigned -> buy
// underlying; long put exercised or short call assigned -> sell.
function deliveredSideFor(
  optionType: 'C' | 'P',
  closingSide: TradeSide,
): 'buy' | 'sell' {
  const longExercise = closingSide === 'sell';
  if (optionType === 'C') {
    return longExercise ? 'buy' : 'sell';
  }
  return longExercise ? 'sell' : 'buy';
}

function buildIbkrOptionTrade(
  obj: Record<string, string>,
  options: ImportOptions,
  account: string,
  errors: string[],
  occ: OccBag['parts'],
): TradeRequest | null {
  const ts = parseIbkrEt(obj[normKey('Date/Time')] ?? '');
  if (ts === null) {
    errors.push(`IBKR option ${occ.canonicalId}: bad Date/Time`);
    return null;
  }
  const qtyRaw = parseNum(obj[normKey('Quantity')] ?? '');
  const displayPrice = parseNum(obj[normKey('T. Price')] ?? '');
  if (qtyRaw === null || qtyRaw === 0 || displayPrice === null || displayPrice <= 0) {
    errors.push(`IBKR option ${occ.canonicalId} @ ${ts}: invalid quantity/price`);
    return null;
  }
  const ccy = (obj[normKey('Currency')] ?? '').toUpperCase();
  if (!ccy) {
    errors.push(`IBKR option ${occ.canonicalId} @ ${ts}: missing Currency`);
    return null;
  }
  const fees = Math.abs(parseNum(obj[normKey('Comm/Fee')] ?? '') ?? 0);
  const side: TradeSide = qtyRaw < 0 ? 'sell' : 'buy';
  const quantity = Math.abs(qtyRaw);
  // For options T.Price is per-contract (not per-share); the contract
  // multiplier scaling happens in the kernel via Lot.contract_multiplier.
  // Proceeds includes the multiplier, so deriving per-contract price from
  // Proceeds would double-apply it.
  return {
    portfolio_id: options.portfolio_id,
    instrument_id: occ.canonicalId,
    side,
    price: displayPrice,
    quantity,
    currency: ccy,
    venue: options.venue_default,
    updated_by: options.updated_by,
    event_ts: ts,
    ...(fees > 0 ? { fees } : {}),
    trade_id: `ibkr-${account}-${occ.canonicalId}-${ts}-${quantity}-${displayPrice}`,
  };
}

function buildIbkrOptionExpiry(
  obj: Record<string, string>,
  options: ImportOptions,
  account: string,
  errors: string[],
  occ: OccBag['parts'],
): OptionExpiryRequest | null {
  const ts = parseIbkrEt(obj[normKey('Date/Time')] ?? '');
  if (ts === null) {
    errors.push(`IBKR option expiry ${occ.canonicalId}: bad Date/Time`);
    return null;
  }
  const ccy = (obj[normKey('Currency')] ?? '').toUpperCase();
  if (!ccy) {
    errors.push(`IBKR option expiry ${occ.canonicalId} @ ${ts}: missing Currency`);
    return null;
  }
  return {
    portfolio_id: options.portfolio_id,
    instrument_id: occ.canonicalId,
    currency: ccy,
    updated_by: options.updated_by,
    event_ts: ts,
    expiry_id: `ibkr-expiry-${account}-${occ.canonicalId}-${ts}`,
  };
}

function buildIbkrOptionDelivery(
  obj: Record<string, string>,
  options: ImportOptions,
  account: string,
  errors: string[],
  occ: OccBag['parts'],
  contractMultiplier: number,
  kind: 'exercise' | 'assignment',
): OptionExerciseRequest | OptionAssignmentRequest | null {
  const ts = parseIbkrEt(obj[normKey('Date/Time')] ?? '');
  if (ts === null) {
    errors.push(`IBKR option ${kind} ${occ.canonicalId}: bad Date/Time`);
    return null;
  }
  const qtyRaw = parseNum(obj[normKey('Quantity')] ?? '');
  if (qtyRaw === null || qtyRaw === 0) {
    errors.push(`IBKR option ${kind} ${occ.canonicalId} @ ${ts}: invalid quantity`);
    return null;
  }
  const ccy = (obj[normKey('Currency')] ?? '').toUpperCase();
  if (!ccy) {
    errors.push(`IBKR option ${kind} ${occ.canonicalId} @ ${ts}: missing Currency`);
    return null;
  }
  const closingSide: TradeSide = qtyRaw < 0 ? 'sell' : 'buy';
  const deliveredSide = deliveredSideFor(occ.optionType, closingSide);
  const deliveredQty = Math.abs(qtyRaw) * contractMultiplier;
  const base = {
    portfolio_id: options.portfolio_id,
    instrument_id: occ.canonicalId,
    underlying_id: occ.underlying,
    settlement_price: occ.strike,
    delivered_qty: deliveredQty,
    delivered_side: deliveredSide,
    currency: ccy,
    updated_by: options.updated_by,
    event_ts: ts,
  };
  if (kind === 'exercise') {
    return {
      ...base,
      exercise_id: `ibkr-exercise-${account}-${occ.canonicalId}-${ts}`,
    };
  }
  return {
    ...base,
    assignment_id: `ibkr-assignment-${account}-${occ.canonicalId}-${ts}`,
  };
}

function buildIbkrOptionMark(
  obj: Record<string, string>,
  options: ImportOptions,
  occ: OccBag['parts'],
  periodEndUs: number,
  errors: string[],
): OptionMarkRequest | null {
  const ccy = (obj[normKey('Currency')] ?? '').toUpperCase();
  if (!ccy) {
    errors.push(`IBKR option mark ${occ.canonicalId}: missing Currency`);
    return null;
  }
  const close = parseNum(obj[normKey('Close Price')] ?? '');
  if (close === null || close < 0) {
    errors.push(`IBKR option mark ${occ.canonicalId}: invalid Close Price`);
    return null;
  }
  return {
    instrument_id: occ.canonicalId,
    observed_at: periodEndUs,
    close,
    currency: ccy,
    updated_by: options.updated_by,
  };
}

export function ibkrStatementToEvents(
  grid: string[][],
  options: ImportOptions,
): BrokerImportResult & IbkrStatementMeta {
  const sections = ibkrSectionWalk(grid);
  const trades: TradeRequest[] = [];
  const dividends: DividendRequest[] = [];
  const cashflows: CashflowRequest[] = [];
  const fxConversions: FxConversionRequest[] = [];
  const optionExercises: OptionExerciseRequest[] = [];
  const optionAssignments: OptionAssignmentRequest[] = [];
  const optionExpiries: OptionExpiryRequest[] = [];
  const optionMarks: OptionMarkRequest[] = [];
  // One row per instrument identity (equity, option, or option-implied
  // underlying). Insertion-ordered so dispatch follows parse order; keyed
  // by instrument_id internally so a ticker seen twice (e.g. open + close
  // option row, or equity + option underlying) collapses to one row.
  const instrumentsToRegister = new Map<string, InstrumentRegistration>();
  // Equity instruments seen during the statement walk. The parser tags
  // currency from the row; ImportPage's Map step lets the operator confirm
  // or override before commit.
  const recordEquity = (instrumentId: string, currency: string): void => {
    if (!instrumentId) {return;}
    if (instrumentsToRegister.has(instrumentId)) {return;}
    instrumentsToRegister.set(instrumentId, {
      instrument_id: instrumentId,
      kind: 'equity',
      currency: currency || null,
    });
  };
  const errors: string[] = [];
  const isins = new Map<string, string>();
  let skipped = 0;

  // Account / Statement metadata.
  let account = '';
  let baseCurrency = '';
  let period: { start: number; end: number } | null = null;
  for (const s of ibkrSectionData(sections, 'Account Information')) {
    for (const row of s.dataRows) {
      const fieldName = (row[0] ?? '').trim();
      const fieldValue = (row[1] ?? '').trim();
      if (fieldName === 'Account') {account = fieldValue;}
      else if (fieldName === 'Base Currency') {baseCurrency = fieldValue.toUpperCase();}
    }
  }
  for (const s of ibkrSectionData(sections, 'Statement')) {
    for (const row of s.dataRows) {
      const fieldName = (row[0] ?? '').trim();
      const fieldValue = (row[1] ?? '').trim();
      if (fieldName === 'Period') {
        period = parseIbkrPeriod(fieldValue);
      }
    }
  }

  // Financial Instrument Information -> ISIN map.
  for (const s of ibkrSectionData(sections, 'Financial Instrument Information')) {
    for (const cells of s.dataRows) {
      const obj = rowToObj(s.headerCols, cells);
      const symbol = obj[normKey('Symbol')];
      const isin = obj[normKey('Security ID')];
      if (symbol && isin) {isins.set(symbol, isin);}
    }
  }

  // Option registration helper. Underlying registered first (lifecycle
  // routes require it as equity). Multiplier locked to statement when the
  // OCC ticker is sighted in Open Positions; defaults to 100 otherwise.
  const recordOption = (
    occ: ReturnType<typeof parseOcc>,
    currency: string,
    multiplier: number,
  ): void => {
    recordEquityUnderlying(occ.underlying, currency);
    if (instrumentsToRegister.has(occ.canonicalId)) {return;}
    instrumentsToRegister.set(occ.canonicalId, {
      instrument_id: occ.canonicalId,
      kind: 'option',
      currency: currency || null,
      underlying_id: occ.underlying,
      strike: occ.strike,
      expiry_date: occ.expiry.toISOString().slice(0, 10),
      option_type: occ.optionType,
      contract_multiplier: multiplier,
    });
  };
  // Underlying-equity auto-create. If the underlying already appears in a
  // Stocks trade row (equity record exists), the existing entry wins (no
  // overwrite).
  function recordEquityUnderlying(instrumentId: string, currency: string): void {
    if (!instrumentId) {return;}
    if (instrumentsToRegister.has(instrumentId)) {return;}
    instrumentsToRegister.set(instrumentId, {
      instrument_id: instrumentId,
      kind: 'equity',
      currency: currency || null,
    });
  }

  // Open Positions: ahead of Trades so we can resolve contract_multiplier
  // from Mult for option trades that close-and-disappear in the same period.
  // Also emits one option_mark per option Open Position row at period.end.
  const multiplierByOcc = new Map<string, number>();
  for (const s of ibkrSectionData(sections, 'Open Positions')) {
    for (const cells of s.dataRows) {
      const obj = rowToObj(s.headerCols, cells);
      if (obj[normKey('Asset Category')] !== 'Equity and Index Options') {continue;}
      const symbol = (obj[normKey('Symbol')] ?? '').trim();
      const occ = parseOccOrError(symbol, errors);
      if (!occ) {
        skipped += 1;
        continue;
      }
      const mult = parseNum(obj[normKey('Mult')] ?? '') ?? DEFAULT_OPTION_MULTIPLIER;
      multiplierByOcc.set(occ.canonicalId, mult);
      const ccy = (obj[normKey('Currency')] ?? '').toUpperCase();
      recordOption(occ, ccy, mult);
      if (period) {
        const mark = buildIbkrOptionMark(obj, options, occ, period.end, errors);
        if (mark) {optionMarks.push(mark);}
      }
    }
  }

  // Trades section: re-occurring Header rows for Stocks vs Forex vs Options.
  for (const s of ibkrSectionData(sections, 'Trades')) {
    for (const cells of s.dataRows) {
      const obj = rowToObj(s.headerCols, cells);
      const discriminator = obj[normKey('DataDiscriminator')] || '';
      if (discriminator !== 'Order') {
        skipped += 1;
        continue;
      }
      const assetCat = obj[normKey('Asset Category')];
      if (assetCat === 'Stocks') {
        const built = buildIbkrStockTrade(obj, options, account, errors);
        if (built) {
          trades.push(built);
          recordEquity(built.instrument_id, built.currency);
        } else {
          skipped += 1;
        }
      } else if (assetCat === 'Forex') {
        const built = buildIbkrForexConversion(obj, options, account, baseCurrency, errors);
        if (built) {fxConversions.push(built);}
        else {skipped += 1;}
      } else if (assetCat === 'Equity and Index Options') {
        const symbol = (obj[normKey('Symbol')] ?? '').trim();
        const occ = parseOccOrError(symbol, errors);
        if (!occ) {
          skipped += 1;
          continue;
        }
        const ccy = (obj[normKey('Currency')] ?? '').toUpperCase();
        const sightedMult = multiplierByOcc.get(occ.canonicalId);
        const mult = sightedMult ?? DEFAULT_OPTION_MULTIPLIER;
        recordOption(occ, ccy, mult);
        // Codes are semicolon-delimited (e.g. "C;Ep"). Lifecycle codes win
        // over O/C: the paired equity TRADE row carries any cash leg.
        const codes = (obj[normKey('Code')] ?? '').split(';').map((c) => c.trim()).filter(Boolean);
        if (codes.includes('Ep')) {
          const built = buildIbkrOptionExpiry(obj, options, account, errors, occ);
          if (built) {optionExpiries.push(built);}
          else {skipped += 1;}
        } else if (codes.includes('Ex')) {
          const built = buildIbkrOptionDelivery(obj, options, account, errors, occ, mult, 'exercise');
          if (built) {optionExercises.push(built as OptionExerciseRequest);}
          else {skipped += 1;}
        } else if (codes.includes('A')) {
          const built = buildIbkrOptionDelivery(obj, options, account, errors, occ, mult, 'assignment');
          if (built) {optionAssignments.push(built as OptionAssignmentRequest);}
          else {skipped += 1;}
        } else {
          const built = buildIbkrOptionTrade(obj, options, account, errors, occ);
          if (built) {trades.push(built);}
          else {skipped += 1;}
        }
      } else {
        skipped += 1;
      }
    }
  }

  // Dividends + Withholding Tax: pair by (date, ticker, currency).
  type DivKey = string;
  const divKey = (date: string, ticker: string, ccy: string): DivKey =>
    `${date}|${ticker}|${ccy}`;
  const dividendIdx = new Map<DivKey, number>();

  for (const s of ibkrSectionData(sections, 'Dividends')) {
    for (const cells of s.dataRows) {
      const obj = rowToObj(s.headerCols, cells);
      const ccy = (obj[normKey('Currency')] ?? '').toUpperCase();
      if (!ccy || ccy === 'TOTAL' || ccy === 'BASE CURRENCY SUMMARY') {
        skipped += 1;
        continue;
      }
      const date = obj[normKey('Date')] ?? '';
      const description = obj[normKey('Description')] ?? '';
      const amount = parseNum(obj[normKey('Amount')] ?? '');
      const m = description.match(IBKR_DIV_DESCRIPTION_RE);
      if (!m || amount === null || amount <= 0) {
        skipped += 1;
        continue;
      }
      const ticker = m[1]!.trim().toUpperCase();
      const eventMs = Date.parse(date + 'T12:00:00Z');
      if (!Number.isFinite(eventMs)) {
        errors.push(`IBKR dividend ${ticker} ${date}: bad date`);
        continue;
      }
      const event_ts = eventMs * 1000;
      const dividend_id = `ibkr-div-${account}-${ticker}-${date}-${amount}`;
      const dividend: DividendRequest = {
        portfolio_id: options.portfolio_id,
        instrument_id: ticker,
        gross_native: amount,
        currency: ccy,
        updated_by: options.updated_by,
        event_ts,
        dividend_id,
      };
      dividendIdx.set(divKey(date, ticker, ccy), dividends.length);
      dividends.push(dividend);
      recordEquity(ticker, ccy);
    }
  }

  for (const s of ibkrSectionData(sections, 'Withholding Tax')) {
    for (const cells of s.dataRows) {
      const obj = rowToObj(s.headerCols, cells);
      const ccy = (obj[normKey('Currency')] ?? '').toUpperCase();
      if (!ccy || ccy === 'TOTAL' || ccy === 'BASE CURRENCY SUMMARY') {
        skipped += 1;
        continue;
      }
      const date = obj[normKey('Date')] ?? '';
      const description = obj[normKey('Description')] ?? '';
      const amount = parseNum(obj[normKey('Amount')] ?? '');
      const m = description.match(IBKR_DIV_DESCRIPTION_RE);
      if (!m || amount === null) {
        skipped += 1;
        continue;
      }
      const ticker = m[1]!.trim().toUpperCase();
      const idx = dividendIdx.get(divKey(date, ticker, ccy));
      if (idx === undefined) {
        errors.push(`IBKR withholding ${ticker} ${date} ${ccy}: no matching dividend row`);
        continue;
      }
      dividends[idx]!.withholding_native =
        (dividends[idx]!.withholding_native ?? 0) + Math.abs(amount);
    }
  }

  // Dividend FX synth (post-pairing). IBKR doesn't carry per-row exchange
  // rates for dividends. When the operator supplied one via the Map step UI,
  // synthesize the paired FX conversion: net (gross - wh) arrives in
  // dividend ccy, broker converts to base.
  const ibkrBaseCcy = (options.portfolio_base_currency ?? '').toUpperCase();
  if (ibkrBaseCcy && options.dividendFxRates) {
    for (const dividend of dividends) {
      if (!dividend.dividend_id) {continue;}
      const divCcy = dividend.currency.toUpperCase();
      if (divCcy === ibkrBaseCcy) {continue;}
      const rate = options.dividendFxRates[dividend.dividend_id];
      if (rate === undefined || rate <= 0) {continue;}
      const netNative = dividend.gross_native - (dividend.withholding_native ?? 0);
      if (netNative <= 0) {continue;}
      fxConversions.push({
        portfolio_id: options.portfolio_id,
        from_currency: divCcy,
        from_amount: netNative,
        to_currency: ibkrBaseCcy,
        to_amount: netNative * rate,
        rate,
        updated_by: options.updated_by,
        event_ts: dividend.event_ts! + 1,
        fx_conversion_id: `ibkr-fx-div-${dividend.dividend_id}`,
      });
    }
  }

  // Deposits & Withdrawals.
  for (const s of ibkrSectionData(sections, 'Deposits & Withdrawals')) {
    for (const cells of s.dataRows) {
      const obj = rowToObj(s.headerCols, cells);
      const ccy = (obj[normKey('Currency')] ?? '').toUpperCase();
      if (!ccy || ccy === 'TOTAL') {
        skipped += 1;
        continue;
      }
      const date = obj[normKey('Settle Date')] ?? '';
      const amount = parseNum(obj[normKey('Amount')] ?? '');
      if (amount === null || amount === 0) {
        skipped += 1;
        continue;
      }
      const eventMs = Date.parse(date + 'T00:00:00Z');
      if (!Number.isFinite(eventMs)) {
        errors.push(`IBKR deposit/withdrawal ${ccy} ${date}: bad date`);
        continue;
      }
      const event_ts = eventMs * 1000;
      const type: CashflowType = amount > 0 ? 'DEPOSIT' : 'WITHDRAWAL';
      cashflows.push({
        portfolio_id: options.portfolio_id,
        type,
        amount_native: Math.abs(amount),
        currency: ccy,
        updated_by: options.updated_by,
        event_ts,
        cashflow_id: `ibkr-${type.toLowerCase()}-${account}-${ccy}-${date}-${Math.abs(amount)}`,
      });
    }
  }

  // Fees. Skip accrual reversal pairs (sample shows +0.03 / -0.03 same-day).
  for (const s of ibkrSectionData(sections, 'Fees')) {
    const seenPairs = new Map<string, number>();
    for (const cells of s.dataRows) {
      const obj = rowToObj(s.headerCols, cells);
      const ccy = (obj[normKey('Currency')] ?? '').toUpperCase();
      if (!ccy || ccy === 'TOTAL') {
        skipped += 1;
        continue;
      }
      const date = obj[normKey('Date')] ?? '';
      const description = obj[normKey('Description')] ?? '';
      const amount = parseNum(obj[normKey('Amount')] ?? '');
      if (amount === null || amount === 0) {
        skipped += 1;
        continue;
      }
      const pairKey = `${date}|${description}|${ccy}`;
      const prev = seenPairs.get(pairKey);
      if (prev !== undefined && Math.abs(prev + amount) < 1e-6) {
        seenPairs.delete(pairKey);
        for (let i = cashflows.length - 1; i >= 0; i -= 1) {
          const c = cashflows[i]!;
          if (
            c.type === 'FEE' &&
            c.currency === ccy &&
            Math.abs(c.amount_native - Math.abs(prev)) < 1e-9
          ) {
            cashflows.splice(i, 1);
            break;
          }
        }
        continue;
      }
      seenPairs.set(pairKey, (prev ?? 0) + amount);
      const eventMs = Date.parse(date + 'T00:00:00Z');
      if (!Number.isFinite(eventMs)) {
        errors.push(`IBKR fee ${ccy} ${date}: bad date`);
        continue;
      }
      const event_ts = eventMs * 1000;
      cashflows.push({
        portfolio_id: options.portfolio_id,
        type: 'FEE',
        amount_native: Math.abs(amount),
        currency: ccy,
        updated_by: options.updated_by,
        event_ts,
        cashflow_id: `ibkr-fee-${account}-${ccy}-${date}-${Math.abs(amount)}-${cashflows.length}`,
      });
    }
  }

  return {
    trades,
    dividends,
    cashflows,
    fxConversions,
    transferIns: [],
    optionExercises,
    optionAssignments,
    optionExpiries,
    optionMarks,
    instrumentsToRegister: Array.from(instrumentsToRegister.values()),
    skipped,
    errors,
    account,
    baseCurrency,
    period,
    isins,
  };
}

/**
 * Sniff a CSV grid for the IBKR Activity Statement shape. IBKR begins with a
 * multi-section "Statement,Header,Field Name,Field Value" row.
 */
export function detectIbkr(grid: string[][]): boolean {
  if (grid.length === 0) {return false;}
  const head = grid[0]!;
  return (
    head.length >= 4 &&
    head[0]!.replace(/^﻿/, '').trim() === 'Statement' &&
    head[1]!.trim() === 'Header' &&
    head[2]!.trim() === 'Field Name' &&
    head[3]!.trim() === 'Field Value'
  );
}
