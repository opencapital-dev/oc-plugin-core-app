import React from 'react';
import { css } from '@emotion/css';
import { useEffect, useMemo, useState } from 'react';

import { AppEvents, type GrafanaTheme2 } from '@grafana/data';
import {
  Alert,
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
  listPortfolios,
  writeEventsBulk,
  type PortfolioEntity,
} from '../api/reference';
import { DEFAULT_UPDATED_BY } from '../lib/attributes';
import {
  brokerRowsToEvents,
  parseCsv,
  simulateImportedCash,
  type BrokerFormat,
} from '../lib/import';
import { withInstrumentIdentity } from '../lib/import/withInstrumentIdentity';
import { formatEventMicros } from '../lib/time';
import type { ParseResult } from '../lib/import/types';
import { EventsTable, type FamilyFilter } from '../components/events/EventsTable';
import { EventDrawer, type DrawerState } from '../components/events/EventDrawer';
import { brokerResultToInputs, inputsToRows } from '../lib/events/fromBrokerResult';
import type { EventInput } from '../lib/events/types';

type Step = 'upload' | 'review' | 'done';

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

  const [step, setStep] = useState<Step>('upload');
  const [portfolioId, setPortfolioId] = useState('');
  const [defaultVenue, setDefaultVenue] = useState('XLON');
  const [updatedBy, setUpdatedBy] = useState(DEFAULT_UPDATED_BY);
  const [brokerChoice, setBrokerChoice] = useState<BrokerFormat | 'auto'>('auto');

  // Parse result — kept so upload-step info (format / ibkr meta / errors) persists on back-nav.
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);

  // The flat EventInput[] the review table operates on. Editing / removing updates this.
  const [previewInputs, setPreviewInputs] = useState<EventInput[]>([]);

  // Review step UI state.
  const [reviewQuery, setReviewQuery] = useState('');
  const [reviewFamily, setReviewFamily] = useState<FamilyFilter>('all');
  const [reviewDrawer, setReviewDrawer] = useState<DrawerState | null>(null);

  // Done step.
  const [importedCount, setImportedCount] = useState<number | null>(null);
  const [running, setRunning] = useState(false);

  // Derived from parseResult so we don't need separate state variables.
  const format = parseResult?.format ?? null;
  const ibkrMeta: IbkrMeta | null =
    format === 'ibkr_statement' && parseResult
      ? {
          account: parseResult.account ?? '',
          baseCurrency: (parseResult.baseCurrency ?? '').toUpperCase(),
          period: parseResult.period ?? null,
        }
      : null;
  const skippedRows = parseResult?.skipped ?? 0;
  const parseErrors = parseResult?.errors ?? [];

  const selectedPortfolio = portfolios.find((p) => p.portfolio_id === portfolioId) ?? null;
  const targetLabel = selectedPortfolio
    ? `${selectedPortfolio.attributes?.name?.trim() || 'Untitled portfolio'}  ·  ${selectedPortfolio.base_currency}`
    : portfolioId;

  // Cash-flow simulation — computed once from the original parse result and shown
  // above the review table as an early-warning of potential overdrafts.
  const cashSim = useMemo(() => {
    if (!parseResult) {
      return { timelines: {}, errors: [] };
    }
    return simulateImportedCash(parseResult, parseResult.format);
  }, [parseResult]);

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

  function reset() {
    setStep('upload');
    setParseResult(null);
    setPreviewInputs([]);
    setImportedCount(null);
    setReviewDrawer(null);
    setReviewQuery('');
    setReviewFamily('all');
  }

  async function handleCsv(text: string) {
    setParseResult(null);
    setPreviewInputs([]);
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

      if (r.format === 'ibkr_statement') {
        const meta: IbkrMeta = {
          account: r.account ?? '',
          baseCurrency: (r.baseCurrency ?? '').toUpperCase(),
          period: r.period ?? null,
        };
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
        skipped,
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
        // Store result so errors/skipped are visible on the upload step.
        setParseResult(r);
        throw new Error(
          'No trade / dividend / cashflow / fx-conversion / transfer-in / option rows found in CSV.'
        );
      }

      // Stamp instrument identity onto trades exactly as the old runImport did,
      // then flatten everything into EventInputs for the review table.
      const stampedTrades = withInstrumentIdentity(r.trades, r.instrumentsToRegister);
      const inputs = brokerResultToInputs({ ...r, trades: stampedTrades });

      setParseResult(r);
      setPreviewInputs(inputs);
      setStep('review');

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

  const commitReview = async () => {
    setRunning(true);
    try {
      // Strip any synthetic preview- source_ids that must not reach the backend.
      const toCommit: EventInput[] = previewInputs.map((p) => {
        if (typeof p.source_id === 'string' && p.source_id.startsWith('preview-')) {
          const { source_id: _discard, ...rest } = p;
          return rest as EventInput;
        }
        return p;
      });
      await writeEventsBulk(toCommit);
      const count = previewInputs.length;
      setImportedCount(count);
      setStep('done');
      appEvents.emit(AppEvents.alertSuccess, [`Imported ${count} events.`]);
    } catch (err) {
      appEvents.emit(AppEvents.alertError, [err instanceof Error ? err.message : 'Import failed']);
    } finally {
      setRunning(false);
    }
  };

  return (
    <Page navId="portfolio-import">
      <Page.Contents>
        <Stack direction="column" gap={3}>
          <Stepper step={step} />

          {step === 'upload' ? (
            <div className={styles.panel}>
              <h2 className={styles.heading}>1. Upload CSV</h2>
              <Stack direction="row" gap={2} wrap="wrap">
                <Field label="Portfolio" required>
                  <Select
                    width={28}
                    options={portfolios.map((p) => ({
                      label: `${p.attributes?.name?.trim() || 'Untitled portfolio'}  ·  ${p.base_currency}`,
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

          {step === 'review' ? (
            <div className={styles.panel}>
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
              <div className={styles.reviewHeader}>
                <h2 className={styles.heading}>
                  2. Review {previewInputs.length} parsed events
                </h2>
                <Stack direction="row" gap={1}>
                  <Button variant="secondary" size="sm" onClick={() => setStep('upload')}>
                    ← Back
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => void commitReview()}
                    disabled={previewInputs.length === 0 || running}
                  >
                    {running ? 'Importing…' : `Import ${previewInputs.length} events`}
                  </Button>
                </Stack>
              </div>
              {previewInputs.length === 0 ? (
                <p className={styles.hint}>
                  No importable events found in this file.
                </p>
              ) : null}
              <div className={styles.tableWrapper}>
                <EventsTable
                  rows={inputsToRows(previewInputs)}
                  query={reviewQuery}
                  family={reviewFamily}
                  sortDir="desc"
                  onToggleSort={() => undefined}
                  onRowClick={(row) => {
                    setReviewDrawer({ mode: 'detail', type: row.event_type, row });
                  }}
                />
              </div>
              <Stack direction="row" gap={2}>
                <Field label="Search">
                  <Input
                    value={reviewQuery}
                    onChange={(e) => setReviewQuery(e.currentTarget.value)}
                    placeholder="Filter events…"
                  />
                </Field>
                <Field label="Type">
                  <Select
                    width={20}
                    options={[
                      { label: 'All', value: 'all' },
                      { label: 'Trades', value: 'trade' },
                      { label: 'Income', value: 'income' },
                      { label: 'Cash', value: 'cash' },
                      { label: 'Transfers', value: 'transfer' },
                      { label: 'Options', value: 'option' },
                    ]}
                    value={reviewFamily}
                    onChange={(opt) => setReviewFamily((opt?.value as FamilyFilter) ?? 'all')}
                  />
                </Field>
              </Stack>
              <p className={styles.hint}>
                Portfolio: <strong>{targetLabel}</strong>. Click a row to inspect or
                edit it before committing.
              </p>
            </div>
          ) : null}

          {step === 'done' && importedCount !== null ? (
            <div className={styles.panel}>
              <Stack direction="row" alignItems="center" justifyContent="space-between">
                <h2 className={styles.heading}>Import done</h2>
                <Button onClick={reset}>Start another import</Button>
              </Stack>
              <Stack direction="row" gap={2} wrap="wrap">
                <Stat label="Events imported" value={String(importedCount)} />
                <Stat label="Portfolio" value={targetLabel} />
              </Stack>
            </div>
          ) : null}

          {reviewDrawer ? (
            <EventDrawer
              state={reviewDrawer}
              portfolioId={portfolioId}
              onClose={() => setReviewDrawer(null)}
              onSubmit={(input) => {
                if (reviewDrawer.mode !== 'create') {
                  const idx = Number(reviewDrawer.row.source_id.replace('preview-', ''));
                  // Strip the synthetic preview- source_id from the edited input so the
                  // broker's real typed id (trade_id / lot_id / etc.) on the original
                  // previewInputs entry is preserved. Merge edited fields over the original.
                  const { source_id: _preview, ...editedFields } = input;
                  setPreviewInputs((prev) =>
                    prev.map((p, i) => (i === idx ? { ...p, ...editedFields } : p))
                  );
                }
                setReviewDrawer(null);
              }}
              onEdit={(row) => setReviewDrawer({ mode: 'edit', type: row.event_type, row })}
              onDelete={(row) => {
                const idx = Number(row.source_id.replace('preview-', ''));
                setPreviewInputs((prev) => prev.filter((_, i) => i !== idx));
                setReviewDrawer(null);
              }}
            />
          ) : null}
        </Stack>
      </Page.Contents>
    </Page>
  );
}

const STEP_ORDER: Step[] = ['upload', 'review', 'done'];

function Stepper({ step }: { step: Step }) {
  const styles = useStyles2(getStyles);
  const labels: Record<Step, string> = {
    upload: '1. Upload',
    review: '2. Review',
    done: '3. Done',
  };
  const currentIdx = STEP_ORDER.indexOf(step);
  return (
    <div className={styles.stepper}>
      {STEP_ORDER.map((s, idx) => (
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

function Stat({ label, value }: { label: string; value: string }) {
  const styles = useStyles2(getStyles);
  return (
    <div className={styles.stat}>
      <div className={styles.statLabel}>{label}</div>
      <div className={styles.statValue}>{value || '—'}</div>
    </div>
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
  reviewHeader: css({
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: theme.spacing(1),
  }),
  tableWrapper: css({
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    overflow: 'auto',
    marginBottom: theme.spacing(2),
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
