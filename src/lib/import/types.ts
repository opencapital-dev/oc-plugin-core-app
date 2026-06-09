import type {
  CashflowRequest,
  CashflowType,
  DividendRequest,
  FxConversionRequest,
  InstrumentRegistration,
  OptionAssignmentRequest,
  OptionExerciseRequest,
  OptionExpiryRequest,
  OptionMarkRequest,
  TradeRequest,
  TransferInRequest,
} from '../../api/reference';

export type BrokerFormat = 't212' | 'ibkr_statement';

export type TradeSide = 'buy' | 'sell';

export type ImportOptions = {
  portfolio_id: string;
  venue_default: string;
  updated_by: string;
  portfolio_base_currency?: string;
  // Operator-supplied FX rate overrides (cash_native -> base) for events the
  // broker statement doesn't carry a rate for. Keyed by deterministic event
  // id (dividendFxRates[dividend_id] / interestFxRates[cashflow_id]).
  dividendFxRates?: Record<string, number>;
  interestFxRates?: Record<string, number>;
};

export type BrokerImportResult = {
  trades: TradeRequest[];
  dividends: DividendRequest[];
  cashflows: CashflowRequest[];
  fxConversions: FxConversionRequest[];
  transferIns: TransferInRequest[];
  optionExercises: OptionExerciseRequest[];
  optionAssignments: OptionAssignmentRequest[];
  optionExpiries: OptionExpiryRequest[];
  optionMarks: OptionMarkRequest[];
  // Unified instrument-identity output. Parser tags each row with its kind
  // and (for options) the OCC-parsed fields + multiplier. ImportPage POSTs
  // these in order; no kind inference happens downstream.
  instrumentsToRegister: InstrumentRegistration[];
  skipped: number;
  errors: string[];
};

export type CashBucketSimResult = {
  // Per-key running balance timeline. Key is currency code; entries are
  // either per-event (T212, microsecond-ordered) or per-day end-of-day
  // (IBKR). Banner code iterates by key without caring which granularity.
  timelines: Record<string, { ts: number; running: number; source: string }[]>;
  errors: string[];
};

export type IbkrStatementMeta = {
  account: string;
  baseCurrency: string;
  period: { start: number; end: number } | null;
  isins: Map<string, string>;
};

export type ParseResult = BrokerImportResult & {
  format: BrokerFormat;
  // IBKR-only metadata. Empty/null for other brokers.
  account?: string;
  baseCurrency?: string;
  period?: { start: number; end: number } | null;
  isins?: Map<string, string>;
};

export interface BrokerImporter {
  readonly format: BrokerFormat;
  detect(grid: string[][]): boolean;
  parse(grid: string[][], options: ImportOptions): Omit<ParseResult, 'format'>;
  simulate(parsed: BrokerImportResult): CashBucketSimResult;
}

export type {
  CashflowRequest,
  CashflowType,
  DividendRequest,
  FxConversionRequest,
  InstrumentRegistration,
  OptionAssignmentRequest,
  OptionExerciseRequest,
  OptionExpiryRequest,
  OptionMarkRequest,
  TradeRequest,
  TransferInRequest,
};
