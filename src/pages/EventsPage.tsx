import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { css } from '@emotion/css';
import { useNavigate } from 'react-router-dom';

import { AppEvents, type GrafanaTheme2 } from '@grafana/data';
import {
  Button,
  ConfirmModal,
  Icon,
  InteractiveTable,
  Stack,
  TabsBar,
  Tab,
  useStyles2,
  type Column,
} from '@grafana/ui';

import { Page } from '../components/Page';
import { PortfolioSelector } from '../components/PortfolioSelector';
import { PLUGIN_BASE_URL, ROUTES } from '../constants';
import { usePortfolio } from '../contexts/PortfolioContext';
import {
  type CashflowListRow,
  type DividendListRow,
  type FxConversionListRow,
  type TradeListRow,
  type TransferInListRow,
  deleteEvent,
  listCashflows,
  listDividends,
  listFxConversions,
  listTrades,
  listTransferIns,
  submitCashflow,
  submitDividend,
  submitFxConversion,
  submitTrade,
  submitTradeCorrection,
  submitTransferIn,
} from '../api/reference';
import { DEFAULT_UPDATED_BY } from '../lib/attributes';
import { formatEventMicros } from '../lib/time';
import { appEvents } from '../lib/toast';
import { EventDrawer, type EventKind, type EventFormState } from '../components/events/EventDrawer';

type AnyRow =
  | TradeListRow
  | DividendListRow
  | CashflowListRow
  | FxConversionListRow
  | TransferInListRow;

export function EventsPage() {
  const styles = useStyles2(getStyles);
  const navigate = useNavigate();
  const { selected, portfolios, loading } = usePortfolio();

  const [activeTab, setActiveTab] = useState<EventKind>('trade');
  const [rowsByKind, setRowsByKind] = useState<Record<EventKind, AnyRow[]>>({
    trade: [],
    dividend: [],
    cashflow: [],
    fx_conversion: [],
    transfer_in: [],
  });
  const [refreshing, setRefreshing] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ row: AnyRow; kind: EventKind } | null>(null);
  const [drawerState, setDrawerState] = useState<{ open: boolean; mode: 'create' | 'edit'; initial?: EventFormState }>({
    open: false,
    mode: 'create',
  });

  const refresh = useCallback(
    async (kind?: EventKind) => {
      if (!selected) return;
      setRefreshing(true);
      try {
        const fetchers: Array<[EventKind, Promise<AnyRow[]>]> = [];
        if (!kind || kind === 'trade') fetchers.push(['trade', listTrades(selected)]);
        if (!kind || kind === 'dividend') fetchers.push(['dividend', listDividends(selected)]);
        if (!kind || kind === 'cashflow') fetchers.push(['cashflow', listCashflows(selected)]);
        if (!kind || kind === 'fx_conversion') fetchers.push(['fx_conversion', listFxConversions(selected)]);
        if (!kind || kind === 'transfer_in') fetchers.push(['transfer_in', listTransferIns(selected)]);
        const results = await Promise.allSettled(fetchers.map(([, p]) => p));
        const next = { ...rowsByKind };
        results.forEach((r, i) => {
          const [k] = fetchers[i];
          if (r.status === 'fulfilled') {
            next[k] = r.value as AnyRow[];
          }
        });
        setRowsByKind(next);
      } finally {
        setRefreshing(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected],
  );

  useEffect(() => {
    if (selected) {
      void refresh();
    }
  }, [selected, refresh]);

  const handleSubmit = async (form: EventFormState) => {
    if (!selected) return;
    try {
      if (drawerState.mode === 'edit' && form.kind === 'trade' && form.trade_id) {
        await submitTradeCorrection(form.trade_id, {
          portfolio_id: selected,
          instrument_id: form.instrument_id,
          side: form.side,
          price: form.price,
          quantity: form.quantity,
          currency: form.currency,
          venue: form.venue,
          updated_by: DEFAULT_UPDATED_BY,
          event_ts: form.event_ts,
          commission: form.commission,
          fees: form.fees,
        });
      } else if (form.kind === 'trade') {
        await submitTrade({
          portfolio_id: selected,
          instrument_id: form.instrument_id,
          side: form.side,
          price: form.price,
          quantity: form.quantity,
          currency: form.currency,
          venue: form.venue,
          updated_by: DEFAULT_UPDATED_BY,
          event_ts: form.event_ts,
          commission: form.commission,
          fees: form.fees,
        });
      } else if (form.kind === 'dividend') {
        await submitDividend({
          portfolio_id: selected,
          instrument_id: form.instrument_id,
          gross_native: form.gross_native,
          withholding_native: form.withholding_native,
          currency: form.currency,
          updated_by: DEFAULT_UPDATED_BY,
          event_ts: form.event_ts,
        });
      } else if (form.kind === 'cashflow') {
        await submitCashflow({
          portfolio_id: selected,
          type: form.cashflow_type,
          amount_native: form.amount_native,
          currency: form.currency,
          updated_by: DEFAULT_UPDATED_BY,
          event_ts: form.event_ts,
        });
      } else if (form.kind === 'fx_conversion') {
        await submitFxConversion({
          portfolio_id: selected,
          from_currency: form.from_currency,
          from_amount: form.from_amount,
          to_currency: form.to_currency,
          to_amount: form.to_amount,
          rate: form.rate,
          updated_by: DEFAULT_UPDATED_BY,
          event_ts: form.event_ts,
        });
      } else if (form.kind === 'transfer_in') {
        await submitTransferIn({
          portfolio_id: selected,
          instrument_id: form.instrument_id,
          quantity: form.quantity,
          cost_basis_native: form.cost_basis_native,
          currency: form.currency,
          acquisition_date: form.acquisition_date,
          fx_rate_at_acquisition: form.fx_rate_at_acquisition,
          lot_id: form.lot_id || crypto.randomUUID(),
          updated_by: DEFAULT_UPDATED_BY,
          event_ts: form.event_ts,
        });
      }
      appEvents.emit(AppEvents.alertSuccess, [
        `${drawerState.mode === 'edit' ? 'Edited' : 'Created'} ${form.kind} event.`,
      ]);
      setDrawerState({ open: false, mode: 'create' });
      await refresh(form.kind);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Submit failed';
      appEvents.emit(AppEvents.alertError, [message]);
    }
  };

  const handleDelete = async (row: AnyRow, kind: EventKind) => {
    if (!selected) return;
    const sourceId = sourceIdForRow(row, kind);
    if (!sourceId) {
      appEvents.emit(AppEvents.alertError, [`Cannot delete ${kind} event: missing source id.`]);
      return;
    }
    try {
      await deleteEvent(sourceId, selected);
      appEvents.emit(AppEvents.alertSuccess, [`Deleted ${kind} event.`]);
      await refresh(kind);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Delete failed';
      appEvents.emit(AppEvents.alertError, [message]);
    }
  };

  const tabRows = rowsByKind[activeTab] ?? [];

  return (
    <Page>
      <PortfolioSelector />

      {!selected && !loading && (
        <div className={styles.muted}>
          {portfolios.length === 0
            ? 'Create a portfolio first.'
            : 'Pick a portfolio from the selector above.'}
        </div>
      )}

      {selected && (
        <>
          <div className={styles.headerRow}>
            <div>
              <h2 className={styles.h2}>Events &middot; {selected}</h2>
              <p className={styles.sub}>
                Trades, dividends, cashflows, FX conversions and transfers for the selected portfolio.
              </p>
            </div>
            <Stack direction="row" gap={1}>
              <Button
                variant="secondary"
                icon="upload"
                onClick={() => navigate(`${PLUGIN_BASE_URL}/${ROUTES.Import}`)}
              >
                Bulk import
              </Button>
              <Button
                icon="plus"
                onClick={() => setDrawerState({ open: true, mode: 'create' })}
              >
                Add {activeTab.replace('_', ' ')}
              </Button>
            </Stack>
          </div>

          <TabsBar>
            <Tab label="Trades" active={activeTab === 'trade'} onChangeTab={() => setActiveTab('trade')} counter={rowsByKind.trade.length} />
            <Tab label="Dividends" active={activeTab === 'dividend'} onChangeTab={() => setActiveTab('dividend')} counter={rowsByKind.dividend.length} />
            <Tab label="Cashflows" active={activeTab === 'cashflow'} onChangeTab={() => setActiveTab('cashflow')} counter={rowsByKind.cashflow.length} />
            <Tab label="FX Conversions" active={activeTab === 'fx_conversion'} onChangeTab={() => setActiveTab('fx_conversion')} counter={rowsByKind.fx_conversion.length} />
            <Tab label="Transfers In" active={activeTab === 'transfer_in'} onChangeTab={() => setActiveTab('transfer_in')} counter={rowsByKind.transfer_in.length} />
          </TabsBar>

          <div className={styles.tableWrapper}>
            <EventTable
              kind={activeTab}
              rows={tabRows}
              onEdit={(row) => {
                if (activeTab === 'trade') {
                  const tr = row as TradeListRow;
                  setDrawerState({
                    open: true,
                    mode: 'edit',
                    initial: {
                      kind: 'trade',
                      instrument_id: tr.instrument_id ?? '',
                      trade_id: tr.trade_id ?? undefined,
                      side: (tr.side as 'buy' | 'sell') ?? 'buy',
                      price: tr.price ?? 0,
                      quantity: tr.quantity ?? 0,
                      currency: tr.currency ?? 'USD',
                      venue: tr.venue ?? 'manual',
                      commission: undefined,
                      fees: undefined,
                      event_ts: tr.event_ts,
                    },
                  });
                } else {
                  appEvents.emit(AppEvents.alertWarning, [
                    `Edit for ${activeTab} surfaces in a future PR — values shown are correction-tracked already.`,
                  ]);
                }
              }}
              onDelete={(row) => setDeleteTarget({ row, kind: activeTab })}
            />
          </div>

          {refreshing && <div className={styles.muted}>Loading…</div>}
        </>
      )}

      {deleteTarget && (
        <ConfirmModal
          isOpen
          title={`Delete ${deleteTarget.kind.replace('_', ' ')} event`}
          body="This records a tombstone and removes the event from the portfolio. This cannot be undone."
          confirmText="Delete"
          dismissText="Cancel"
          onConfirm={() => {
            const { row, kind } = deleteTarget;
            setDeleteTarget(null);
            void handleDelete(row, kind);
          }}
          onDismiss={() => setDeleteTarget(null)}
        />
      )}

      {drawerState.open && selected && (
        <EventDrawer
          mode={drawerState.mode}
          kind={activeTab}
          initial={drawerState.initial}
          onClose={() => setDrawerState({ open: false, mode: 'create' })}
          onSubmit={handleSubmit}
        />
      )}
    </Page>
  );
}

type EventTableProps = {
  kind: EventKind;
  rows: AnyRow[];
  onEdit: (row: AnyRow) => void;
  onDelete: (row: AnyRow) => void;
};

function EventTable({ kind, rows, onEdit, onDelete }: EventTableProps) {
  const styles = useStyles2(getStyles);
  const columns = useMemo<Array<Column<AnyRow>>>(() => columnsFor(kind, onEdit, onDelete, styles), [kind, onEdit, onDelete, styles]);

  if (rows.length === 0) {
    return (
      <div className={styles.emptyTable}>
        <Icon name="info-circle" /> No {kind.replace('_', ' ')} events yet.
      </div>
    );
  }
  return <InteractiveTable columns={columns} data={rows} getRowId={(row, i) => String(idForRow(kind, row, i))} />;
}

function idForRow(kind: EventKind, row: AnyRow, i: number): string {
  return sourceIdForRow(row, kind) ?? `row-${i}`;
}

// The tombstone source_id is the event's own published source_id per kind.
// Transfers are published one-per-lot keyed on lot_id (transfer_id only groups
// lots in the payload), so the per-row source_id is lot_id.
// idForRow delegates here and applies the index fallback.
function sourceIdForRow(row: AnyRow, kind: EventKind): string | undefined {
  switch (kind) {
    case 'trade':
      return (row as TradeListRow).trade_id ?? undefined;
    case 'dividend':
      return (row as DividendListRow).dividend_id ?? undefined;
    case 'cashflow':
      return (row as CashflowListRow).cashflow_id ?? undefined;
    case 'fx_conversion':
      return (row as FxConversionListRow).fx_conversion_id ?? undefined;
    case 'transfer_in':
      return (row as TransferInListRow).lot_id ?? undefined;
  }
}

function columnsFor(
  kind: EventKind,
  onEdit: (row: AnyRow) => void,
  onDelete: (row: AnyRow) => void,
  styles: ReturnType<typeof getStyles>,
): Array<Column<AnyRow>> {
  const tsCol: Column<AnyRow> = {
    id: 'event_ts',
    header: 'When',
    cell: ({ row }) => <span className={styles.mono}>{formatEventMicros((row.original as AnyRow).event_ts)}</span>,
  };
  const actionsCol: Column<AnyRow> = {
    id: 'actions',
    header: '',
    cell: ({ row }) => (
      <Stack direction="row" gap={0.5}>
        <Button size="sm" fill="text" icon="edit" onClick={() => onEdit(row.original as AnyRow)} aria-label="Edit" />
        <Button size="sm" fill="text" variant="destructive" icon="trash-alt" onClick={() => onDelete(row.original as AnyRow)} aria-label="Delete" />
      </Stack>
    ),
  };

  if (kind === 'trade') {
    return [
      tsCol,
      { id: 'instrument_id', header: 'Instrument', cell: ({ row }) => <code>{(row.original as TradeListRow).instrument_id ?? ''}</code> },
      { id: 'side', header: 'Side', cell: ({ row }) => (row.original as TradeListRow).side },
      { id: 'quantity', header: 'Qty', cell: ({ row }) => fmtNum((row.original as TradeListRow).quantity) },
      { id: 'price', header: 'Price', cell: ({ row }) => fmtNum((row.original as TradeListRow).price) },
      { id: 'currency', header: 'CCY', cell: ({ row }) => (row.original as TradeListRow).currency },
      actionsCol,
    ];
  }
  if (kind === 'dividend') {
    return [
      tsCol,
      { id: 'instrument_id', header: 'Instrument', cell: ({ row }) => <code>{(row.original as DividendListRow).instrument_id ?? ''}</code> },
      { id: 'gross_native', header: 'Gross', cell: ({ row }) => fmtNum((row.original as DividendListRow).gross_native) },
      { id: 'withholding_native', header: 'Withholding', cell: ({ row }) => fmtNum((row.original as DividendListRow).withholding_native) },
      { id: 'currency', header: 'CCY', cell: ({ row }) => (row.original as DividendListRow).currency },
      actionsCol,
    ];
  }
  if (kind === 'cashflow') {
    return [
      tsCol,
      { id: 'type', header: 'Type', cell: ({ row }) => (row.original as CashflowListRow).type },
      { id: 'amount_native', header: 'Amount', cell: ({ row }) => fmtNum((row.original as CashflowListRow).amount_native) },
      { id: 'currency', header: 'CCY', cell: ({ row }) => (row.original as CashflowListRow).currency },
      actionsCol,
    ];
  }
  if (kind === 'fx_conversion') {
    return [
      tsCol,
      { id: 'from_currency', header: 'From', cell: ({ row }) => `${fmtNum((row.original as FxConversionListRow).from_amount)} ${(row.original as FxConversionListRow).from_currency}` },
      { id: 'to_currency', header: 'To', cell: ({ row }) => `${fmtNum((row.original as FxConversionListRow).to_amount)} ${(row.original as FxConversionListRow).to_currency}` },
      { id: 'rate', header: 'Rate', cell: ({ row }) => fmtNum((row.original as FxConversionListRow).rate) },
      actionsCol,
    ];
  }
  // transfer_in
  return [
    tsCol,
    { id: 'instrument_id', header: 'Instrument', cell: ({ row }) => <code>{(row.original as TransferInListRow).instrument_id ?? ''}</code> },
    { id: 'quantity', header: 'Qty', cell: ({ row }) => fmtNum((row.original as TransferInListRow).quantity) },
    { id: 'cost_basis_native', header: 'Cost basis', cell: ({ row }) => fmtNum((row.original as TransferInListRow).cost_basis_native) },
    { id: 'currency', header: 'CCY', cell: ({ row }) => (row.original as TransferInListRow).currency },
    actionsCol,
  ];
}

function fmtNum(value: number | null | undefined): string {
  if (value === null || value === undefined) return '';
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: 6 });
}

const getStyles = (theme: GrafanaTheme2) => ({
  headerRow: css({
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    marginBottom: theme.spacing(2),
    gap: theme.spacing(2),
    flexWrap: 'wrap',
  }),
  h2: css({
    margin: 0,
    fontSize: theme.typography.h3.fontSize,
  }),
  sub: css({
    color: theme.colors.text.secondary,
    marginTop: theme.spacing(0.5),
    marginBottom: 0,
  }),
  tableWrapper: css({
    marginTop: theme.spacing(2),
    backgroundColor: theme.colors.background.primary,
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    overflow: 'hidden',
  }),
  emptyTable: css({
    padding: theme.spacing(4),
    textAlign: 'center',
    color: theme.colors.text.secondary,
  }),
  muted: css({
    color: theme.colors.text.secondary,
    padding: theme.spacing(2),
  }),
  mono: css({
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
});
