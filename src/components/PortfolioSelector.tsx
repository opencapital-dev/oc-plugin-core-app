import React from 'react';
import { css } from '@emotion/css';
import { type GrafanaTheme2 } from '@grafana/data';
import { Icon, Select, useStyles2 } from '@grafana/ui';

import { usePortfolio } from '../contexts/PortfolioContext';

/**
 * Top-of-page portfolio dropdown. Lives on every page that scopes its
 * content by portfolio (Admin landing, Events). Renders nothing while the
 * portfolio list is loading or when there are zero portfolios — in those
 * states the AdminPage shows the "Create Portfolio" CTA instead.
 */
export function PortfolioSelector() {
  const styles = useStyles2(getStyles);
  const { portfolios, selected, setSelected, loading } = usePortfolio();

  if (loading || portfolios.length === 0) {
    return null;
  }

  const options = portfolios.map((p) => {
    const name = p.attributes?.name?.trim();
    const label = name
      ? `${name}  ·  ${p.base_currency}`
      : `${p.portfolio_id.slice(0, 8)}…  ·  ${p.base_currency}`;
    return { label, value: p.portfolio_id };
  });

  return (
    <div className={styles.bar}>
      <span className={styles.label}>
        <Icon name="folder" /> Portfolio
      </span>
      <div className={styles.select}>
        <Select
          options={options}
          value={selected ?? undefined}
          onChange={(opt) => setSelected(opt?.value ?? null)}
          placeholder="Select a portfolio"
          width={40}
        />
      </div>
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  bar: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(2),
    padding: theme.spacing(1.5, 2),
    marginBottom: theme.spacing(2),
    backgroundColor: theme.colors.background.secondary,
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
  }),
  label: css({
    fontSize: theme.typography.bodySmall.fontSize,
    color: theme.colors.text.secondary,
    display: 'inline-flex',
    alignItems: 'center',
    gap: theme.spacing(0.5),
    fontWeight: theme.typography.fontWeightMedium,
  }),
  select: css({
    flex: '0 0 auto',
  }),
});
