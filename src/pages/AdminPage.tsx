import React, { useState } from 'react';
import { css } from '@emotion/css';
import { useNavigate } from 'react-router-dom';

import { AppEvents, type GrafanaTheme2 } from '@grafana/data';
import { Button, Field, Icon, Input, Stack, useStyles2 } from '@grafana/ui';

import { Page } from '../components/Page';
import { PortfolioSelector } from '../components/PortfolioSelector';
import { PLUGIN_BASE_URL, ROUTES } from '../constants';
import { usePortfolio } from '../contexts/PortfolioContext';
import { createPortfolio } from '../api/reference';
import { appEvents } from '../lib/toast';

/**
 * Landing page. Two states:
 * - **Empty**: no portfolios yet — prominent "Create Portfolio" form.
 * - **Populated**: a portfolio is selected — three tile-buttons routing
 *   to Import, Events, Instruments.
 */
export function AdminPage() {
  const styles = useStyles2(getStyles);
  const navigate = useNavigate();
  const { portfolios, selected, selectedPortfolio, refresh, setSelected, loading } = usePortfolio();
  const selectedName = selectedPortfolio?.attributes?.name?.trim() || 'Untitled portfolio';

  const [name, setName] = useState('');
  const [baseCurrency, setBaseCurrency] = useState('USD');
  const [busy, setBusy] = useState(false);

  async function handleCreate() {
    const portfolioName = name.trim();
    if (!portfolioName) {
      appEvents.emit(AppEvents.alertError, ['Name is required.']);
      return;
    }
    setBusy(true);
    try {
      // portfolio_id is a server-generated UUID (v6 canonical); the
      // human-facing label lives in attributes.name. Send a blank id so the
      // backend mints the UUID.
      const created = await createPortfolio({
        portfolio_id: '',
        base_currency: baseCurrency.trim() || 'USD',
        attributes: { name: portfolioName },
      });
      appEvents.emit(AppEvents.alertSuccess, [`Portfolio "${portfolioName}" created.`]);
      await refresh();
      setSelected(created.portfolio_id);
      setName('');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create portfolio';
      appEvents.emit(AppEvents.alertError, [message]);
    } finally {
      setBusy(false);
    }
  }

  const noPortfolios = !loading && portfolios.length === 0;

  return (
    <Page>
      <PortfolioSelector />

      {noPortfolios && (
        <div className={styles.empty}>
          <Icon name="folder-plus" size="xxxl" className={styles.emptyIcon} />
          <h2 className={styles.emptyTitle}>Create your first portfolio</h2>
          <p className={styles.emptySub}>
            A portfolio is a logical grouping of events (trades, dividends, cashflows, FX, transfers)
            scoped to a base currency. You&apos;ll be able to import trades and view events once at
            least one portfolio exists.
          </p>
          <div className={styles.createForm}>
            <Stack direction="row" gap={2} alignItems="end" wrap>
              <Field label="Name" required>
                <Input
                  width={28}
                  value={name}
                  onChange={(e) => setName(e.currentTarget.value)}
                  placeholder="e.g. Growth"
                />
              </Field>
              <Field label="Base currency">
                <Input
                  width={10}
                  value={baseCurrency}
                  onChange={(e) => setBaseCurrency(e.currentTarget.value.toUpperCase())}
                  placeholder="USD"
                />
              </Field>
              <Button onClick={handleCreate} disabled={busy} icon="plus">
                Create portfolio
              </Button>
            </Stack>
          </div>
        </div>
      )}

      {!noPortfolios && selected && (
        <>
          <div className={styles.heading}>
            <h2 className={styles.h2}>What would you like to do?</h2>
            <p className={styles.sub}>Working on portfolio &ldquo;{selectedName}&rdquo;.</p>
          </div>

          <div className={styles.tiles}>
            <TileButton
              icon="upload"
              title="Import trades"
              description="Bulk-import trades, dividends, cashflows from a broker CSV."
              onClick={() => navigate(`${PLUGIN_BASE_URL}/${ROUTES.Import}`)}
              styles={styles}
            />
            <TileButton
              icon="list-ul"
              title="View events"
              description="Trades, dividends, cashflows, FX conversions, transfers — add, edit, delete."
              onClick={() => navigate(`${PLUGIN_BASE_URL}/${ROUTES.Events}`)}
              styles={styles}
            />
            <TileButton
              icon="chart-line"
              title="View instruments"
              description="Manage instrument identity: equity, fx pair, cash. Sector/subindustry metadata."
              onClick={() => navigate(`${PLUGIN_BASE_URL}/${ROUTES.Instruments}`)}
              styles={styles}
            />
          </div>

          <div className={styles.footer}>
            <Button
              variant="secondary"
              fill="text"
              icon="folder"
              onClick={() => navigate(`${PLUGIN_BASE_URL}/${ROUTES.Portfolios}`)}
            >
              Manage portfolios
            </Button>
            <Button
              variant="secondary"
              fill="text"
              icon="apps"
              onClick={() => navigate(`${PLUGIN_BASE_URL}/${ROUTES.Plugins}`)}
            >
              Plugins
            </Button>
          </div>
        </>
      )}

      {!noPortfolios && !selected && !loading && (
        <div className={styles.muted}>Pick a portfolio from the selector above to get started.</div>
      )}
    </Page>
  );
}

type TileProps = {
  icon: 'upload' | 'list-ul' | 'chart-line';
  title: string;
  description: string;
  onClick: () => void;
  styles: ReturnType<typeof getStyles>;
};

function TileButton({ icon, title, description, onClick, styles }: TileProps) {
  return (
    <button className={styles.tile} onClick={onClick} type="button">
      <Icon name={icon} size="xl" className={styles.tileIcon} />
      <div className={styles.tileTitle}>{title}</div>
      <div className={styles.tileDesc}>{description}</div>
    </button>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  empty: css({
    textAlign: 'center',
    padding: theme.spacing(6, 3),
    backgroundColor: theme.colors.background.secondary,
    borderRadius: theme.shape.radius.default,
    border: `1px solid ${theme.colors.border.weak}`,
    maxWidth: 720,
    margin: '0 auto',
  }),
  emptyIcon: css({
    color: theme.colors.primary.text,
    marginBottom: theme.spacing(2),
  }),
  emptyTitle: css({
    fontSize: theme.typography.h2.fontSize,
    marginBottom: theme.spacing(1),
  }),
  emptySub: css({
    color: theme.colors.text.secondary,
    maxWidth: 480,
    margin: `0 auto ${theme.spacing(3)} auto`,
    lineHeight: 1.5,
  }),
  createForm: css({
    display: 'flex',
    justifyContent: 'center',
    marginTop: theme.spacing(3),
  }),
  heading: css({
    marginBottom: theme.spacing(3),
  }),
  h2: css({
    margin: 0,
    fontSize: theme.typography.h3.fontSize,
  }),
  sub: css({
    color: theme.colors.text.secondary,
    marginTop: theme.spacing(0.5),
  }),
  tiles: css({
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
    gap: theme.spacing(2),
    marginBottom: theme.spacing(3),
  }),
  tile: css({
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    textAlign: 'left',
    padding: theme.spacing(3),
    backgroundColor: theme.colors.background.secondary,
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    cursor: 'pointer',
    transition: 'border-color 120ms ease, background-color 120ms ease',
    '&:hover': {
      borderColor: theme.colors.primary.border,
      backgroundColor: theme.colors.background.canvas,
    },
  }),
  tileIcon: css({
    color: theme.colors.primary.text,
    marginBottom: theme.spacing(1.5),
  }),
  tileTitle: css({
    fontSize: theme.typography.h4.fontSize,
    fontWeight: theme.typography.fontWeightMedium,
    marginBottom: theme.spacing(0.5),
  }),
  tileDesc: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    lineHeight: 1.4,
  }),
  footer: css({
    marginTop: theme.spacing(2),
  }),
  muted: css({
    color: theme.colors.text.secondary,
    textAlign: 'center',
    padding: theme.spacing(4),
  }),
});
