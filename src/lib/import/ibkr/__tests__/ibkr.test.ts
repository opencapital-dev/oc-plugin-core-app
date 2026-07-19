import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

import { brokerRowsToEvents, parseCsv, simulateImportedCash } from '../../index';

// Real broker statement kept outside the repo (personal data). Suites are
// skipped wherever the file is absent — CI, other machines.
const FIXTURE = resolve(
  __dirname,
  '../../../../../../broker_data/ibkr_ignacio/U11120332_20260101_20260501.csv',
);
const describeFixture = existsSync(FIXTURE) ? describe : describe.skip;

describeFixture('IBKR Activity Statement parser (real fixture)', () => {
  let parsed: ReturnType<typeof brokerRowsToEvents>;

  beforeAll(() => {
    const grid = parseCsv(readFileSync(FIXTURE, 'utf8').trim());
    parsed = brokerRowsToEvents(
      grid,
      {
        portfolio_id: 'p-ibkr-test',
        venue_default: 'XNAS',
        updated_by: 'test',
        portfolio_base_currency: 'CHF',
      },
      'ibkr_statement',
    );
  });

  test('detects format + statement metadata', () => {
    expect(parsed.format).toBe('ibkr_statement');
    expect(parsed.account).toBe('U11120332');
    expect(parsed.baseCurrency).toBe('CHF');
    expect(parsed.period).not.toBeNull();
    const periodStartIso = new Date(parsed.period!.start / 1000).toISOString();
    const periodEndIso = new Date(parsed.period!.end / 1000).toISOString();
    expect(periodStartIso.startsWith('2026-01-01')).toBe(true);
    expect(periodEndIso.startsWith('2026-05-02')).toBe(true);
  });

  test('maps Financial Instrument Information to ISINs', () => {
    expect(parsed.isins?.get('META')).toBe('US30303M1027');
    expect(parsed.isins?.get('ADBE')).toBe('US00724F1012');
    expect(parsed.isins?.get('EMIM')).toBe('IE00BKM4GZ66');
  });

  test('extracts 8 stock trades with correct sides and currencies', () => {
    expect(parsed.trades).toHaveLength(8);
    const goog = parsed.trades.find((t) => t.instrument_id === 'GOOG');
    expect(goog?.side).toBe('sell');
    expect(goog?.currency).toBe('USD');
    expect(goog?.quantity).toBe(3);
    const adbe = parsed.trades.find((t) => t.instrument_id === 'ADBE');
    expect(adbe?.side).toBe('buy');
    expect(adbe?.currency).toBe('USD');
    const eurTrades = parsed.trades.filter((t) => t.currency === 'EUR');
    expect(eurTrades).toHaveLength(6); // 1 EMIM + 2 IUSN + 3 IWDA
  });

  test('trade price derived from Proceeds, not rounded T.Price', () => {
    // IBKR's T.Price is a rounded display value. For a fractional-share
    // trade, quantity * price must reproduce the statement's true
    // Proceeds, not quantity * the rounded display price.
    const emim = parsed.trades.find((t) => t.instrument_id === 'EMIM');
    expect(emim).toBeDefined();
    expect(emim!.quantity).toBeCloseTo(12.5442, 6);
    // Proceeds for this row is 544.994402; quantity * the rounded
    // T.Price (43.446182427) would be 544.997602 — off by 0.0032.
    expect(emim!.quantity * emim!.price).toBeCloseTo(544.994402, 4);
    expect(emim!.quantity * emim!.price).not.toBeCloseTo(544.997602, 4);
  });

  test('extracts 18 forex conversions with raw broker timestamps', () => {
    expect(parsed.fxConversions).toHaveLength(18);
    for (const fx of parsed.fxConversions) {
      expect(fx.from_amount).toBeGreaterThan(0);
      expect(fx.to_amount).toBeGreaterThan(0);
      expect(fx.rate).toBeGreaterThan(0);
    }
    // Forex `event_ts` should reflect the actual broker stamp, not a
    // shifted value — within the statement's stated period.
    for (const fx of parsed.fxConversions) {
      expect(fx.event_ts!).toBeGreaterThan(parsed.period!.start);
      expect(fx.event_ts!).toBeLessThan(parsed.period!.end);
    }
  });

  test('pairs META dividend with US withholding tax', () => {
    expect(parsed.dividends).toHaveLength(1);
    const meta = parsed.dividends[0]!;
    expect(meta.instrument_id).toBe('META');
    expect(meta.currency).toBe('USD');
    expect(meta.gross_native).toBeCloseTo(2.37, 6);
    expect(meta.withholding_native).toBeCloseTo(0.36, 6);
  });

  test('extracts 2 CHF explicit deposits', () => {
    const explicit = parsed.cashflows.filter((c) =>
      c.cashflow_id?.startsWith('ibkr-deposit-'),
    );
    expect(explicit).toHaveLength(2);
    for (const c of explicit) {
      expect(c.type).toBe('DEPOSIT');
      expect(c.currency).toBe('CHF');
    }
    expect(explicit.reduce((s, c) => s + c.amount_native, 0)).toBeCloseTo(15000, 6);
  });

  test('does not synthesise Starting Cash deposits', () => {
    // IBKR's "Starting Cash" is the prior period's ending balance, which
    // a complete import history already carries forward — synthesising a
    // DEPOSIT from it double-counts on every statement past the first.
    const opening = parsed.cashflows.filter((c) =>
      c.cashflow_id?.startsWith('ibkr-starting-cash-'),
    );
    expect(opening).toHaveLength(0);
  });

  test('no parser errors and no transfer-ins synthesised', () => {
    expect(parsed.errors).toEqual([]);
    expect(parsed.transferIns).toEqual([]);
  });

  test('cash simulation surfaces the opening-balance gap on a mid-history statement', () => {
    // This fixture is the 2026 statement — not the portfolio's first.
    // With Starting Cash no longer synthesised, the per-file sim seeds
    // every currency from 0 and cannot see the balance carried in from
    // 2025. So it flags overdrafts — but each is bounded by that small
    // carried-in opening balance (EUR ~7.77, CHF ~1.58), not a real
    // funding shortfall.
    const sim = simulateImportedCash(parsed, parsed.format);
    expect(sim.errors.length).toBeGreaterThan(0);
    for (const [, points] of Object.entries(sim.timelines)) {
      for (const p of points) {
        expect(p.running).toBeGreaterThan(-10);
      }
    }
  });
});

describeFixture('IBKR parser via auto-detect', () => {
  let grid: ReturnType<typeof parseCsv>;

  beforeAll(() => {
    grid = parseCsv(readFileSync(FIXTURE, 'utf8').trim());
  });

  test('auto-detect picks ibkr_statement on the same fixture', () => {
    const auto = brokerRowsToEvents(grid, {
      portfolio_id: 'p-ibkr-test',
      venue_default: 'XNAS',
      updated_by: 'test',
      portfolio_base_currency: 'CHF',
    });
    expect(auto.format).toBe('ibkr_statement');
    expect(auto.trades).toHaveLength(8);
    expect(auto.fxConversions).toHaveLength(18);
  });

  test('explicit t212 override on an IBKR file yields no events', () => {
    const forced = brokerRowsToEvents(
      grid,
      {
        portfolio_id: 'p-ibkr-test',
        venue_default: 'XNAS',
        updated_by: 'test',
      },
      't212',
    );
    expect(forced.format).toBe('t212');
    expect(forced.trades).toEqual([]);
    expect(forced.dividends).toEqual([]);
  });
});
