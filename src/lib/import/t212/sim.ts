import type { BrokerImportResult, CashBucketSimResult } from '../types';

/**
 * Per-currency cash-bucket simulation tuned to Trading 212's bundled-trade
 * model. Walks events in microsecond order; flags any moment a currency
 * bucket would go negative.
 *
 * BUNDLED trades carry `fx_rate_to_base` — the broker auto-converted at
 * trade time so the trade currency nets to zero (debit + credit) and only
 * the base currency moves. We skip the trade-ccy leg for those; the base
 * leg is implicit in T212's reporting and isn't itself a cash event we
 * need to simulate. Same for bundled dividends.
 */
export function t212Sim(parsed: BrokerImportResult): CashBucketSimResult {
  type Evt = { ts: number; ccy: string; signed: number; source: string };
  const events: Evt[] = [];

  for (const c of parsed.cashflows) {
    const ts = c.event_ts ?? 0;
    const ccy = c.currency.toUpperCase();
    const signed =
      c.type === 'DEPOSIT' || c.type === 'INTEREST_ON_CASH'
        ? c.amount_native
        : -c.amount_native;
    events.push({ ts, ccy, signed, source: c.cashflow_id ?? `cf-${ts}-${ccy}` });
  }

  for (const t of parsed.trades) {
    if (!t.currency) continue;
    const ts = t.event_ts ?? 0;
    const ccy = t.currency.toUpperCase();
    const gross = t.quantity * t.price;
    const settle =
      t.side === 'buy'
        ? gross + (t.commission ?? 0) + (t.fees ?? 0)
        : gross - (t.commission ?? 0) - (t.fees ?? 0);
    if (t.fx_rate_to_base && t.fx_rate_to_base > 0) {
      // Bundled — trade ccy nets to zero; skip.
      continue;
    }
    events.push({
      ts,
      ccy,
      signed: t.side === 'buy' ? -settle : +settle,
      source: t.trade_id ?? `t-${ts}-${ccy}`,
    });
  }

  for (const d of parsed.dividends) {
    const ts = d.event_ts ?? 0;
    const ccy = d.currency.toUpperCase();
    const net = d.gross_native - (d.withholding_native ?? 0);
    if (net <= 0) continue;
    if (d.fx_rate_to_base && d.fx_rate_to_base > 0) continue;
    events.push({ ts, ccy, signed: +net, source: d.dividend_id ?? `d-${ts}-${ccy}` });
  }

  for (const fx of parsed.fxConversions) {
    const ts = fx.event_ts ?? 0;
    events.push({
      ts,
      ccy: fx.from_currency.toUpperCase(),
      signed: -fx.from_amount,
      source: `${fx.fx_conversion_id ?? `fx-${ts}`}:debit`,
    });
    events.push({
      ts,
      ccy: fx.to_currency.toUpperCase(),
      signed: +fx.to_amount,
      source: `${fx.fx_conversion_id ?? `fx-${ts}`}:credit`,
    });
    if (fx.fees_native && fx.fees_currency) {
      events.push({
        ts,
        ccy: fx.fees_currency.toUpperCase(),
        signed: -fx.fees_native,
        source: `${fx.fx_conversion_id ?? `fx-${ts}`}:fee`,
      });
    }
  }

  events.sort((a, b) => a.ts - b.ts || a.source.localeCompare(b.source));

  const timelines: Record<string, { ts: number; running: number; source: string }[]> = {};
  const errors: string[] = [];
  const balance: Record<string, number> = {};
  const EPS = 1e-9;
  for (const ev of events) {
    const prior = balance[ev.ccy] ?? 0;
    const next = prior + ev.signed;
    if (next < -EPS) {
      const dateStr = new Date(ev.ts / 1000).toISOString().slice(0, 19).replace('T', ' ');
      errors.push(
        `${ev.ccy} bucket would go negative at ${dateStr} (${ev.source}): ` +
          `running=${prior.toFixed(2)} - ${(-ev.signed).toFixed(2)} = ${next.toFixed(2)}. ` +
          `Add an FX conversion or deposit before this point.`,
      );
    }
    balance[ev.ccy] = next;
    if (!timelines[ev.ccy]) timelines[ev.ccy] = [];
    timelines[ev.ccy].push({ ts: ev.ts, running: next, source: ev.source });
  }
  return { timelines, errors };
}
