// Event types that live in portfolio_events_log and appear in the events table.
// OPTION_MARK is intentionally excluded — it is a data_log price, not an event.
export type EventType =
  | 'TRADE'
  | 'DIVIDEND'
  | 'CASHFLOW'
  | 'FX_CONVERSION'
  | 'TRANSFER_IN'
  | 'OPTION_EXERCISE'
  | 'OPTION_ASSIGNMENT'
  | 'OPTION_EXPIRY';

// Unified read shape returned by GET /ref/events.
export type EventRow = {
  source_id: string;
  event_type: EventType;
  instrument_id: string | null;
  business_ts: number; // epoch micros
  payload: Record<string, unknown>;
};

// Unified write shape sent to POST /ref/events. Carries the discriminant plus
// the type-specific fields the Go builder expects. `source_id` present = edit
// (the builder reuses it as the row id and upserts); absent = create.
export type EventInput = {
  event_type: EventType;
  source_id?: string;
  portfolio_id: string;
  updated_by: string;
  event_ts?: number;
  instrument_id?: string;
} & Record<string, unknown>;
