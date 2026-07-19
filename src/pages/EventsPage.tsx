import React, { useCallback, useEffect, useState } from 'react';
import { css } from '@emotion/css';
import { useNavigate } from 'react-router-dom';

import { AppEvents, type GrafanaTheme2 } from '@grafana/data';
import { Button, ConfirmModal, FilterPill, Input, Stack, useStyles2 } from '@grafana/ui';

import { Page } from '../components/Page';
import { PortfolioSelector } from '../components/PortfolioSelector';
import { PLUGIN_BASE_URL, ROUTES } from '../constants';
import { usePortfolio } from '../contexts/PortfolioContext';
import { deleteEvent, listEvents, writeEvent } from '../api/reference';
import { appEvents } from '../lib/toast';
import type { EventInput, EventRow } from '../lib/events/types';
import { EventsTable, type FamilyFilter } from '../components/events/EventsTable';
import { EventDrawer, type DrawerState } from '../components/events/EventDrawer';

const FAMILY_PILLS: Array<{ label: string; value: FamilyFilter }> = [
  { label: 'All', value: 'all' },
  { label: 'Trades', value: 'trade' },
  { label: 'Income', value: 'income' },
  { label: 'Cash', value: 'cash' },
  { label: 'Transfers', value: 'transfer' },
  { label: 'Options', value: 'option' },
];

export function EventsPage() {
  const styles = useStyles2(getStyles);
  const navigate = useNavigate();
  const { selected, selectedPortfolio, portfolios, loading } = usePortfolio();

  const [rows, setRows] = useState<EventRow[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [family, setFamily] = useState<FamilyFilter>('all');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<EventRow | null>(null);

  const refresh = useCallback(async () => {
    if (!selected) {
      return;
    }
    setRefreshing(true);
    try {
      setRows(await listEvents(selected));
    } catch (err) {
      appEvents.emit(AppEvents.alertError, [err instanceof Error ? err.message : 'Failed to load events']);
    } finally {
      setRefreshing(false);
    }
  }, [selected]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount; state set after await
    void refresh();
  }, [refresh]);

  const handleSubmit = async (input: EventInput) => {
    try {
      await writeEvent(input);
      appEvents.emit(AppEvents.alertSuccess, ['Saved event.']);
      setDrawer(null);
      await refresh();
    } catch (err) {
      appEvents.emit(AppEvents.alertError, [err instanceof Error ? err.message : 'Save failed']);
    }
  };

  const handleDelete = async (row: EventRow) => {
    if (!selected) {
      return;
    }
    try {
      await deleteEvent(row.source_id, selected);
      appEvents.emit(AppEvents.alertSuccess, ['Deleted event.']);
      await refresh();
    } catch (err) {
      appEvents.emit(AppEvents.alertError, [err instanceof Error ? err.message : 'Delete failed']);
    }
  };

  const portfolioLabel = selectedPortfolio
    ? `${selectedPortfolio.attributes?.name?.trim() || 'Untitled portfolio'} · ${selectedPortfolio.base_currency}`
    : '';

  return (
    <Page>
      <PortfolioSelector />

      {!selected && !loading && (
        <div className={styles.muted}>
          {portfolios.length === 0 ? 'Create a portfolio first.' : 'Pick a portfolio from the selector above.'}
        </div>
      )}

      {selected && (
        <>
          <div className={styles.headerRow}>
            <div>
              <h2 className={styles.h2}>Events · {portfolioLabel}</h2>
              <p className={styles.sub}>All trades, income, cash, transfers and option events for this portfolio.</p>
            </div>
            <Stack direction="row" gap={1}>
              <Button variant="secondary" icon="upload" onClick={() => navigate(`${PLUGIN_BASE_URL}/${ROUTES.Import}`)}>
                Bulk import
              </Button>
              <Button icon="plus" onClick={() => setDrawer({ mode: 'create', type: 'TRADE' })}>
                Add event
              </Button>
            </Stack>
          </div>

          <div className={styles.controls}>
            <Input
              prefix={<span>🔎</span>}
              placeholder="Search events…"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              width={40}
            />
            <Stack direction="row" gap={0.5}>
              {FAMILY_PILLS.map((p) => (
                <FilterPill key={p.value} label={p.label} selected={family === p.value} onClick={() => setFamily(p.value)} />
              ))}
            </Stack>
          </div>

          <div className={styles.tableWrapper}>
            <EventsTable
              rows={rows}
              query={query}
              family={family}
              sortDir={sortDir}
              onToggleSort={() => setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))}
              onRowClick={(row) => setDrawer({ mode: 'detail', type: row.event_type, row })}
            />
          </div>
          {refreshing && <div className={styles.muted}>Loading…</div>}
        </>
      )}

      {deleteTarget && (
        <ConfirmModal
          isOpen
          title="Delete event"
          body="This records a tombstone and removes the event from the portfolio. This cannot be undone."
          confirmText="Delete"
          dismissText="Cancel"
          onConfirm={() => {
            const row = deleteTarget;
            setDeleteTarget(null);
            setDrawer(null);
            void handleDelete(row);
          }}
          onDismiss={() => setDeleteTarget(null)}
        />
      )}

      {drawer && selected && (
        <EventDrawer
          state={drawer}
          portfolioId={selected}
          onClose={() => setDrawer(null)}
          onSubmit={handleSubmit}
          onEdit={(row) => setDrawer({ mode: 'edit', type: row.event_type, row })}
          onDelete={(row) => setDeleteTarget(row)}
        />
      )}
    </Page>
  );
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
  h2: css({ margin: 0, fontSize: theme.typography.h3.fontSize }),
  sub: css({ color: theme.colors.text.secondary, marginTop: theme.spacing(0.5), marginBottom: 0 }),
  controls: css({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing(2),
    marginBottom: theme.spacing(1.5),
    flexWrap: 'wrap',
  }),
  tableWrapper: css({
    backgroundColor: theme.colors.background.primary,
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    overflow: 'auto',
  }),
  muted: css({ color: theme.colors.text.secondary, padding: theme.spacing(2) }),
});
