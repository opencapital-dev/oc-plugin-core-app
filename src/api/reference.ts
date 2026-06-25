import { refRequest } from './client';
import type { EventInput, EventRow } from '../lib/events/types';

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

export type CashflowRequest = {
  portfolio_id: string;
  type: CashflowType;
  amount_native: number;
  currency: string;
  updated_by: string;
  cashflow_id?: string;
  event_ts?: number;
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

export function listEvents(portfolioId: string) {
  return refRequest<EventRow[]>(`/events?portfolio_id=${encodeURIComponent(portfolioId)}`);
}

export function writeEvent(input: EventInput) {
  return refRequest<{ status: string }>('/events', { method: 'POST', body: input });
}

export function writeEventsBulk(inputs: EventInput[]) {
  return refRequest<{ status: string; count: number }>('/events/bulk', {
    method: 'POST',
    body: inputs,
  });
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

export type OptionMarkRequest = {
  instrument_id: string;
  observed_at: number;
  close: number;
  currency: string;
  updated_by: string;
  source?: string;
};

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
