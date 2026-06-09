import React from 'react';
import { css } from '@emotion/css';
import { useMemo, useState } from 'react';

import { type GrafanaTheme2 } from '@grafana/data';
import { Button, IconButton, Input, useStyles2 } from '@grafana/ui';

import type { AcquisitionLot, TransferInRequest } from '../../api/reference';
import { datetimeLocalToMicros, microsToDatetimeLocalValue } from '../../lib/time';

type Props = {
  transfers: TransferInRequest[];
  onConfirm: (flattened: TransferInRequest[]) => void;
  onBack: () => void;
};

type LotsByTransfer = Record<string, AcquisitionLot[]>;

// crypto.randomUUID is only exposed in secure contexts (HTTPS or
// localhost). Grafana served over plain HTTP from a remote host falls
// back to crypto.getRandomValues, which is universally available and
// gives the same v4-UUID randomness quality.
function newLotId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

function defaultLots(t: TransferInRequest): AcquisitionLot[] {
  return [
    {
      lot_id: newLotId(),
      quantity: t.quantity,
      cost_native: t.cost_basis_native,
      acquisition_date: t.acquisition_date,
      fx_rate_at_acquisition: t.fx_rate_at_acquisition,
    },
  ];
}

function sum(values: number[]): number {
  return values.reduce((s, v) => s + v, 0);
}

function approxEq(a: number, b: number, tol = 1e-4): boolean {
  return Math.abs(a - b) <= tol;
}

function tidOf(t: TransferInRequest): string {
  return t.transfer_id ?? `${t.instrument_id}-${t.event_ts ?? 0}`;
}

export function LotsStep({ transfers, onConfirm, onBack }: Props) {
  const styles = useStyles2(getStyles);
  const [lotsByTransfer, setLotsByTransfer] = useState<LotsByTransfer>(() => {
    const initial: LotsByTransfer = {};
    for (const t of transfers) {
      initial[tidOf(t)] = defaultLots(t);
    }
    return initial;
  });

  const validation = useMemo(() => {
    const result: Record<string, { qtyOk: boolean; costOk: boolean }> = {};
    for (const t of transfers) {
      const tid = tidOf(t);
      const lots = lotsByTransfer[tid] ?? [];
      result[tid] = {
        qtyOk: approxEq(sum(lots.map((l) => l.quantity)), t.quantity),
        costOk: approxEq(sum(lots.map((l) => l.cost_native)), t.cost_basis_native, 1e-2),
      };
    }
    return result;
  }, [transfers, lotsByTransfer]);

  const allValid = Object.values(validation).every((v) => v.qtyOk && v.costOk);

  function updateLot(tid: string, idx: number, patch: Partial<AcquisitionLot>) {
    setLotsByTransfer((prev) => {
      const next = { ...prev };
      const lots = next[tid].map((l, i) => (i === idx ? { ...l, ...patch } : l));
      next[tid] = lots;
      return next;
    });
  }

  function addLot(tid: string, template: TransferInRequest) {
    setLotsByTransfer((prev) => ({
      ...prev,
      [tid]: [
        ...prev[tid],
        {
          lot_id: newLotId(),
          quantity: 0,
          cost_native: 0,
          acquisition_date: template.acquisition_date,
          fx_rate_at_acquisition: template.fx_rate_at_acquisition,
        },
      ],
    }));
  }

  function removeLot(tid: string, idx: number) {
    setLotsByTransfer((prev) => {
      const next = { ...prev };
      next[tid] = next[tid].filter((_, i) => i !== idx);
      return next;
    });
  }

  function handleNext() {
    if (!allValid) {
      return;
    }
    const flattened: TransferInRequest[] = [];
    for (const t of transfers) {
      for (const lot of lotsByTransfer[tidOf(t)]) {
        flattened.push({
          ...t,
          quantity: lot.quantity,
          cost_basis_native: lot.cost_native,
          acquisition_date: lot.acquisition_date,
          fx_rate_at_acquisition: lot.fx_rate_at_acquisition,
          lot_id: lot.lot_id,
        });
      }
    }
    onConfirm(flattened);
  }

  return (
    <div className={styles.root}>
      <h3 className={styles.heading}>Acquisition lot detail</h3>
      <p className={styles.muted}>
        Each transferred position usually arrived from prior purchases (often multiple tranches).
        Enter each acquisition lot below so realized P&amp;L and IRR reflect the full holding
        history. Default: a single lot at the transfer date.
      </p>

      {transfers.map((t) => {
        const tid = tidOf(t);
        const lots = lotsByTransfer[tid] ?? [];
        const v = validation[tid];
        const qtySum = sum(lots.map((l) => l.quantity));
        const costSum = sum(lots.map((l) => l.cost_native));
        return (
          <section key={tid} className={styles.card}>
            <h4 className={styles.cardHeading}>
              {t.instrument_id} — {t.quantity} shares at total {t.cost_basis_native.toFixed(2)}{' '}
              {t.currency}
            </h4>
            <div className={styles.tableScroll}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Quantity</th>
                    <th>Cost ({t.currency})</th>
                    <th>Acquisition date</th>
                    <th>FX (base / {t.currency})</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {lots.map((lot, idx) => (
                    <tr key={lot.lot_id}>
                      <td>{idx + 1}</td>
                      <td>
                        <Input
                          type="number"
                          step="0.000001"
                          value={lot.quantity}
                          onChange={(e) =>
                            updateLot(tid, idx, {
                              quantity: parseFloat(e.currentTarget.value) || 0,
                            })
                          }
                        />
                      </td>
                      <td>
                        <Input
                          type="number"
                          step="0.01"
                          value={lot.cost_native}
                          onChange={(e) =>
                            updateLot(tid, idx, {
                              cost_native: parseFloat(e.currentTarget.value) || 0,
                            })
                          }
                        />
                      </td>
                      <td>
                        <Input
                          type="datetime-local"
                          step="1"
                          value={microsToDatetimeLocalValue(lot.acquisition_date)}
                          onChange={(e) =>
                            updateLot(tid, idx, {
                              acquisition_date: datetimeLocalToMicros(e.currentTarget.value),
                            })
                          }
                        />
                      </td>
                      <td>
                        <Input
                          type="number"
                          step="0.0001"
                          value={lot.fx_rate_at_acquisition}
                          onChange={(e) =>
                            updateLot(tid, idx, {
                              fx_rate_at_acquisition: parseFloat(e.currentTarget.value) || 0,
                            })
                          }
                        />
                      </td>
                      <td>
                        <IconButton
                          name="minus"
                          aria-label="Remove lot"
                          tooltip="Remove lot"
                          disabled={lots.length === 1}
                          onClick={() => removeLot(tid, idx)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className={styles.cardActions}>
              <Button size="sm" variant="secondary" onClick={() => addLot(tid, t)}>
                + Add lot
              </Button>
              <span className={v.qtyOk ? styles.ok : styles.bad}>
                Quantity sum: {qtySum} / {t.quantity}
              </span>
              <span className={v.costOk ? styles.ok : styles.bad}>
                Cost sum: {costSum.toFixed(2)} / {t.cost_basis_native.toFixed(2)} {t.currency}
              </span>
            </div>
          </section>
        );
      })}

      <div className={styles.stepNav}>
        <Button variant="secondary" onClick={onBack}>
          ← Back
        </Button>
        <Button disabled={!allValid} onClick={handleNext}>
          Next: Confirm →
        </Button>
      </div>
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  root: css({
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(2),
  }),
  heading: css({
    margin: 0,
    fontSize: theme.typography.h4.fontSize,
  }),
  cardHeading: css({
    margin: 0,
    fontSize: theme.typography.body.fontSize,
    fontWeight: theme.typography.fontWeightMedium,
  }),
  muted: css({
    margin: 0,
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  card: css({
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(1),
    padding: theme.spacing(1.5),
    background: theme.colors.background.primary,
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
  }),
  cardActions: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(2),
    flexWrap: 'wrap',
  }),
  tableScroll: css({
    overflowX: 'auto',
  }),
  table: css({
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: theme.typography.bodySmall.fontSize,
    'th, td': {
      padding: theme.spacing(0.5),
      borderBottom: `1px solid ${theme.colors.border.weak}`,
      verticalAlign: 'middle',
      textAlign: 'left',
    },
    th: {
      color: theme.colors.text.secondary,
    },
  }),
  ok: css({
    color: theme.colors.success.text,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  bad: css({
    color: theme.colors.error.text,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  stepNav: css({
    display: 'flex',
    justifyContent: 'space-between',
    gap: theme.spacing(1),
  }),
});
