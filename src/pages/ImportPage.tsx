import React from 'react';
import { css } from '@emotion/css';
import { useEffect, useMemo, useState } from 'react';

import { AppEvents, type GrafanaTheme2 } from '@grafana/data';
import {
  Alert,
  Badge,
  Button,
  Field,
  FileDropzone,
  Input,
  Select,
  Stack,
  useStyles2,
} from '@grafana/ui';
import { Page } from '../components/Page';
import { appEvents } from '../lib/toast';

import {
  listInstruments,
  listPortfolios,
  submitCashflowsBulk,
  submitDividendsBulk,
  submitFxConversionsBulk,
  submitOptionAssignment,
  submitOptionExercise,
  submitOptionExpiry,
  submitOptionMark,
  submitTradesBulk,
  submitTransferInsBulk,
  type CashflowRequest,
  type DividendRequest,
  type FxConversionRequest,
  type InstrumentEntity,
  type OptionAssignmentRequest,
  type OptionExerciseRequest,
  type OptionExpiryRequest,
  type OptionMarkRequest,
  type PortfolioEntity,
  type TradeRequest,
  type TransferInRequest,
} from '../api/reference';
import type { InstrumentRegistration } from '../lib/import/types';
import { LotsStep } from '../components/import/LotsStep';
import { DEFAULT_UPDATED_BY } from '../lib/attributes';
import {
  brokerRowsToEvents,
  parseCsv,
  simulateImportedCash,
  type BrokerFormat,
} from '../lib/import';
import { withInstrumentIdentity } from '../lib/import/withInstrumentIdentity';
import { formatEventMicros } from '../lib/time';

type Step = 'upload' | 'map' | 'lots' | 'confirm' | 'done';

type Mapping = {
  instrumentId: string;
  tradeCount: number;
  exists: boolean;
  existingCurrency: string | null;
  pickedCurrency: string;
};

type RunResult = {
  instrumentsUpdated: string[];
  tradesImported: number;
  transferInsImported: number;
  dividendsImported: number;
  cashflowsImported: number;
  fxConversionsImported: number;
  optionExercisesImported: number;
  optionAssignmentsImported: number;
  optionExpiriesImported: number;
  optionMarksImported: number;
  errors: string[];
};

type IbkrMeta = {
  account: string;
  baseCurrency: string;
  period: { start: number; end: number } | null;
};

/**
 * Pull a readable message out of whatever the backend (or fetch) threw.
 * `getBackendSrv()` rejects with a `FetchError`-like object that has a
 * nested `data` payload — `String(err)` on it returns "[object Object]"
 * which hides the actual server response from operators.
 */
function errMsg(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === 'string') {
    return err;
  }
  if (err && typeof err === 'object') {
    const anyErr = err as Record<string, unknown>;
    // Grafana FetchError shape: { status, statusText, data: { error, message, detail } }
    const data = anyErr.data;
    if (data && typeof data === 'object') {
      const d = data as Record<string, unknown>;
      const msg = d.error ?? d.message ?? d.detail;
      if (typeof msg === 'string' && msg) {
        return msg;
      }
    }
    if (typeof anyErr.message === 'string' && anyErr.message) {
      return anyErr.message as string;
    }
    if (typeof anyErr.statusText === 'string' && anyErr.statusText) {
      return `${anyErr.status ?? '?'}: ${anyErr.statusText}`;
    }
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

export function ImportPage() {
  const styles = useStyles2(getStyles);

  const [portfolios, setPortfolios] = useState<PortfolioEntity[]>([]);
  const [instruments, setInstruments] = useState<InstrumentEntity[]>([]);

  const [step, setStep] = useState<Step>('upload');
  const [portfolioId, setPortfolioId] = useState('');
  const [defaultVenue, setDefaultVenue] = useState('XLON');
  const [updatedBy, setUpdatedBy] = useState(DEFAULT_UPDATED_BY);
  const [brokerChoice, setBrokerChoice] = useState<BrokerFormat | 'auto'>('auto');

  const [parsedTrades, setParsedTrades] = useState<TradeRequest[]>([]);
  const [parsedDividends, setParsedDividends] = useState<DividendRequest[]>([]);
  const [parsedCashflows, setParsedCashflows] = useState<CashflowRequest[]>([]);
  const [parsedFxConversions, setParsedFxConversions] = useState<FxConversionRequest[]>([]);
  const [parsedTransferIns, setParsedTransferIns] = useState<TransferInRequest[]>([]);
  const [parsedOptionExercises, setParsedOptionExercises] = useState<OptionExerciseRequest[]>([]);
  const [parsedOptionAssignments, setParsedOptionAssignments] = useState<OptionAssignmentRequest[]>([]);
  const [parsedOptionExpiries, setParsedOptionExpiries] = useState<OptionExpiryRequest[]>([]);
  const [parsedOptionMarks, setParsedOptionMarks] = useState<OptionMarkRequest[]>([]);
  const [parsedInstrumentsToRegister, setParsedInstrumentsToRegister] = useState<InstrumentRegistration[]>([]);
  const [skippedRows, setSkippedRows] = useState(0);
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [format, setFormat] = useState<BrokerFormat | null>(null);
  const [ibkrMeta, setIbkrMeta] = useState<IbkrMeta | null>(null);

  const refreshInstruments = async () => {
    if (!portfolioId) {
      return;
    }
    try {
      setInstruments(await listInstruments(portfolioId));
    } catch {
      // Non-fatal; user can retry.
    }
  };

  useEffect(() => {
    void (async () => {
      try {
        setPortfolios(await listPortfolios());
      } catch (err) {
        appEvents.emit(AppEvents.alertError, [
          err instanceof Error ? err.message : 'Failed to load portfolios',
        ]);
      }
    })();
  }, []);

  useEffect(() => {
    if (!portfolioId) {
      setInstruments([]);
      return;
    }
    void (async () => {
      try {
        setInstruments(await listInstruments(portfolioId));
      } catch {
        // Non-fatal.
      }
    })();
  }, [portfolioId]);

  const tradesByInstrument = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of parsedTrades) {
      m.set(t.instrument_id, (m.get(t.instrument_id) ?? 0) + 1);
    }
    return m;
  }, [parsedTrades]);

  function reset() {
    setStep('upload');
    setParsedTrades([]);
    setParsedDividends([]);
    setParsedCashflows([]);
    setParsedFxConversions([]);
    setParsedTransferIns([]);
    setSkippedRows(0);
    setParseErrors([]);
    setMappings([]);
    setResult(null);
    setFormat(null);
    setIbkrMeta(null);
  }

  const selectedPortfolio = portfolios.find((p) => p.portfolio_id === portfolioId) ?? null;
  const baseCurrency = selectedPortfolio?.base_currency;

  const fxByPair = useMemo(() => {
    const m = new Map<string, { count: number; from_total: number; to_total: number }>();
    for (const fx of parsedFxConversions) {
      const k = `${fx.from_currency}→${fx.to_currency}`;
      const cur = m.get(k) ?? { count: 0, from_total: 0, to_total: 0 };
      cur.count += 1;
      cur.from_total += fx.from_amount;
      cur.to_total += fx.to_amount;
      m.set(k, cur);
    }
    return m;
  }, [parsedFxConversions]);

  const cashSim = useMemo(() => {
    if (!format) {
      return { timelines: {}, errors: [] };
    }
    return simulateImportedCash(
      {
        trades: parsedTrades,
        dividends: parsedDividends,
        cashflows: parsedCashflows,
        fxConversions: parsedFxConversions,
        transferIns: parsedTransferIns,
        optionExercises: parsedOptionExercises,
        optionAssignments: parsedOptionAssignments,
        optionExpiries: parsedOptionExpiries,
        optionMarks: parsedOptionMarks,
        instrumentsToRegister: parsedInstrumentsToRegister,
        skipped: 0,
        errors: [],
      },
      format
    );
  }, [
    format,
    parsedTrades,
    parsedDividends,
    parsedCashflows,
    parsedFxConversions,
    parsedTransferIns,
  ]);

  async function handleCsv(text: string) {
    setParseErrors([]);
    setParsedTrades([]);
    setParsedDividends([]);
    setParsedCashflows([]);
    setParsedFxConversions([]);
    setParsedTransferIns([]);
    setParsedOptionExercises([]);
    setParsedOptionAssignments([]);
    setParsedOptionExpiries([]);
    setParsedOptionMarks([]);
    setParsedInstrumentsToRegister([]);
    setMappings([]);
    setSkippedRows(0);
    setFormat(null);
    setIbkrMeta(null);
    if (!portfolioId) {
      appEvents.emit(AppEvents.alertError, ['Pick a portfolio first.']);
      return;
    }
    try {
      const grid = parseCsv(text.trim());
      const portfolio = portfolios.find((p) => p.portfolio_id === portfolioId);
      const r = brokerRowsToEvents(
        grid,
        {
          portfolio_id: portfolioId,
          venue_default: defaultVenue.trim() || 'XLON',
          updated_by: updatedBy.trim() || DEFAULT_UPDATED_BY,
          portfolio_base_currency: portfolio?.base_currency,
        },
        brokerChoice
      );
      setFormat(r.format);

      if (r.format === 'ibkr_statement') {
        const meta: IbkrMeta = {
          account: r.account ?? '',
          baseCurrency: (r.baseCurrency ?? '').toUpperCase(),
          period: r.period ?? null,
        };
        setIbkrMeta(meta);
        const portfolioBase = (portfolio?.base_currency ?? '').toUpperCase();
        if (meta.baseCurrency && portfolioBase && meta.baseCurrency !== portfolioBase) {
          throw new Error(
            `IBKR base currency ${meta.baseCurrency} doesn't match portfolio base ${portfolioBase}.`
          );
        }
        const portfolioAccount = (portfolio?.attributes?.account_id ?? '').trim();
        if (portfolioAccount && meta.account && meta.account !== portfolioAccount) {
          throw new Error(
            `IBKR account ${meta.account} doesn't match portfolio account_id ${portfolioAccount}.`
          );
        }
        if (!portfolioAccount && meta.account) {
          appEvents.emit(AppEvents.alertWarning, [
            `Portfolio has no account_id attribute. Set attributes.account_id = "${meta.account}" to bind it to this IBKR account.`,
          ]);
        }
      }

      const {
        trades,
        dividends,
        cashflows,
        fxConversions,
        transferIns,
        optionExercises,
        optionAssignments,
        optionExpiries,
        optionMarks,
        instrumentsToRegister,
        skipped,
        errors,
      } = r;
      if (
        trades.length === 0 &&
        dividends.length === 0 &&
        cashflows.length === 0 &&
        fxConversions.length === 0 &&
        transferIns.length === 0 &&
        optionExercises.length === 0 &&
        optionAssignments.length === 0 &&
        optionExpiries.length === 0 &&
        optionMarks.length === 0
      ) {
        setParseErrors(errors);
        setSkippedRows(skipped);
        throw new Error(
          'No trade / dividend / cashflow / fx-conversion / transfer-in / option rows found in CSV.'
        );
      }
      setParsedTrades(trades);
      setParsedDividends(dividends);
      setParsedCashflows(cashflows);
      setParsedFxConversions(fxConversions);
      setParsedTransferIns(transferIns);
      setParsedOptionExercises(optionExercises);
      setParsedOptionAssignments(optionAssignments);
      setParsedOptionExpiries(optionExpiries);
      setParsedOptionMarks(optionMarks);
      setParsedInstrumentsToRegister(instrumentsToRegister);
      setSkippedRows(skipped);
      setParseErrors(errors);

      // Mappings UI: equity only. Options are fully specified by OCC parse
      // (kind + strike + expiry + multiplier locked), so operator currency
      // override doesn't apply; they auto-register at confirm.
      const instrumentMap = new Map(instruments.map((i) => [i.instrument_id, i]));
      const initial: Mapping[] = instrumentsToRegister
        .filter((reg) => reg.kind === 'equity')
        .map((reg) => {
          const existing = instrumentMap.get(reg.instrument_id);
          const tradeCount = trades.filter((t) => t.instrument_id === reg.instrument_id).length;
          return {
            instrumentId: reg.instrument_id,
            tradeCount,
            exists: !!existing,
            existingCurrency: existing?.currency ?? null,
            pickedCurrency: existing?.currency ?? reg.currency ?? '',
          };
        });
      setMappings(initial);
      setStep('map');
      const cashflowBreakdown = (() => {
        const counts: Record<string, number> = {};
        for (const c of cashflows) {
          counts[c.type] = (counts[c.type] ?? 0) + 1;
        }
        return Object.entries(counts)
          .map(([k, v]) => `${v} ${k.toLowerCase().replace(/_/g, ' ')}`)
          .join(', ');
      })();
      appEvents.emit(AppEvents.alertSuccess, [
        `Parsed ${trades.length} trade(s), ${dividends.length} dividend(s), ${cashflows.length} cashflow(s)` +
          (cashflowBreakdown ? ` (${cashflowBreakdown})` : '') +
          `, ${fxConversions.length} fx-conversion(s)` +
          (transferIns.length > 0 ? `, ${transferIns.length} transfer-in(s)` : '') +
          `. Skipped ${skipped} row(s).`,
      ]);
    } catch (err) {
      appEvents.emit(AppEvents.alertError, [errMsg(err)]);
    }
  }

  function patch(idx: number, p: Partial<Mapping>) {
    setMappings((cur) => {
      const next = [...cur];
      next[idx] = { ...next[idx]!, ...p };
      return next;
    });
  }

  function goLots() {
    if (parsedTransferIns.length === 0) {
      setStep('confirm');
      return;
    }
    setStep('lots');
  }

  function applyLots(flattened: TransferInRequest[]) {
    setParsedTransferIns(flattened);
    setStep('confirm');
  }

  async function runImport() {
    setRunning(true);
    const r: RunResult = {
      instrumentsUpdated: [],
      tradesImported: 0,
      transferInsImported: 0,
      dividendsImported: 0,
      cashflowsImported: 0,
      fxConversionsImported: 0,
      optionExercisesImported: 0,
      optionAssignmentsImported: 0,
      optionExpiriesImported: 0,
      optionMarksImported: 0,
      errors: [],
    };
    try {
      const tradesToSend = withInstrumentIdentity(parsedTrades, parsedInstrumentsToRegister);
      if (tradesToSend.length > 0) {
        try {
          await submitTradesBulk(tradesToSend);
          r.tradesImported = tradesToSend.length;
        } catch (err) {
          r.errors.push(`Trades bulk submit: ${errMsg(err)}`);
        }
      }

      if (parsedTransferIns.length > 0) {
        try {
          await submitTransferInsBulk(parsedTransferIns);
          r.transferInsImported = parsedTransferIns.length;
        } catch (err) {
          r.errors.push(`Transfer-ins bulk submit: ${errMsg(err)}`);
        }
      }

      const fxToSend = parsedFxConversions;
      if (fxToSend.length > 0) {
        try {
          await submitFxConversionsBulk(fxToSend);
          r.fxConversionsImported = fxToSend.length;
        } catch (err) {
          r.errors.push(`FX conversions bulk submit: ${errMsg(err)}`);
        }
      }

      const dividendsToSend = parsedDividends;
      if (dividendsToSend.length > 0) {
        try {
          await submitDividendsBulk(dividendsToSend);
          r.dividendsImported = dividendsToSend.length;
        } catch (err) {
          r.errors.push(`Dividends bulk submit: ${errMsg(err)}`);
        }
      }

      if (parsedCashflows.length > 0) {
        try {
          await submitCashflowsBulk(parsedCashflows);
          r.cashflowsImported = parsedCashflows.length;
        } catch (err) {
          r.errors.push(`Cashflows bulk submit: ${errMsg(err)}`);
        }
      }

      for (const ev of parsedOptionExpiries) {
        try {
          await submitOptionExpiry(ev);
          r.optionExpiriesImported += 1;
        } catch (err) {
          r.errors.push(`Option expiry ${ev.instrument_id}: ${errMsg(err)}`);
        }
      }
      for (const ev of parsedOptionAssignments) {
        try {
          await submitOptionAssignment(ev);
          r.optionAssignmentsImported += 1;
        } catch (err) {
          r.errors.push(`Option assignment ${ev.instrument_id}: ${errMsg(err)}`);
        }
      }
      for (const ev of parsedOptionExercises) {
        try {
          await submitOptionExercise(ev);
          r.optionExercisesImported += 1;
        } catch (err) {
          r.errors.push(`Option exercise ${ev.instrument_id}: ${errMsg(err)}`);
        }
      }
      for (const ev of parsedOptionMarks) {
        try {
          await submitOptionMark(ev);
          r.optionMarksImported += 1;
        } catch (err) {
          r.errors.push(`Option mark ${ev.instrument_id}: ${errMsg(err)}`);
        }
      }

      await refreshInstruments();
      setResult(r);
      setStep('done');
      if (r.errors.length === 0) {
        const optionParts: string[] = [];
        if (r.optionExpiriesImported) optionParts.push(`${r.optionExpiriesImported} option expiry(s)`);
        if (r.optionAssignmentsImported) optionParts.push(`${r.optionAssignmentsImported} option assignment(s)`);
        if (r.optionExercisesImported) optionParts.push(`${r.optionExercisesImported} option exercise(s)`);
        if (r.optionMarksImported) optionParts.push(`${r.optionMarksImported} option mark(s)`);
        const optionSuffix = optionParts.length ? `, ${optionParts.join(', ')}` : '';
        appEvents.emit(AppEvents.alertSuccess, [
          `Imported ${r.tradesImported} trade(s), ${r.transferInsImported} transfer-in(s), ${r.dividendsImported} dividend(s), ${r.cashflowsImported} cashflow(s), ${r.fxConversionsImported} fx-conversion(s)${optionSuffix}.`,
        ]);
      } else {
        appEvents.emit(AppEvents.alertWarning, [
          `Import finished with ${r.errors.length} warning(s).`,
        ]);
      }
    } finally {
      setRunning(false);
    }
  }

  return (
    <Page navId="portfolio-import">
      <Page.Contents>
        <Stack direction="column" gap={3}>
          <Stepper step={step} hasTransferIns={parsedTransferIns.length > 0} />

          {step === 'upload' ? (
            <div className={styles.panel}>
              <h2 className={styles.heading}>1. Upload CSV</h2>
              <Stack direction="row" gap={2} wrap="wrap">
                <Field label="Portfolio" required>
                  <Select
                    width={28}
                    options={portfolios.map((p) => ({
                      label: p.portfolio_id,
                      value: p.portfolio_id,
                    }))}
                    value={portfolioId}
                    onChange={(opt) => setPortfolioId(opt?.value ?? '')}
                    placeholder="Select…"
                  />
                </Field>
                <Field label="Default venue">
                  <Input
                    value={defaultVenue}
                    onChange={(e) => setDefaultVenue(e.currentTarget.value)}
                    placeholder="XLON"
                  />
                </Field>
                <Field label="Updated by">
                  <Input
                    value={updatedBy}
                    onChange={(e) => setUpdatedBy(e.currentTarget.value)}
                  />
                </Field>
                <Field label="Broker">
                  <Select
                    width={24}
                    options={[
                      { label: 'Auto-detect', value: 'auto' },
                      { label: 'Trading 212', value: 't212' },
                      { label: 'Interactive Brokers', value: 'ibkr_statement' },
                    ]}
                    value={brokerChoice}
                    onChange={(opt) =>
                      setBrokerChoice((opt?.value as BrokerFormat | 'auto') ?? 'auto')
                    }
                  />
                </Field>
              </Stack>

              <Field label="Broker CSV file">
                <FileDropzone
                  options={{
                    multiple: false,
                    accept: { 'text/csv': ['.csv'] },
                    disabled: !portfolioId,
                  }}
                  readAs="readAsText"
                  onLoad={(result) => {
                    if (typeof result === 'string') {
                      void handleCsv(result);
                    }
                  }}
                />
              </Field>

              <p className={styles.hint}>
                Pick a broker or leave on Auto-detect. Trading 212 is a flat one-row-per-event
                CSV; IBKR is a multi-section Activity Statement. IBKR statements are matched
                against the portfolio&apos;s <code>account_id</code> attribute and base currency
                before import.
              </p>

              {format ? (
                <Alert
                  severity="info"
                  title={
                    format === 'ibkr_statement'
                      ? 'IBKR Activity Statement detected'
                      : 'Trading 212 CSV detected'
                  }
                >
                  {ibkrMeta ? (
                    <div className={styles.hint}>
                      Account <code>{ibkrMeta.account || '(unknown)'}</code> · base{' '}
                      <code>{ibkrMeta.baseCurrency || '(unknown)'}</code>
                      {ibkrMeta.period
                        ? ` · period ${formatEventMicros(ibkrMeta.period.start)}–${formatEventMicros(ibkrMeta.period.end)}`
                        : ''}
                    </div>
                  ) : null}
                </Alert>
              ) : null}

              {parseErrors.length > 0 ? (
                <p className={styles.hint}>
                  {parseErrors.length} row error(s): {parseErrors.slice(0, 3).join('; ')}
                  {parseErrors.length > 3 ? '…' : ''}
                </p>
              ) : null}
              {skippedRows > 0 ? (
                <p className={styles.hint}>Skipped {skippedRows} non-event row(s).</p>
              ) : null}
            </div>
          ) : null}

          {step === 'map' ? (
            <div className={styles.panel}>
              <Stack direction="row" alignItems="center" justifyContent="space-between">
                <h2 className={styles.heading}>
                  2. Review instruments ({mappings.length})
                </h2>
                <Stack direction="row" gap={1}>
                  <Button variant="secondary" size="sm" onClick={reset}>
                    Cancel
                  </Button>
                  <Button size="sm" onClick={goLots}>
                    {parsedTransferIns.length > 0 ? 'Next: Lot detail →' : 'Next: Confirm →'}
                  </Button>
                </Stack>
              </Stack>
              <div className={styles.tableScroll}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Instrument</th>
                      <th>Trades</th>
                      <th>Status</th>
                      <th>CCY</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mappings.map((m, idx) => (
                      <tr key={m.instrumentId}>
                        <td>
                          <strong>{m.instrumentId}</strong>
                        </td>
                        <td>{m.tradeCount}</td>
                        <td>
                          {m.exists ? (
                            <Badge color="green" text="exists" />
                          ) : (
                            <Badge color="blue" text="new" />
                          )}
                        </td>
                        <td>
                          <Input
                            width={8}
                            value={m.pickedCurrency}
                            onChange={(e) =>
                              patch(idx, { pickedCurrency: e.currentTarget.value.toUpperCase() })
                            }
                            placeholder="GBP"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className={styles.hint}>
                New instruments are created with just an ID + currency. Vendor mappings
                (Yahoo symbols, etc.) are managed inside their respective ingestor plugins.
              </p>
            </div>
          ) : null}

          {step === 'lots' ? (
            <div className={styles.panel}>
              <h2 className={styles.heading}>3. Acquisition lot detail</h2>
              <LotsStep
                transfers={parsedTransferIns}
                onBack={() => setStep('map')}
                onConfirm={applyLots}
              />
            </div>
          ) : null}

          {step === 'confirm' ? (
            <div className={styles.panel}>
              <Stack direction="row" alignItems="center" justifyContent="space-between">
                <h2 className={styles.heading}>
                  {parsedTransferIns.length > 0 ? '4' : '3'}. Confirm import
                </h2>
                <Stack direction="row" gap={1}>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      parsedTransferIns.length > 0 ? setStep('lots') : setStep('map')
                    }
                  >
                    ← Back
                  </Button>
                  <Button onClick={() => void runImport()} disabled={running}>
                    {running ? 'Running…' : 'Run import'}
                  </Button>
                </Stack>
              </Stack>
              {cashSim.errors.length > 0 ? (
                <Alert
                  severity="warning"
                  title={`Cash-bucket overdrafts in preview (${cashSim.errors.length})`}
                >
                  <p className={styles.hint}>
                    This per-file preview seeds every currency at zero, so it cannot see
                    cash carried in from earlier imports of this portfolio — for a split
                    or follow-on import these overdrafts are usually false positives.
                    Import is not blocked. Caveat: the server only balance-checks
                    cashflows; trades and FX conversions are not gated, so for those rows
                    this preview is the only safeguard — review the list before importing.
                  </p>
                  <ul className={styles.errList}>
                    {cashSim.errors.slice(0, 20).map((err, i) => (
                      <li key={i}>{err}</li>
                    ))}
                    {cashSim.errors.length > 20 ? (
                      <li>… and {cashSim.errors.length - 20} more</li>
                    ) : null}
                  </ul>
                </Alert>
              ) : null}
              <SummaryList
                mappings={mappings}
                tradesByInstrument={tradesByInstrument}
                totalTrades={parsedTrades.length}
                portfolioId={portfolioId}
                baseCurrency={baseCurrency}
                cashflowCount={parsedCashflows.length}
                dividendCount={parsedDividends.length}
                fxConversionCount={parsedFxConversions.length}
                fxByPair={fxByPair}
              />
            </div>
          ) : null}

          {step === 'done' && result ? (
            <div className={styles.panel}>
              <Stack direction="row" alignItems="center" justifyContent="space-between">
                <h2 className={styles.heading}>Import done</h2>
                <Button onClick={reset}>Start another import</Button>
              </Stack>
              <ResultView result={result} />
            </div>
          ) : null}
        </Stack>
      </Page.Contents>
    </Page>
  );
}

const STEP_ORDER_WITH_LOTS: Step[] = ['upload', 'map', 'lots', 'confirm', 'done'];
const STEP_ORDER_NO_LOTS: Step[] = ['upload', 'map', 'confirm', 'done'];

function Stepper({ step, hasTransferIns }: { step: Step; hasTransferIns: boolean }) {
  const styles = useStyles2(getStyles);
  const includeLots = step === 'lots' || hasTransferIns;
  const order = includeLots ? STEP_ORDER_WITH_LOTS : STEP_ORDER_NO_LOTS;
  const labels: Record<Step, string> = {
    upload: '1. Upload',
    map: '2. Review',
    lots: '3. Lot detail',
    confirm: includeLots ? '4. Confirm' : '3. Confirm',
    done: includeLots ? '5. Done' : '4. Done',
  };
  const currentIdx = order.indexOf(step);
  return (
    <div className={styles.stepper}>
      {order.map((s, idx) => (
        <div
          key={s}
          className={
            idx === currentIdx
              ? styles.stepActive
              : idx < currentIdx
                ? styles.stepDone
                : styles.step
          }
        >
          {labels[s]}
        </div>
      ))}
    </div>
  );
}

function SummaryList(props: {
  mappings: Mapping[];
  tradesByInstrument: Map<string, number>;
  totalTrades: number;
  portfolioId: string;
  baseCurrency: string | undefined;
  cashflowCount: number;
  dividendCount: number;
  fxConversionCount: number;
  fxByPair: Map<string, { count: number; from_total: number; to_total: number }>;
}) {
  const styles = useStyles2(getStyles);
  const {
    mappings,
    tradesByInstrument,
    totalTrades,
    portfolioId,
    baseCurrency,
    cashflowCount,
    dividendCount,
    fxConversionCount,
    fxByPair,
  } = props;
  return (
    <Stack direction="column" gap={2}>
      <Stack direction="row" gap={2} wrap="wrap">
        <Stat label="Portfolio" value={portfolioId} />
        <Stat label="Base currency" value={baseCurrency ?? '—'} />
        <Stat label="Trades to import" value={String(totalTrades)} />
      </Stack>
      <Stack direction="row" gap={2} wrap="wrap">
        <Stat label="Dividends" value={String(dividendCount)} />
        <Stat label="Cashflows" value={String(cashflowCount)} />
        <Stat label="FX conversions" value={String(fxConversionCount)} />
      </Stack>
      {fxByPair.size > 0 ? (
        <div className={styles.hint}>
          FX legs:{' '}
          {[...fxByPair.entries()]
            .map(
              ([pair, agg]) =>
                `${pair}: ${agg.count} (${agg.from_total.toFixed(2)} → ${agg.to_total.toFixed(2)})`
            )
            .join(' · ')}
        </div>
      ) : null}
      <Stack direction="row" gap={2} wrap="wrap">
        <Stat label="New instruments" value={String(mappings.filter((m) => !m.exists).length)} />
      </Stack>
      <div className={styles.tableScroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Instrument</th>
              <th>Trades</th>
              <th>CCY</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {mappings.map((m) => (
              <tr key={m.instrumentId}>
                <td>
                  <strong>{m.instrumentId}</strong>
                </td>
                <td>{tradesByInstrument.get(m.instrumentId) ?? 0}</td>
                <td>{m.pickedCurrency || '—'}</td>
                <td>
                  {m.exists ? (
                    <Badge color="green" text="exists" />
                  ) : (
                    <Badge color="blue" text="new" />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Stack>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  const styles = useStyles2(getStyles);
  return (
    <div className={styles.stat}>
      <div className={styles.statLabel}>{label}</div>
      <div className={styles.statValue}>{value || '—'}</div>
    </div>
  );
}

function ResultView({ result }: { result: RunResult }) {
  const styles = useStyles2(getStyles);
  return (
    <Stack direction="column" gap={2}>
      <Stack direction="row" gap={2} wrap="wrap">
        <Stat label="Trades imported" value={String(result.tradesImported)} />
        <Stat label="Transfer-ins imported" value={String(result.transferInsImported)} />
        <Stat label="Dividends imported" value={String(result.dividendsImported)} />
        <Stat label="Cashflows imported" value={String(result.cashflowsImported)} />
        <Stat
          label="FX conversions imported"
          value={String(result.fxConversionsImported)}
        />
      </Stack>
      {result.errors.length > 0 ? (
        <Alert severity="warning" title={`${result.errors.length} warning(s)`}>
          <ul className={styles.errList}>
            {result.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
    </Stack>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  panel: css({
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(2),
    padding: theme.spacing(2),
    background: theme.colors.background.secondary,
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
  }),
  heading: css({
    margin: 0,
    fontSize: theme.typography.h3.fontSize,
  }),
  hint: css({
    margin: 0,
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  tableScroll: css({
    overflowX: 'auto',
    maxHeight: theme.spacing(80),
  }),
  table: css({
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: theme.typography.bodySmall.fontSize,
    'th, td': {
      padding: theme.spacing(1),
      borderBottom: `1px solid ${theme.colors.border.weak}`,
      verticalAlign: 'middle',
      textAlign: 'left',
    },
    th: {
      color: theme.colors.text.secondary,
      fontWeight: theme.typography.fontWeightMedium,
    },
  }),
  stepper: css({
    display: 'flex',
    gap: theme.spacing(1),
    flexWrap: 'wrap',
  }),
  step: css({
    padding: theme.spacing(0.5, 1.5),
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  stepActive: css({
    padding: theme.spacing(0.5, 1.5),
    border: `1px solid ${theme.colors.primary.border}`,
    borderRadius: theme.shape.radius.default,
    color: theme.colors.primary.text,
    background: theme.colors.primary.transparent,
    fontWeight: theme.typography.fontWeightMedium,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  stepDone: css({
    padding: theme.spacing(0.5, 1.5),
    border: `1px solid ${theme.colors.success.border}`,
    borderRadius: theme.shape.radius.default,
    color: theme.colors.success.text,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  stat: css({
    display: 'flex',
    flexDirection: 'column',
    minWidth: theme.spacing(20),
  }),
  statLabel: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  statValue: css({
    fontSize: theme.typography.h4.fontSize,
    fontWeight: theme.typography.fontWeightBold,
  }),
  errList: css({
    margin: theme.spacing(0.5, 0, 0, 2),
    padding: 0,
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
});
