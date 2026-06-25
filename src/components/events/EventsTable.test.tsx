import { filterAndSortEvents } from './EventsTable';
import type { EventRow } from '../../lib/events/types';

const rows: EventRow[] = [
  { source_id: 'a', event_type: 'TRADE', instrument_id: 'KBR', business_ts: 200,
    payload: { side: 'buy', price: 1, quantity: 1, currency: 'USD' } },
  { source_id: 'b', event_type: 'CASHFLOW', instrument_id: null, business_ts: 300,
    payload: { type: 'DEPOSIT', amount_native: 5, currency: 'GBP' } },
  { source_id: 'c', event_type: 'TRADE', instrument_id: 'CHTR', business_ts: 100,
    payload: { side: 'sell', price: 2, quantity: 3, currency: 'USD' } },
];

describe('filterAndSortEvents', () => {
  it('sorts by business_ts desc by default', () => {
    const out = filterAndSortEvents(rows, { query: '', family: 'all', sortDir: 'desc' });
    expect(out.map((r) => r.source_id)).toEqual(['b', 'a', 'c']);
  });

  it('filters by free-text search across instrument + type', () => {
    const out = filterAndSortEvents(rows, { query: 'chtr', family: 'all', sortDir: 'desc' });
    expect(out.map((r) => r.source_id)).toEqual(['c']);
  });

  it('filters by family (trade family excludes cashflow)', () => {
    const out = filterAndSortEvents(rows, { query: '', family: 'trade', sortDir: 'desc' });
    expect(out.every((r) => r.event_type === 'TRADE')).toBe(true);
    expect(out).toHaveLength(2);
  });
});
