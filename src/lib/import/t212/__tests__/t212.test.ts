import { brokerRowsToEvents, parseCsv, simulateImportedCash } from '../../index';

// Hand-authored T212-shaped CSV. Reproduces the broker's published header
// layout for the rows we parse (deposit + cross-currency buy + dividend).
const T212_CSV = `Action,Time,ISIN,Ticker,Name,No. of shares,Price / share,Currency (Price / share),Exchange rate,Currency (Total),Total,Withholding tax,Currency (Withholding tax),FINRA fee,Currency (FINRA fee),Currency conversion fee,Currency (Currency conversion fee),Stamp duty reserve tax,Currency (Stamp duty reserve tax),ID,Notes
Deposit,2024-01-15 10:00:00,,,,,,,,GBP,1000,,,,,,,,,DEP-001,
Market buy,2024-01-16 14:30:00,US0378331005,AAPL,Apple Inc,2,180,USD,1.27,GBP,283.46,,,0.01,USD,0.05,USD,,,T-001,
Dividend (Ordinary),2024-02-10 12:00:00,US0378331005,AAPL,Apple Inc,2,0.25,USD,1.28,GBP,0.39,0.07,USD,,,,,,,DIV-001,
`;

describe('T212 parser', () => {
  const grid = parseCsv(T212_CSV.trim());
  const parsed = brokerRowsToEvents(
    grid,
    {
      portfolio_id: 'p-t212-test',
      venue_default: 'XLON',
      updated_by: 'test',
      portfolio_base_currency: 'GBP',
    },
    't212',
  );

  test('detects T212 format on flat-row layout', () => {
    expect(parsed.format).toBe('t212');
  });

  test('extracts deposit cashflow', () => {
    expect(parsed.cashflows).toHaveLength(1);
    const dep = parsed.cashflows[0]!;
    expect(dep.type).toBe('DEPOSIT');
    expect(dep.currency).toBe('GBP');
    expect(dep.amount_native).toBe(1000);
  });

  test('bundles cross-currency buy with fx_rate_to_base', () => {
    expect(parsed.trades).toHaveLength(1);
    const buy = parsed.trades[0]!;
    expect(buy.instrument_id).toBe('AAPL');
    expect(buy.side).toBe('buy');
    expect(buy.quantity).toBe(2);
    expect(buy.price).toBe(180);
    expect(buy.currency).toBe('USD');
    // T212 reports Exchange rate as trade_ccy_per_base (1.27 USD per GBP).
    // SDK fx_rate_to_base is base_per_native, so 1/1.27 ~= 0.787.
    expect(buy.fx_rate_to_base).toBeCloseTo(1 / 1.27, 6);
    // Fees sum to 0.06 USD (FINRA 0.01 + conv 0.05), no separate FX event.
    expect(buy.fees).toBeCloseTo(0.06, 6);
    expect(parsed.fxConversions).toHaveLength(0);
  });

  test('bundles cross-currency dividend with fx_rate_to_base', () => {
    expect(parsed.dividends).toHaveLength(1);
    const div = parsed.dividends[0]!;
    expect(div.instrument_id).toBe('AAPL');
    expect(div.currency).toBe('USD');
    expect(div.gross_native).toBeCloseTo(0.5, 6); // 2 x 0.25
    // Withholding 0.07 USD already in trade ccy.
    expect(div.withholding_native).toBeCloseTo(0.07, 6);
    expect(div.fx_rate_to_base).toBeCloseTo(1.28, 6);
  });

  test('no parser errors, no transfer-ins, no FX events', () => {
    expect(parsed.errors).toEqual([]);
    expect(parsed.transferIns).toEqual([]);
    expect(parsed.fxConversions).toEqual([]);
  });

  test('single-base-bucket sim is happy (bundled trades skip trade ccy)', () => {
    const sim = simulateImportedCash(parsed, parsed.format);
    expect(sim.errors).toEqual([]);
    // GBP bucket: deposit +1000, no other GBP-side events (bundled trade
    // doesn't move trade-ccy in this sim). Running balance stays at 1000.
    expect(sim.timelines.GBP).toBeDefined();
    expect(sim.timelines.GBP![sim.timelines.GBP!.length - 1]!.running).toBeCloseTo(1000, 6);
  });
});
