import React from 'react';
import { css } from '@emotion/css';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { AppEvents, type GrafanaTheme2 } from '@grafana/data';
import {
  Badge,
  Button,
  ConfirmModal,
  Field,
  InteractiveTable,
  Input,
  Stack,
  TextArea,
  useStyles2,
  type Column,
} from '@grafana/ui';
import { Page } from '../components/Page';
import { appEvents } from '../lib/toast';

import {
  createPortfolio,
  deletePortfolio,
  listPortfolios,
  type PortfolioEntity,
} from '../api/reference';
import { formatAttributes, parseAttributes } from '../lib/attributes';
import { formatEventMicros } from '../lib/time';

type FormState = {
  portfolioId: string;
  name: string;
  baseCurrency: string;
  accountId: string;
  attributesText: string;
};

const emptyForm = (): FormState => ({
  portfolioId: '',
  name: '',
  baseCurrency: 'USD',
  accountId: '',
  attributesText: '',
});

export function PortfoliosPage() {
  const styles = useStyles2(getStyles);
  const [portfolios, setPortfolios] = useState<PortfolioEntity[] | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [busy, setBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await listPortfolios();
      setPortfolios(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load portfolios';
      appEvents.emit(AppEvents.alertError, [message]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleCreate() {
    if (!form.name.trim()) {
      appEvents.emit(AppEvents.alertError, ['Name is required.']);
      return;
    }
    setBusy(true);
    try {
      const attributes = parseAttributes(form.attributesText);
      const accountId = form.accountId.trim();
      if (accountId) {
        attributes.account_id = accountId;
      }
      attributes.name = form.name.trim();
      await createPortfolio({
        portfolio_id: form.portfolioId.trim(),
        base_currency: form.baseCurrency.trim().toUpperCase() || 'USD',
        attributes,
      });
      setForm(emptyForm());
      await refresh();
      appEvents.emit(AppEvents.alertSuccess, ['Portfolio saved.']);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Create failed';
      appEvents.emit(AppEvents.alertError, [message]);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(portfolioId: string) {
    setDeleteTarget(null);
    setBusy(true);
    try {
      await deletePortfolio(portfolioId);
      await refresh();
      appEvents.emit(AppEvents.alertSuccess, [`Deleted portfolio ${portfolioId}.`]);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Delete failed';
      appEvents.emit(AppEvents.alertError, [message]);
    } finally {
      setBusy(false);
    }
  }

  const columns = useMemo<Array<Column<PortfolioEntity>>>(
    () => [
      {
        id: 'name',
        header: 'Name',
        cell: ({ row }) => (
          <strong>{row.original.attributes?.name ?? row.original.portfolio_id}</strong>
        ),
      },
      {
        id: 'portfolio_id',
        header: 'Portfolio ID',
        cell: ({ row }) => <code>{row.original.portfolio_id}</code>,
      },
      {
        id: 'base_currency',
        header: 'Base ccy',
        cell: ({ row }) => <Badge color="blue" text={row.original.base_currency} />,
      },
      {
        id: 'attributes',
        header: 'Attributes',
        cell: ({ row }) => formatAttributes(row.original.attributes),
      },
      {
        id: 'updated_at',
        header: 'Updated',
        cell: ({ row }) => formatEventMicros(row.original.updated_at),
      },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) => (
          <Button
            size="sm"
            variant="destructive"
            fill="outline"
            onClick={() => setDeleteTarget(row.original.portfolio_id)}
          >
            Delete
          </Button>
        ),
      },
    ],
    []
  );

  return (
    <Page navId="portfolio-portfolios">
      <Page.Contents>
        <Stack direction="column" gap={3}>
          <div className={styles.panel}>
            <h2 className={styles.heading}>Create portfolio</h2>
            <Stack direction="row" gap={2} wrap="wrap">
              <Field label="Name" required>
                <Input
                  value={form.name}
                  onChange={(e) => {
                    const value = e.currentTarget.value;
                    setForm((c) => ({ ...c, name: value }));
                  }}
                  placeholder="Growth"
                />
              </Field>
              <Field label="Portfolio ID" description="Optional. Auto-generated when blank.">
                <Input
                  value={form.portfolioId}
                  onChange={(e) => {
                    const value = e.currentTarget.value;
                    setForm((c) => ({ ...c, portfolioId: value }));
                  }}
                  placeholder="auto"
                />
              </Field>
              <Field label="Base currency" required>
                <Input
                  value={form.baseCurrency}
                  onChange={(e) => {
                    const value = e.currentTarget.value.toUpperCase();
                    setForm((c) => ({ ...c, baseCurrency: value }));
                  }}
                  placeholder="USD"
                />
              </Field>
              <Field
                label="Broker account ID"
                description="Optional. Matched against IBKR Activity Statement uploads."
              >
                <Input
                  value={form.accountId}
                  onChange={(e) => {
                    const value = e.currentTarget.value;
                    setForm((c) => ({ ...c, accountId: value }));
                  }}
                  placeholder="U11120332"
                />
              </Field>
            </Stack>
            <Field
              label="Attributes"
              description="key=value per line, or JSON"
            >
              <TextArea
                value={form.attributesText}
                onChange={(e) => {
                  const value = e.currentTarget.value;
                  setForm((c) => ({ ...c, attributesText: value }));
                }}
                placeholder={'benchmark_id=sp500\nrisk_model=barra'}
                rows={3}
              />
            </Field>
            <div>
              <Button onClick={handleCreate} disabled={busy}>
                {busy ? 'Saving…' : 'Save portfolio'}
              </Button>
            </div>
          </div>

          <div className={styles.panel}>
            <h2 className={styles.heading}>
              Portfolios {portfolios ? `(${portfolios.length})` : ''}
            </h2>
            {portfolios && portfolios.length > 0 ? (
              <InteractiveTable
                columns={columns}
                data={portfolios}
                getRowId={(row) => row.portfolio_id}
                pageSize={50}
              />
            ) : (
              <p className={styles.muted}>
                {portfolios ? 'No portfolios yet.' : 'Loading…'}
              </p>
            )}
          </div>
        </Stack>

        {deleteTarget ? (
          <ConfirmModal
            isOpen
            title="Delete portfolio"
            body={`Delete portfolio "${deleteTarget}"? This cannot be undone.`}
            confirmText="Delete"
            dismissText="Cancel"
            onConfirm={() => void handleDelete(deleteTarget)}
            onDismiss={() => setDeleteTarget(null)}
          />
        ) : null}
      </Page.Contents>
    </Page>
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
  muted: css({
    color: theme.colors.text.secondary,
    margin: 0,
  }),
});
