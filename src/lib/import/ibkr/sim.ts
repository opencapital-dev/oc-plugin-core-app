import type { BrokerImportResult, CashBucketSimResult } from '../types';
import { dayKeyUtc, endOfDayMicros } from '../shared/helpers';

/**
 * IBKR cash-bucket simulation. Multi-currency, per-calendar-day aggregation.
 *
 * IBKR's matching engine on a cash account enforces "trade must be funded
 * within the same day" via AutoFx settlement that's journalled seconds (or
 * hours, for the 17:00-ET end-of-day sweep) *after* the trade it funds.
 * Strict microsecond ordering flags those as transient overdrafts even
 * though the broker's daily reconciliation balances out. Aggregating per
 * calendar day matches the granularity the broker actually enforces.
 *
 * For each currency we sum signed credits/debits per UTC day, carry the
 * running balance across days, and emit one timeline point per day (with
 * end-of-day UTC microsecond stamp). An error appears when any day-closing
 * balance is negative.
 */
export function ibkrSim(parsed: BrokerImportResult): CashBucketSimResult {
  type Evt = { ts: number; ccy: string; signed: number };
  const events: Evt[] = [];

  for (const c of parsed.cashflows) {
    const ts = c.event_ts ?? 0;
    const ccy = c.currency.toUpperCase();
    const signed =
      c.type === 'DEPOSIT' || c.type === 'INTEREST_ON_CASH'
        ? c.amount_native
        : -c.amount_native;
    events.push({ ts, ccy, signed });
  }

  for (const t of parsed.trades) {
    if (!t.currency) {continue;}
    const ts = t.event_ts ?? 0;
    const ccy = t.currency.toUpperCase();
    const gross = t.quantity * t.price;
    const settle =
      t.side === 'buy'
        ? gross + (t.commission ?? 0) + (t.fees ?? 0)
        : gross - (t.commission ?? 0) - (t.fees ?? 0);
    events.push({ ts, ccy, signed: t.side === 'buy' ? -settle : +settle });
  }

  for (const d of parsed.dividends) {
    const ts = d.event_ts ?? 0;
    const ccy = d.currency.toUpperCase();
    const net = d.gross_native - (d.withholding_native ?? 0);
    if (net <= 0) {continue;}
    events.push({ ts, ccy, signed: +net });
  }

  for (const fx of parsed.fxConversions) {
    const ts = fx.event_ts ?? 0;
    events.push({ ts, ccy: fx.from_currency.toUpperCase(), signed: -fx.from_amount });
    events.push({ ts, ccy: fx.to_currency.toUpperCase(), signed: +fx.to_amount });
    if (fx.fees_native && fx.fees_currency) {
      events.push({ ts, ccy: fx.fees_currency.toUpperCase(), signed: -fx.fees_native });
    }
  }

  // Group by (ccy, day). One Map of currency -> Map of dayKey -> sumOfDeltas.
  const dailyDeltas: Record<string, Map<string, number>> = {};
  for (const ev of events) {
    const day = dayKeyUtc(ev.ts);
    if (!dailyDeltas[ev.ccy]) {dailyDeltas[ev.ccy] = new Map();}
    const cur = dailyDeltas[ev.ccy]!;
    cur.set(day, (cur.get(day) ?? 0) + ev.signed);
  }

  const timelines: Record<string, Array<{ ts: number; running: number; source: string }>> = {};
  const errors: string[] = [];
  // Cents-level tolerance: floating-point rounding across hundreds of
  // multi-currency legs accumulates to micros, not full cents.
  const EPS = 1e-6;

  for (const ccy of Object.keys(dailyDeltas)) {
    const days = Array.from(dailyDeltas[ccy]!.keys()).sort();
    let running = 0;
    timelines[ccy] = [];
    for (const day of days) {
      const delta = dailyDeltas[ccy]!.get(day)!;
      running += delta;
      timelines[ccy].push({
        ts: endOfDayMicros(day),
        running,
        source: `eod-${ccy}-${day}`,
      });
      if (running < -EPS) {
        errors.push(
          `${ccy} bucket closes ${day} negative: running=${running.toFixed(2)}. ` +
            `Same-day debits exceeded credits + carried balance.`,
        );
      }
    }
  }

  return { timelines, errors };
}
