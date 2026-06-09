import { refRequest } from './client';

export type PortfolioEntity = {
  portfolio_id: string;
  base_currency: string;
  attributes: Record<string, string>;
  updated_at: number;
};

export type InstrumentKind = 'equity' | 'fx_pair' | 'cash' | 'option';

export type OptionType = 'C' | 'P';

export type InstrumentEntity = {
  instrument_id: string;
  currency: string | null;
  kind: InstrumentKind;
  base_currency: string | null;
  sector: string | null;
  subindustry: string | null;
  underlying_id: string | null;
  strike: number | null;
  expiry_date: string | null;
  option_type: OptionType | null;
  contract_multiplier: number | null;
  updated_at: number;
};

export type InstrumentTaxonomy = {
  sectors: string[];
  subindustries: string[];
};

export type LookupCandidate = {
  symbol: string;
  short_name: string | null;
  exchange: string | null;
  type: string | null;
};

export type TradeRequest = {
  portfolio_id: string;
  instrument_id: string;
  side: 'buy' | 'sell';
  price: number;
  quantity: number;
  currency: string;
  venue: string;
  updated_by: string;
  commission?: number;
  fees?: number;
  event_ts?: number;
  trade_id?: string;
  fx_rate_to_base?: number;
  // Self-describing identity: stamped onto each trade so the calc pipeline
  // derives instrument_kind/contract_multiplier from the event stream.
  instrument_kind?: InstrumentKind;
  contract_multiplier?: number;
};

export type TradeOut = {
  portfolio_id: string;
  instrument_id: string;
  trade_id: string;
  side: string;
  trade_quantity: number;
  delta_quantity: number;
  event_ts: number;
  trade_observation_id: string;
  correction_of?: string | null;
};

export type TradeListRow = {
  scope_type?: string | null;
  scope_id?: string | null;
  instrument_id?: string | null;
  side?: string | null;
  trade_id?: string | null;
  price?: number | null;
  quantity?: number | null;
  currency?: string | null;
  venue?: string | null;
  source?: string | null;
  observation_id?: string | null;
  correction_of?: string | null;
  event_ts: number;
  ingest_ts?: number | null;
};

export type TradeCorrectionPayload = {
  portfolio_id: string;
  instrument_id: string;
  side: 'buy' | 'sell';
  price: number;
  quantity: number;
  currency: string;
  venue: string;
  updated_by: string;
  event_ts: number;
  commission?: number;
  fees?: number;
};

export type CashflowType = 'DEPOSIT' | 'WITHDRAWAL' | 'INTEREST_ON_CASH' | 'FEE';

export type DividendRequest = {
  portfolio_id: string;
  instrument_id: string;
  gross_native: number;
  currency: string;
  updated_by: string;
  withholding_native?: number;
  dividend_id?: string;
  event_ts?: number;
  fx_rate_to_base?: number;
  fx_fees_native?: number;
  fx_fees_currency?: string;
};

export type DividendOut = {
  portfolio_id: string;
  instrument_id: string;
  dividend_id: string;
  gross_native: number;
  withholding_native?: number | null;
  currency: string;
  event_ts: number;
  observation_id: string;
  correction_of?: string | null;
};

export type CashflowRequest = {
  portfolio_id: string;
  type: CashflowType;
  amount_native: number;
  currency: string;
  updated_by: string;
  cashflow_id?: string;
  event_ts?: number;
};

export type CashflowOut = {
  portfolio_id: string;
  cashflow_id: string;
  type: CashflowType;
  amount_native: number;
  currency: string;
  event_ts: number;
  observation_id: string;
  correction_of?: string | null;
};

export type FxConversionRequest = {
  portfolio_id: string;
  from_currency: string;
  from_amount: number;
  to_currency: string;
  to_amount: number;
  rate: number;
  updated_by: string;
  fees_native?: number;
  fees_currency?: string;
  fx_conversion_id?: string;
  event_ts?: number;
};

export type FxConversionOut = {
  portfolio_id: string;
  fx_conversion_id: string;
  from_currency: string;
  from_amount: number;
  to_currency: string;
  to_amount: number;
  rate: number;
  fees_native?: number | null;
  fees_currency?: string | null;
  event_ts: number;
  observation_id: string;
  correction_of?: string | null;
};

export type TransferInRequest = {
  portfolio_id: string;
  instrument_id: string;
  quantity: number;
  cost_basis_native: number;
  currency: string;
  updated_by: string;
  acquisition_date: number;
  fx_rate_at_acquisition: number;
  lot_id: string;
  fx_rate_to_base?: number;
  transfer_id?: string;
  event_ts?: number;
};

export type TransferInOut = {
  portfolio_id: string;
  instrument_id: string;
  transfer_id: string;
  lot_id: string;
  quantity: number;
  cost_basis_native: number;
  currency: string;
  acquisition_date: number;
  fx_rate_at_acquisition: number;
  fx_rate_to_base?: number | null;
  event_ts: number;
  observation_id: string;
  correction_of?: string | null;
};

export type AcquisitionLot = {
  lot_id: string;
  quantity: number;
  cost_native: number;
  acquisition_date: number;
  fx_rate_at_acquisition: number;
};

export function listPortfolios() {
  return refRequest<PortfolioEntity[]>('/portfolios');
}

export function createPortfolio(payload: {
  portfolio_id: string;
  base_currency: string;
  attributes: Record<string, string>;
}) {
  return refRequest<PortfolioEntity>('/portfolios', { method: 'POST', body: payload });
}

export function deletePortfolio(portfolioId: string) {
  return refRequest<void>(`/portfolios/${encodeURIComponent(portfolioId)}`, { method: 'DELETE' });
}

export function listInstruments(portfolioId: string) {
  return refRequest<InstrumentEntity[]>(`/instruments?portfolio_id=${encodeURIComponent(portfolioId)}`);
}

export function lookupSymbol(query: string, limit = 10) {
  return refRequest<LookupCandidate[]>(
    `/lookup?q=${encodeURIComponent(query)}&limit=${limit}`
  );
}

export function deleteEvent(sourceId: string, portfolioId: string) {
  return refRequest<void>(
    `/events/${encodeURIComponent(sourceId)}?portfolio_id=${encodeURIComponent(portfolioId)}`,
    { method: 'DELETE' },
  );
}

export function submitTrade(payload: TradeRequest) {
  return refRequest<TradeOut>('/trades', { method: 'POST', body: payload });
}

export function listTrades(portfolioId: string) {
  return refRequest<TradeListRow[]>(`/trades?portfolio_id=${encodeURIComponent(portfolioId)}`);
}

export function submitTradesBulk(trades: TradeRequest[]) {
  return refRequest<TradeOut[]>('/trades/bulk', { method: 'POST', body: { trades } });
}

export function submitTradeCorrection(
  originalTradeId: string,
  payload: TradeCorrectionPayload
) {
  return refRequest<TradeOut>(
    `/trades/${encodeURIComponent(originalTradeId)}/corrections`,
    { method: 'POST', body: payload }
  );
}

export function submitDividend(payload: DividendRequest) {
  return refRequest<DividendOut>('/dividends', { method: 'POST', body: payload });
}

export function submitDividendsBulk(dividends: DividendRequest[]) {
  return refRequest<DividendOut[]>('/dividends/bulk', {
    method: 'POST',
    body: { dividends },
  });
}

export type DividendListRow = {
  scope_id?: string | null;
  instrument_id?: string | null;
  dividend_id?: string | null;
  gross_native?: number | null;
  withholding_native?: number | null;
  currency?: string | null;
  source?: string | null;
  correction_of?: string | null;
  event_ts: number;
};

export function listDividends(portfolioId: string) {
  return refRequest<DividendListRow[]>(
    `/dividends?portfolio_id=${encodeURIComponent(portfolioId)}`,
  );
}

export function submitCashflow(payload: CashflowRequest) {
  return refRequest<CashflowOut>('/cashflows', { method: 'POST', body: payload });
}

export function submitCashflowsBulk(cashflows: CashflowRequest[]) {
  return refRequest<CashflowOut[]>('/cashflows/bulk', {
    method: 'POST',
    body: { cashflows },
  });
}

export type CashflowListRow = {
  scope_id?: string | null;
  cashflow_id?: string | null;
  type?: string | null;
  amount_native?: number | null;
  currency?: string | null;
  source?: string | null;
  correction_of?: string | null;
  event_ts: number;
};

export function listCashflows(portfolioId: string) {
  return refRequest<CashflowListRow[]>(
    `/cashflows?portfolio_id=${encodeURIComponent(portfolioId)}`,
  );
}

export function submitFxConversion(payload: FxConversionRequest) {
  return refRequest<FxConversionOut>('/fx-conversions', { method: 'POST', body: payload });
}

export function submitFxConversionsBulk(fxConversions: FxConversionRequest[]) {
  return refRequest<FxConversionOut[]>('/fx-conversions/bulk', {
    method: 'POST',
    body: { fx_conversions: fxConversions },
  });
}

export type FxConversionListRow = {
  scope_id?: string | null;
  fx_conversion_id?: string | null;
  from_currency?: string | null;
  from_amount?: number | null;
  to_currency?: string | null;
  to_amount?: number | null;
  rate?: number | null;
  fees_native?: number | null;
  fees_currency?: string | null;
  correction_of?: string | null;
  event_ts: number;
};

export function listFxConversions(portfolioId: string) {
  return refRequest<FxConversionListRow[]>(
    `/fx-conversions?portfolio_id=${encodeURIComponent(portfolioId)}`,
  );
}

export function submitTransferIn(payload: TransferInRequest) {
  return refRequest<TransferInOut>('/transfer-ins', { method: 'POST', body: payload });
}

export function submitTransferInsBulk(transferIns: TransferInRequest[]) {
  return refRequest<TransferInOut[]>('/transfer-ins/bulk', {
    method: 'POST',
    body: { transfer_ins: transferIns },
  });
}

export type TransferInListRow = {
  scope_id?: string | null;
  instrument_id?: string | null;
  transfer_id?: string | null;
  lot_id?: string | null;
  quantity?: number | null;
  cost_basis_native?: number | null;
  currency?: string | null;
  acquisition_date?: number | null;
  fx_rate_at_acquisition?: number | null;
  correction_of?: string | null;
  event_ts: number;
};

export function listTransferIns(portfolioId: string) {
  return refRequest<TransferInListRow[]>(
    `/transfer-ins?portfolio_id=${encodeURIComponent(portfolioId)}`,
  );
}

// --- Option lifecycle + marks ----------------------------------------------

export type DeliveredSide = 'buy' | 'sell';

type OptionDeliveryBase = {
  portfolio_id: string;
  instrument_id: string;
  underlying_id: string;
  settlement_price: number;
  delivered_qty: number;
  delivered_side: DeliveredSide;
  currency: string;
  updated_by: string;
  event_ts?: number;
  correction_of?: string;
};

export type OptionExerciseRequest = OptionDeliveryBase & {
  exercise_id?: string;
};

export type OptionAssignmentRequest = OptionDeliveryBase & {
  assignment_id?: string;
};

export type OptionExpiryRequest = {
  portfolio_id: string;
  instrument_id: string;
  currency: string;
  updated_by: string;
  event_ts?: number;
  expiry_id?: string;
  correction_of?: string;
};

export type OptionLifecycleOut = {
  portfolio_id: string;
  instrument_id: string;
  event_type: 'OPTION_EXERCISE' | 'OPTION_ASSIGNMENT' | 'OPTION_EXPIRY';
  source_id: string;
  underlying_id?: string | null;
  settlement_price?: number | null;
  delivered_qty?: number | null;
  delivered_side?: DeliveredSide | null;
  currency: string;
  event_ts: number;
  observation_id: string;
  correction_of?: string | null;
};

export type OptionMarkRequest = {
  instrument_id: string;
  observed_at: number;
  close: number;
  currency: string;
  updated_by: string;
  source?: string;
};

export type OptionMarkOut = {
  instrument_id: string;
  observed_at: number;
  close: number;
  currency: string;
  source: string;
  source_namespace: string;
};

export function submitOptionExercise(payload: OptionExerciseRequest) {
  return refRequest<OptionLifecycleOut>('/option_exercises', { method: 'POST', body: payload });
}

export function submitOptionAssignment(payload: OptionAssignmentRequest) {
  return refRequest<OptionLifecycleOut>('/option_assignments', { method: 'POST', body: payload });
}

export function submitOptionExpiry(payload: OptionExpiryRequest) {
  return refRequest<OptionLifecycleOut>('/option_expiries', { method: 'POST', body: payload });
}

export function submitOptionMark(payload: OptionMarkRequest) {
  return refRequest<OptionMarkOut>('/option_marks', { method: 'POST', body: payload });
}

// --- Instrument registration (parser-owned) ---------------------------------

// One row the parser emits for every instrument it sees in a statement —
// equity, option, or option-implied underlying. The parser carries enough info
// (kind + option fields when applicable) that no server-side defaulting or
// kind inference is needed downstream; identity is stamped onto trade events.
export type InstrumentRegistration = {
  instrument_id: string;
  kind: InstrumentKind;
  currency: string | null;
  underlying_id?: string;
  strike?: number;
  expiry_date?: string;
  option_type?: OptionType;
  contract_multiplier?: number;
};
