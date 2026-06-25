import type { BrokerImportResult } from '../import/types';
import type { EventInput, EventRow, EventType } from './types';

// Envelope keys live as columns on EventRow; everything else is payload.
const ENVELOPE = new Set(['event_type', 'source_id', 'portfolio_id', 'updated_by', 'event_ts', 'instrument_id']);

// brokerResultToInputs flattens the importer's typed arrays into the unified
// write shape. OPTION_MARK is excluded — it is a data_log price, not an event.
export function brokerResultToInputs(r: BrokerImportResult): EventInput[] {
  const out: EventInput[] = [];
  const push = (type: EventType, items: Array<Record<string, unknown>>) => {
    for (const it of items) {
      out.push({ ...(it as object), event_type: type } as EventInput);
    }
  };
  push('TRADE', r.trades);
  push('DIVIDEND', r.dividends);
  push('CASHFLOW', r.cashflows);
  push('FX_CONVERSION', r.fxConversions);
  push('TRANSFER_IN', r.transferIns);
  push('OPTION_EXERCISE', r.optionExercises);
  push('OPTION_ASSIGNMENT', r.optionAssignments);
  push('OPTION_EXPIRY', r.optionExpiries);
  return out;
}

// inputsToRows projects write inputs into display rows so the events table can
// preview parsed-but-unsaved events. source_id is a synthetic preview key.
export function inputsToRows(inputs: EventInput[]): EventRow[] {
  return inputs.map((input, i) => {
    const payload: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
      if (!ENVELOPE.has(k)) {
        payload[k] = v;
      }
    }
    return {
      source_id: `preview-${i}`,
      event_type: input.event_type,
      instrument_id: (input.instrument_id as string) ?? null,
      business_ts: (input.event_ts as number) ?? Date.now() * 1000,
      payload,
    };
  });
}
