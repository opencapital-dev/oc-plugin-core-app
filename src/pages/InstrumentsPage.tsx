import React, { useEffect, useState } from 'react';
import { AppEvents } from '@grafana/data';
import { Badge, InteractiveTable, type Column } from '@grafana/ui';

import { Page } from '../components/Page';
import { PortfolioSelector } from '../components/PortfolioSelector';
import { usePortfolio } from '../contexts/PortfolioContext';
import { listInstruments, type InstrumentEntity } from '../api/reference';
import { appEvents } from '../lib/toast';

/**
 * Read-only view of the instruments the selected portfolio has ever held,
 * derived from the event stream (no control-plane instruments table). kind +
 * contract_multiplier are carried on the trade events themselves.
 */
export function InstrumentsPage() {
  const { selected } = usePortfolio();
  const [rows, setRows] = useState<InstrumentEntity[] | null>(null);

  useEffect(() => {
    if (!selected) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear rows when no portfolio selected
      setRows([]);
      return;
    }
    let alive = true;
    listInstruments(selected)
      .then((data) => alive && setRows(data))
      .catch((err) => {
        appEvents.emit(AppEvents.alertError, [err instanceof Error ? err.message : 'Failed to load instruments']);
        if (alive) {setRows([]);}
      });
    return () => { alive = false; };
  }, [selected]);

  const columns: Array<Column<InstrumentEntity>> = [
    { id: 'instrument_id', header: 'Instrument', cell: ({ row }) => <code>{row.original.instrument_id}</code> },
    { id: 'kind', header: 'Kind', cell: ({ row }) => <Badge color="blue" text={row.original.kind} /> },
    { id: 'contract_multiplier', header: 'Multiplier', cell: ({ row }) => row.original.contract_multiplier ?? 1 },
  ];

  return (
    <Page>
      <Page.Contents>
        <PortfolioSelector />
        {!selected ? (
          <p>Select a portfolio to see the instruments it has held.</p>
        ) : rows && rows.length > 0 ? (
          <InteractiveTable columns={columns} data={rows} getRowId={(r) => r.instrument_id} pageSize={50} />
        ) : (
          <p>{rows ? 'No instruments held by this portfolio yet.' : 'Loading…'}</p>
        )}
      </Page.Contents>
    </Page>
  );
}
