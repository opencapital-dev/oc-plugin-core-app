import { readFileSync } from 'fs';
import { resolve } from 'path';

import { brokerRowsToEvents, parseCsv } from '../index';

const IBKR_FIXTURE = resolve(
  __dirname,
  '../../../../../broker_data/ibkr_ignacio/U11120332_20260101_20260501.csv',
);

const T212_CSV = `Action,Time,ISIN,Ticker,Name,No. of shares,Price / share,Currency (Price / share),Exchange rate,Currency (Total),Total,ID
Deposit,2024-01-15 10:00:00,,,,,,,,GBP,500,DEP-001
Market buy,2024-01-16 14:30:00,US0378331005,AAPL,Apple Inc,1,180,USD,1.27,GBP,141.73,T-001
`;

describe('broker registry dispatch', () => {
  test('auto-detect picks IBKR on Activity Statement shape', () => {
    const grid = parseCsv(readFileSync(IBKR_FIXTURE, 'utf8').trim());
    const r = brokerRowsToEvents(grid, {
      portfolio_id: 'p',
      venue_default: 'XNAS',
      updated_by: 't',
      portfolio_base_currency: 'CHF',
    });
    expect(r.format).toBe('ibkr_statement');
  });

  test('auto-detect picks T212 on flat-row shape', () => {
    const grid = parseCsv(T212_CSV.trim());
    const r = brokerRowsToEvents(grid, {
      portfolio_id: 'p',
      venue_default: 'XLON',
      updated_by: 't',
      portfolio_base_currency: 'GBP',
    });
    expect(r.format).toBe('t212');
  });

  test('explicit format overrides the sniffer', () => {
    const ibkrGrid = parseCsv(readFileSync(IBKR_FIXTURE, 'utf8').trim());
    const forcedT212 = brokerRowsToEvents(
      ibkrGrid,
      {
        portfolio_id: 'p',
        venue_default: 'XNAS',
        updated_by: 't',
      },
      't212',
    );
    expect(forcedT212.format).toBe('t212');

    const t212Grid = parseCsv(T212_CSV.trim());
    const forcedIbkr = brokerRowsToEvents(
      t212Grid,
      {
        portfolio_id: 'p',
        venue_default: 'XLON',
        updated_by: 't',
      },
      'ibkr_statement',
    );
    expect(forcedIbkr.format).toBe('ibkr_statement');
  });
});
