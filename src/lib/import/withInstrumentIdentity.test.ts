import { withInstrumentIdentity } from './withInstrumentIdentity';
import type { TradeRequest, InstrumentRegistration } from '../../api/reference';

const trade = (instrument_id: string): TradeRequest => ({
  portfolio_id: 'p1', instrument_id, side: 'buy', price: 1, quantity: 1,
  currency: 'USD', venue: 'X', updated_by: 'u',
});

describe('withInstrumentIdentity', () => {
  it('stamps kind + multiplier from the matching registration', () => {
    const regs: InstrumentRegistration[] = [
      { instrument_id: 'OPT1', kind: 'option', currency: 'USD', contract_multiplier: 100 },
    ];
    const [t] = withInstrumentIdentity([trade('OPT1')], regs);
    expect(t.instrument_kind).toBe('option');
    expect(t.contract_multiplier).toBe(100);
  });
  it('defaults to equity / 1 when no registration matches', () => {
    const [t] = withInstrumentIdentity([trade('AAPL')], []);
    expect(t.instrument_kind).toBe('equity');
    expect(t.contract_multiplier).toBe(1);
  });
  it('defaults multiplier to 1 for an equity registration without one', () => {
    const [t] = withInstrumentIdentity([trade('AAPL')], [{ instrument_id: 'AAPL', kind: 'equity', currency: 'USD' }]);
    expect(t.contract_multiplier).toBe(1);
  });
  it('does not mutate the input', () => {
    const trades = [trade('AAPL')];
    withInstrumentIdentity(trades, []);
    expect(trades[0].instrument_kind).toBeUndefined();
  });
});
