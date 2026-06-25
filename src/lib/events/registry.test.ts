import { EVENT_REGISTRY } from './registry';
import type { EventRow } from './types';

const tradeRow: EventRow = {
  source_id: 'src-1',
  event_type: 'TRADE',
  instrument_id: 'KBR',
  business_ts: 1_700_000_000_000_000,
  payload: { side: 'buy', price: 32.1, quantity: 25, currency: 'USD', venue: 'XLON' },
};

describe('event registry', () => {
  it('summarises a trade for the table', () => {
    const s = EVENT_REGISTRY.TRADE.summary(tradeRow);
    expect(s.instrument).toBe('KBR');
    expect(s.side.toLowerCase()).toBe('buy');
    expect(s.currency).toBe('USD');
    expect(s.amount).toContain('25');
  });

  it('round-trips a trade row through fromRow -> toInput', () => {
    const def = EVENT_REGISTRY.TRADE;
    const input = def.toInput(def.fromRow(tradeRow), 'pf-1');
    expect(input.event_type).toBe('TRADE');
    expect(input.source_id).toBe('src-1'); // edit reuses the row id
    expect(input.portfolio_id).toBe('pf-1');
    expect(input.instrument_id).toBe('KBR');
    expect(input.side).toBe('buy');
    expect(input.price).toBe(32.1);
    expect(input.quantity).toBe(25);
    expect(input.currency).toBe('USD');
  });

  it('round-trips a cashflow row (no instrument)', () => {
    const row: EventRow = {
      source_id: 'src-2',
      event_type: 'CASHFLOW',
      instrument_id: null,
      business_ts: 1_700_000_000_000_000,
      payload: { type: 'INTEREST_ON_CASH', amount_native: 0.25, currency: 'GBP' },
    };
    const def = EVENT_REGISTRY.CASHFLOW;
    const input = def.toInput(def.fromRow(row), 'pf-1');
    expect(input.event_type).toBe('CASHFLOW');
    expect(input.type).toBe('INTEREST_ON_CASH');
    expect(input.amount_native).toBe(0.25);
    expect(input.currency).toBe('GBP');
  });
});
