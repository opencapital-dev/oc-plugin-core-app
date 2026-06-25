import React, { useMemo } from 'react';
import { css } from '@emotion/css';
import { type GrafanaTheme2 } from '@grafana/data';
import { Icon, useStyles2 } from '@grafana/ui';

import { formatEventMicros } from '../../lib/time';
import { EVENT_REGISTRY } from '../../lib/events/registry';
import type { EventRow } from '../../lib/events/types';

export type FamilyFilter = 'all' | 'trade' | 'income' | 'cash' | 'transfer' | 'option';

type SortDir = 'asc' | 'desc';

export function searchTextForRow(row: EventRow): string {
  const def = EVENT_REGISTRY[row.event_type];
  const summary = def ? def.summary(row) : { instrument: '', side: '', amount: '', currency: '' };
  return [
    def?.label ?? row.event_type,
    row.instrument_id ?? '',
    summary.side,
    summary.amount,
    summary.currency,
    ...Object.values(row.payload).map((v) => String(v ?? '')),
  ]
    .join(' ')
    .toLowerCase();
}

export function filterAndSortEvents(
  rows: EventRow[],
  opts: { query: string; family: FamilyFilter; sortDir: SortDir },
): EventRow[] {
  const q = opts.query.trim().toLowerCase();
  const filtered = rows.filter((row) => {
    const def = EVENT_REGISTRY[row.event_type];
    if (opts.family !== 'all' && def?.family !== opts.family) {
      return false;
    }
    if (q && !searchTextForRow(row).includes(q)) {
      return false;
    }
    return true;
  });
  filtered.sort((a, b) =>
    opts.sortDir === 'desc' ? b.business_ts - a.business_ts : a.business_ts - b.business_ts,
  );
  return filtered;
}

type EventsTableProps = {
  rows: EventRow[];
  query: string;
  family: FamilyFilter;
  sortDir: SortDir;
  onToggleSort: () => void;
  onRowClick: (row: EventRow) => void;
};

export function EventsTable({ rows, query, family, sortDir, onToggleSort, onRowClick }: EventsTableProps) {
  const styles = useStyles2(getStyles);
  const visible = useMemo(() => filterAndSortEvents(rows, { query, family, sortDir }), [rows, query, family, sortDir]);

  if (visible.length === 0) {
    return (
      <div className={styles.empty}>
        <Icon name="info-circle" /> No events match.
      </div>
    );
  }

  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th className={styles.sortable} onClick={onToggleSort}>
            Time <Icon name={sortDir === 'desc' ? 'arrow-down' : 'arrow-up'} size="sm" />
          </th>
          <th>Type</th>
          <th>Instrument</th>
          <th>Side</th>
          <th className={styles.right}>Amount</th>
          <th>CCY</th>
        </tr>
      </thead>
      <tbody>
        {visible.map((row) => {
          const def = EVENT_REGISTRY[row.event_type];
          const summary = def.summary(row);
          return (
            <tr key={row.source_id} className={styles.row} onClick={() => onRowClick(row)}>
              <td className={styles.mono}>{formatEventMicros(row.business_ts)}</td>
              <td>{def.label}</td>
              <td><code>{summary.instrument}</code></td>
              <td>{summary.side}</td>
              <td className={styles.right}>{summary.amount}</td>
              <td>{summary.currency}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  table: css({
    width: '100%',
    borderCollapse: 'collapse',
    'th, td': {
      textAlign: 'left',
      padding: theme.spacing(1, 1.5),
      borderBottom: `1px solid ${theme.colors.border.weak}`,
      fontSize: theme.typography.bodySmall.fontSize,
    },
    th: { color: theme.colors.text.secondary, fontWeight: theme.typography.fontWeightMedium },
  }),
  sortable: css({ cursor: 'pointer', userSelect: 'none' }),
  right: css({ textAlign: 'right' }),
  row: css({ cursor: 'pointer', '&:hover': { backgroundColor: theme.colors.background.secondary } }),
  mono: css({ fontFamily: theme.typography.fontFamilyMonospace, whiteSpace: 'nowrap' }),
  empty: css({ padding: theme.spacing(4), textAlign: 'center', color: theme.colors.text.secondary }),
});
