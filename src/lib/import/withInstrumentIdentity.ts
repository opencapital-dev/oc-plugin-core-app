import type { TradeRequest, InstrumentRegistration } from '../../api/reference';

/** Stamp each trade with its instrument's kind + contract_multiplier (looked up
 *  from the parsed registrations by instrument_id) so the published event is
 *  self-describing. Pure — returns new objects, does not mutate the input. */
export function withInstrumentIdentity(
  trades: TradeRequest[],
  registrations: InstrumentRegistration[],
): TradeRequest[] {
  const byId = new Map(registrations.map((r) => [r.instrument_id, r]));
  return trades.map((t) => {
    const reg = byId.get(t.instrument_id);
    return { ...t, instrument_kind: reg?.kind ?? 'equity', contract_multiplier: reg?.contract_multiplier ?? 1 };
  });
}
