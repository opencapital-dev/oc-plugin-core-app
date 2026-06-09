import type {
  BrokerImportResult,
  CashflowRequest,
  CashflowType,
  DividendRequest,
  FxConversionRequest,
  ImportOptions,
  TradeRequest,
  TradeSide,
  TransferInRequest,
} from '../types';
import { parseNum, pick, round6, rowsToObjects } from '../shared/helpers';

export type BrokerActionClassification =
  | { kind: 'trade'; side: TradeSide }
  | { kind: 'transfer_in' }
  | { kind: 'transfer_out' }
  | { kind: 'dividend' }
  | { kind: 'cashflow'; type: CashflowType }
  | null;

/** Map broker-style Action to its destination event family. */
export function classifyBrokerAction(actionRaw: string): BrokerActionClassification {
  const s = actionRaw.trim().toLowerCase();
  if (!s) {
    return null;
  }
  // Cashflow types — order matters, "interest on cash" must match before bare "fee".
  if (/\binterest\s+on\s+cash\b/.test(s)) {
    return { kind: 'cashflow', type: 'INTEREST_ON_CASH' };
  }
  if (/\bdeposit\b/.test(s)) {
    return { kind: 'cashflow', type: 'DEPOSIT' };
  }
  if (/\bwithdrawal\b/.test(s)) {
    return { kind: 'cashflow', type: 'WITHDRAWAL' };
  }
  if (/\bdividend\b/.test(s)) {
    return { kind: 'dividend' };
  }
  if (/\bfee\b/.test(s)) {
    return { kind: 'cashflow', type: 'FEE' };
  }
  if (/\btransfer\s+in\b/.test(s)) {
    return { kind: 'transfer_in' };
  }
  if (/\btransfer\s+out\b/.test(s)) {
    return { kind: 'transfer_out' };
  }
  if (/\bbuy\b/.test(s)) {
    return { kind: 'trade', side: 'buy' };
  }
  if (/\bsell\b/.test(s)) {
    return { kind: 'trade', side: 'sell' };
  }
  return null;
}

function parseEventTs(timeStr: string, line: number, errors: string[]): number | null {
  if (!timeStr) {
    errors.push(`Line ${line}: missing Time`);
    return null;
  }
  const ms = Date.parse(timeStr.replace(' ', 'T'));
  if (!Number.isFinite(ms)) {
    errors.push(`Line ${line}: bad Time "${timeStr}"`);
    return null;
  }
  return ms * 1000;
}

function buildTrade212(
  row: Record<string, string>,
  side: TradeSide,
  options: ImportOptions,
  line: number,
  errors: string[],
): { trade: TradeRequest; fxConversion: FxConversionRequest | null } | null {
  const ticker = pick(row, ['ticker']).trim().toUpperCase();
  if (!ticker) {
    errors.push(`Line ${line}: missing Ticker`);
    return null;
  }
  const event_ts = parseEventTs(pick(row, ['time']), line, errors);
  if (event_ts === null) return null;

  const qty = parseNum(pick(row, ['no of shares', 'no. of shares']));
  if (qty === null || qty <= 0) {
    errors.push(`Line ${line}: invalid quantity`);
    return null;
  }

  const priceRaw = pick(row, ['price / share']);
  let price = parseNum(priceRaw);
  if (price === null || price <= 0) {
    errors.push(`Line ${line}: invalid price`);
    return null;
  }

  let currency = pick(row, ['currency (price / share)', 'currency']).toUpperCase() || 'USD';
  if (currency === 'GBX') {
    price = price / 100;
    currency = 'GBP';
  }

  // Per-row fees are reported in their own currency. Convert each into
  // the trade's price currency before summing so position-tracker's downstream
  // FX math (fees_local x fx -> fees_base) lands in the right currency.
  const baseCcy = (options.portfolio_base_currency ?? '').toUpperCase();
  const settlementCcy = pick(row, ['currency (total)']).toUpperCase();
  const exchangeRate = parseNum(pick(row, ['exchange rate']));
  const feesPriceCcy = currency.toUpperCase();
  let fees = 0;
  let feeError = false;

  const addFee = (amount: number, feeCcy: string) => {
    if (amount <= 0) return;
    const fc = feeCcy.toUpperCase();
    if (!fc || fc === feesPriceCcy) {
      fees += amount;
      return;
    }
    if (
      exchangeRate !== null &&
      exchangeRate > 0 &&
      fc === settlementCcy &&
      feesPriceCcy !== settlementCcy
    ) {
      fees += amount * exchangeRate;
      return;
    }
    errors.push(
      `Line ${line}: fee in ${fc} cannot be converted to trade ccy ${feesPriceCcy} (no exchange rate)`,
    );
    feeError = true;
  };

  const finra = parseNum(pick(row, ['finra fee']));
  const finraCcy = pick(row, ['currency (finra fee)']) || feesPriceCcy;
  if (finra !== null && finra > 0) addFee(finra, finraCcy);

  const conv = parseNum(pick(row, ['currency conversion fee']));
  const convCcy = pick(row, ['currency (currency conversion fee)']) || feesPriceCcy;
  if (conv !== null && conv > 0) addFee(conv, convCcy);

  const stamp = parseNum(pick(row, ['stamp duty reserve tax']));
  const stampCcy = pick(row, ['currency (stamp duty reserve tax)']) || feesPriceCcy;
  if (stamp !== null && stamp > 0) addFee(stamp, stampCcy);

  if (feeError) return null;

  const trade_id = pick(row, ['id']) || undefined;

  // T212 auto-converts cross-currency trades to base. Under the BUNDLED
  // model, the trade carries the FX rate inline (trade.fx_rate_to_base);
  // calculator processes equity + cash bucket FX legs atomically. NO
  // separate FxConversion event is emitted for these trades — the
  // calculator synthesizes the cash-bucket legs from the embedded fields.
  // Same-currency trades leave fx_rate_to_base = null.
  const isCrossCcy =
    !!baseCcy &&
    currency.toUpperCase() !== baseCcy &&
    settlementCcy === baseCcy &&
    exchangeRate !== null &&
    exchangeRate > 0;

  // fx_rate_to_base = base per 1 unit of trade currency (e.g., 0.78 means
  // 1 USD = 0.78 GBP). T212 reports `Exchange rate` as trade-ccy per base
  // (e.g., 1.28 USD per GBP), so invert.
  const fxRateToBase = isCrossCcy && exchangeRate !== null ? 1 / exchangeRate : null;

  const trade: TradeRequest = {
    portfolio_id: options.portfolio_id,
    instrument_id: ticker,
    side,
    price,
    quantity: qty,
    currency,
    venue: options.venue_default,
    updated_by: options.updated_by,
    event_ts,
    ...(trade_id ? { trade_id } : {}),
    ...(fees > 0 ? { fees } : {}),
    ...(fxRateToBase !== null ? { fx_rate_to_base: fxRateToBase } : {}),
  };

  return { trade, fxConversion: null };
}

function buildDividend212(
  row: Record<string, string>,
  options: ImportOptions,
  line: number,
  errors: string[],
): { dividend: DividendRequest; fxConversion: FxConversionRequest | null } | null {
  const ticker = pick(row, ['ticker']).trim().toUpperCase();
  if (!ticker) {
    errors.push(`Line ${line}: dividend missing Ticker`);
    return null;
  }
  const event_ts = parseEventTs(pick(row, ['time']), line, errors);
  if (event_ts === null) return null;

  const qty = parseNum(pick(row, ['no of shares', 'no. of shares']));
  const perShare = parseNum(pick(row, ['price / share']));
  let perShareCcy = pick(row, ['currency (price / share)', 'currency']).toUpperCase() || 'USD';

  let gross_native: number | null = null;
  if (qty !== null && qty > 0 && perShare !== null && perShare > 0) {
    let perShareLocal = perShare;
    if (perShareCcy === 'GBX') {
      perShareLocal = perShare / 100;
      perShareCcy = 'GBP';
    }
    gross_native = qty * perShareLocal;
  }
  if (gross_native === null) {
    errors.push(`Line ${line}: dividend missing No. of shares x Price / share`);
    return null;
  }

  const settlementCcy = pick(row, ['currency (total)']).toUpperCase();
  const exchangeRate = parseNum(pick(row, ['exchange rate']));

  // Withholding can be in its own currency. Convert to dividend currency if needed.
  const whAmount = parseNum(pick(row, ['withholding tax']));
  const whCcyRaw = pick(row, ['currency (withholding tax)']).toUpperCase();
  let withholding_native: number | undefined;
  if (whAmount !== null && whAmount > 0) {
    let whCcy = whCcyRaw || perShareCcy;
    let whLocal = whAmount;
    if (whCcy === 'GBX') {
      whLocal = whAmount / 100;
      whCcy = 'GBP';
    }
    if (whCcy === perShareCcy) {
      withholding_native = whLocal;
    } else if (
      whCcy === settlementCcy &&
      exchangeRate !== null &&
      exchangeRate > 0 &&
      perShareCcy !== settlementCcy
    ) {
      withholding_native = whLocal * exchangeRate;
    } else {
      errors.push(
        `Line ${line}: withholding in ${whCcy} cannot be converted to dividend ccy ${perShareCcy}`,
      );
      return null;
    }
  }

  const dividend: DividendRequest = {
    portfolio_id: options.portfolio_id,
    instrument_id: ticker,
    gross_native,
    currency: perShareCcy,
    updated_by: options.updated_by,
    event_ts,
    ...(withholding_native !== undefined ? { withholding_native } : {}),
  };

  // BUNDLED FX: cross-currency dividends with a broker rate get the FX legs
  // inlined on the dividend (no separate FxConversion event). T212's
  // "Exchange rate" on dividend rows is `1 dividend_ccy = X base` — already
  // in base-per-dividend-ccy form. Operator override via dividendFxRates
  // wins. Calculator applies DIVIDEND_CREDIT at T then FX_DEBIT/FX_CREDIT
  // at T+1 atomically.
  const baseCcy = (options.portfolio_base_currency ?? '').toUpperCase();
  const dividendKey = dividend.dividend_id ?? `t212-div-${ticker}-${event_ts}`;
  if (baseCcy && perShareCcy !== baseCcy) {
    let rate: number | null = null;
    if (settlementCcy === baseCcy && exchangeRate !== null && exchangeRate > 0) {
      rate = exchangeRate;
    }
    const override = options.dividendFxRates?.[dividendKey];
    if (override !== undefined && override > 0) {
      rate = override;
    }
    if (rate !== null) {
      dividend.fx_rate_to_base = rate;
    }
  }

  return { dividend, fxConversion: null };
}

function buildCashflow212(
  row: Record<string, string>,
  type: CashflowType,
  options: ImportOptions,
  line: number,
  errors: string[],
): { cashflow: CashflowRequest; fxConversion: FxConversionRequest | null } | null {
  const event_ts = parseEventTs(pick(row, ['time']), line, errors);
  if (event_ts === null) return null;

  const total = parseNum(pick(row, ['total']));
  if (total === null || total <= 0) {
    errors.push(`Line ${line}: ${type.toLowerCase()} missing Total`);
    return null;
  }
  const ccy = pick(row, ['currency (total)']).toUpperCase();
  if (!ccy) {
    errors.push(`Line ${line}: ${type.toLowerCase()} missing Currency (Total)`);
    return null;
  }
  const cashflow_id =
    pick(row, ['id']) || `t212-${type.toLowerCase()}-${event_ts}-${ccy}-${total}`;

  const cashflow: CashflowRequest = {
    portfolio_id: options.portfolio_id,
    type,
    amount_native: total,
    currency: ccy,
    updated_by: options.updated_by,
    event_ts,
    cashflow_id,
  };

  // Foreign-currency interest synthesizes a paired FX conversion when the
  // operator supplied a rate (Trading 212 CSV doesn't carry one for interest
  // rows). Without an override rate, leave fxConversion null and let the
  // operator fill it in from the Map step UI.
  let fxConversion: FxConversionRequest | null = null;
  const baseCcy = (options.portfolio_base_currency ?? '').toUpperCase();
  if (type === 'INTEREST_ON_CASH' && baseCcy && ccy !== baseCcy) {
    const rate = options.interestFxRates?.[cashflow_id];
    if (rate !== undefined && rate > 0) {
      const baseAmount = total * rate;
      fxConversion = {
        portfolio_id: options.portfolio_id,
        from_currency: ccy,
        from_amount: total,
        to_currency: baseCcy,
        to_amount: baseAmount,
        rate,
        updated_by: options.updated_by,
        event_ts: event_ts + 1,
        fx_conversion_id: `t212-fx-int-${cashflow_id}`,
      };
    }
  }

  return { cashflow, fxConversion };
}

/**
 * Convert a 121 "Transfer in" CSV row directly into a single TransferInRequest
 * at the broker-reported date and cost basis. Shares arrive in-kind with a
 * known cost basis; no cash moves. T212's "Exchange rate" column is
 * trade_ccy_per_base; SDK's fx_rate_to_base is base_per_native, so invert.
 */
function buildTransferIn212(
  row: Record<string, string>,
  options: ImportOptions,
  line: number,
  errors: string[],
): TransferInRequest | null {
  const ticker = pick(row, ['ticker']).trim().toUpperCase();
  if (!ticker) {
    errors.push(`Line ${line}: transfer-in missing Ticker`);
    return null;
  }
  const event_ts = parseEventTs(pick(row, ['time']), line, errors);
  if (event_ts === null) return null;

  const qty = parseNum(pick(row, ['no of shares', 'no. of shares']));
  if (qty === null || qty <= 0) {
    errors.push(`Line ${line}: transfer-in invalid quantity`);
    return null;
  }
  const priceRaw = pick(row, ['price / share']);
  let price = parseNum(priceRaw);
  if (price === null || price <= 0) {
    errors.push(`Line ${line}: transfer-in invalid price`);
    return null;
  }
  let tradeCcy = pick(row, ['currency (price / share)', 'currency']).toUpperCase() || 'USD';
  if (tradeCcy === 'GBX') {
    price = price / 100;
    tradeCcy = 'GBP';
  }
  const baseCcy = (options.portfolio_base_currency ?? '').toUpperCase();
  const exchangeRate = parseNum(pick(row, ['exchange rate']));
  const grossTradeCcy = qty * price;
  const fxRateToBase =
    tradeCcy === baseCcy
      ? 1.0
      : exchangeRate !== null && exchangeRate > 0
        ? round6(1 / exchangeRate)
        : 1.0;
  const transferId = `t212-xferin-${ticker}-${event_ts}-${qty}`;
  return {
    portfolio_id: options.portfolio_id,
    instrument_id: ticker,
    quantity: qty,
    cost_basis_native: round6(grossTradeCcy),
    currency: tradeCcy,
    fx_rate_to_base: fxRateToBase,
    event_ts,
    transfer_id: transferId,
    lot_id: `${transferId}-0`,
    acquisition_date: event_ts,
    fx_rate_at_acquisition: fxRateToBase,
    updated_by: options.updated_by,
  };
}

/**
 * Parse a flat one-row-per-event Trading 212 CSV. Cross-currency rows yield
 * a TradeRequest/DividendRequest with `fx_rate_to_base` inlined; no separate
 * FxConversion event is emitted for bundled trades.
 */
export function t212GridToEvents(
  grid: string[][],
  options: ImportOptions,
): BrokerImportResult {
  const rows = rowsToObjects(grid);
  const trades: TradeRequest[] = [];
  const dividends: DividendRequest[] = [];
  const cashflows: CashflowRequest[] = [];
  const fxConversions: FxConversionRequest[] = [];
  const transferIns: TransferInRequest[] = [];
  const errors: string[] = [];
  let skipped = 0;

  rows.forEach((row, idx) => {
    const line = idx + 2;
    const action = pick(row, ['action']);
    const cls = classifyBrokerAction(action);
    if (cls === null) {
      skipped += 1;
      return;
    }
    if (cls.kind === 'trade') {
      const built = buildTrade212(row, cls.side, options, line, errors);
      if (built) {
        trades.push(built.trade);
        if (built.fxConversion) fxConversions.push(built.fxConversion);
      }
    } else if (cls.kind === 'transfer_in') {
      const built = buildTransferIn212(row, options, line, errors);
      if (built) transferIns.push(built);
    } else if (cls.kind === 'transfer_out') {
      errors.push(
        `Line ${line}: 'Transfer out' rows are not yet supported (per-lot exit data required).`,
      );
      skipped += 1;
    } else if (cls.kind === 'dividend') {
      const built = buildDividend212(row, options, line, errors);
      if (built) {
        dividends.push(built.dividend);
        if (built.fxConversion) fxConversions.push(built.fxConversion);
      }
    } else {
      const built = buildCashflow212(row, cls.type, options, line, errors);
      if (built) {
        cashflows.push(built.cashflow);
        if (built.fxConversion) fxConversions.push(built.fxConversion);
      }
    }
  });

  const instrumentsToRegister = Array.from(
    new Set<string>([
      ...trades.map((t) => t.instrument_id),
      ...dividends.map((d) => d.instrument_id),
      ...transferIns.map((t) => t.instrument_id),
    ]),
  ).map((id) => {
    const ccy =
      trades.find((t) => t.instrument_id === id)?.currency ??
      dividends.find((d) => d.instrument_id === id)?.currency ??
      transferIns.find((t) => t.instrument_id === id)?.currency ??
      null;
    return {
      instrument_id: id,
      kind: 'equity' as const,
      currency: ccy,
    };
  });
  return {
    trades,
    dividends,
    cashflows,
    fxConversions,
    transferIns,
    optionExercises: [],
    optionAssignments: [],
    optionExpiries: [],
    optionMarks: [],
    instrumentsToRegister,
    skipped,
    errors,
  };
}

/**
 * Sniff a CSV grid for the T212 flat shape: header row contains an "Action"
 * column and at least one of Time / Ticker. Distinct from IBKR's
 * "Statement,Header,..." multi-section layout.
 */
export function detectT212(grid: string[][]): boolean {
  if (grid.length === 0) return false;
  const head = grid[0]!.map((h) => h.trim().toLowerCase().replace(/\./g, ''));
  if (!head.includes('action')) return false;
  return head.includes('time') || head.includes('ticker');
}
