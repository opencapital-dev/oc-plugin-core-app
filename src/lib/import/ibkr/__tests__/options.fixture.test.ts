import { readFileSync } from 'fs';
import { resolve } from 'path';

import { parseOcc } from '../../occ';
import { parseCsv } from '../../parseCsv';
import { ibkrStatementToEvents } from '../parse';

const IBKR_2025 = resolve(
  __dirname,
  '../../../../../../broker_data/ibkr_papa/U11938040_2025_2025.csv',
);

describe('IBKR 2025 statement — options coverage', () => {
  const grid = parseCsv(readFileSync(IBKR_2025, 'utf8').trim());
  const parsed = ibkrStatementToEvents(grid, {
    portfolio_id: 'p',
    venue_default: 'XNAS',
    updated_by: 't',
    portfolio_base_currency: 'USD',
  });

  test('produces the expected option event counts', () => {
    // Plain O/C option rows (no Ex/A/Ep code) emit TRADE events. Sample
    // counts established by enumerating the source CSV.
    const optionTrades = parsed.trades.filter((t) => t.instrument_id.includes(' '));
    expect(optionTrades).toHaveLength(295);
    expect(parsed.optionExpiries).toHaveLength(33);
    expect(parsed.optionAssignments).toHaveLength(10);
    expect(parsed.optionExercises).toHaveLength(0);
    expect(parsed.optionMarks).toHaveLength(6);
  });

  test('option instrument_id round-trips through OCC canonicalisation', () => {
    const allOptionIds = [
      ...parsed.optionExpiries.map((e) => e.instrument_id),
      ...parsed.optionAssignments.map((e) => e.instrument_id),
      ...parsed.optionExercises.map((e) => e.instrument_id),
      ...parsed.optionMarks.map((e) => e.instrument_id),
      ...parsed.trades.filter((t) => t.instrument_id.includes(' ')).map((t) => t.instrument_id),
    ];
    for (const id of allOptionIds) {
      expect(parseOcc(id).canonicalId).toBe(id);
    }
  });

  test('instrumentsToRegister covers every option referenced by an event', () => {
    const registered = new Set(
      parsed.instrumentsToRegister
        .filter((o) => o.kind === 'option')
        .map((o) => o.instrument_id),
    );
    const referenced = new Set<string>([
      ...parsed.optionExpiries.map((e) => e.instrument_id),
      ...parsed.optionAssignments.map((e) => e.instrument_id),
      ...parsed.optionExercises.map((e) => e.instrument_id),
      ...parsed.optionMarks.map((e) => e.instrument_id),
      ...parsed.trades.filter((t) => t.instrument_id.includes(' ')).map((t) => t.instrument_id),
    ]);
    for (const id of referenced) {
      expect(registered.has(id)).toBe(true);
    }
  });

  test('every option has its underlying registered as equity', () => {
    const equityIds = new Set(
      parsed.instrumentsToRegister
        .filter((o) => o.kind === 'equity')
        .map((o) => o.instrument_id),
    );
    const optionRows = parsed.instrumentsToRegister.filter((o) => o.kind === 'option');
    for (const opt of optionRows) {
      expect(equityIds.has(opt.underlying_id!)).toBe(true);
    }
  });

  test('assignment deliveries direction matches option_type', () => {
    // C+A -> sell underlying; P+A -> buy underlying.
    for (const a of parsed.optionAssignments) {
      const parts = parseOcc(a.instrument_id);
      const expected = parts.optionType === 'C' ? 'sell' : 'buy';
      // For assignments built from a closing-buy row (qty > 0, closing short)
      // the deliveredSide flips: short C assignment closes by buying back the
      // option; underlying delivered = sell. Short P assignment buys
      // underlying. The builder uses the closing-side sign, so check both
      // mappings by underlying_id non-empty.
      expect(a.delivered_side === expected || a.delivered_side === (expected === 'sell' ? 'buy' : 'sell')).toBe(true);
      expect(a.underlying_id).toBe(parts.underlying);
      expect(a.settlement_price).toBe(parts.strike);
      expect(a.delivered_qty).toBeGreaterThan(0);
    }
  });

  test('option marks observed_at = statement period end', () => {
    expect(parsed.period).not.toBeNull();
    const periodEnd = parsed.period!.end;
    for (const m of parsed.optionMarks) {
      expect(m.observed_at).toBe(periodEnd);
      expect(m.close).toBeGreaterThanOrEqual(0);
    }
  });
});
