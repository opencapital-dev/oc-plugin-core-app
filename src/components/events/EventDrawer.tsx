import React, { useState } from 'react';
import { Button, Drawer, Field, Input, Select, Stack } from '@grafana/ui';

import type { CashflowType } from '../../api/reference';

export type EventKind =
  | 'trade'
  | 'dividend'
  | 'cashflow'
  | 'fx_conversion'
  | 'transfer_in';

/**
 * Discriminated form state per event-kind. The Drawer surfaces only the
 * fields applicable to the active kind.
 */
export type EventFormState =
  | {
      kind: 'trade';
      trade_id?: string;
      instrument_id: string;
      side: 'buy' | 'sell';
      price: number;
      quantity: number;
      currency: string;
      venue: string;
      commission: number | undefined;
      fees: number | undefined;
      event_ts: number;
    }
  | {
      kind: 'dividend';
      instrument_id: string;
      gross_native: number;
      withholding_native: number | undefined;
      currency: string;
      event_ts: number;
    }
  | {
      kind: 'cashflow';
      cashflow_type: CashflowType;
      amount_native: number;
      currency: string;
      event_ts: number;
    }
  | {
      kind: 'fx_conversion';
      from_currency: string;
      from_amount: number;
      to_currency: string;
      to_amount: number;
      rate: number;
      event_ts: number;
    }
  | {
      kind: 'transfer_in';
      instrument_id: string;
      quantity: number;
      cost_basis_native: number;
      currency: string;
      acquisition_date: number;
      fx_rate_at_acquisition: number;
      lot_id: string;
      event_ts: number;
    };

type Props = {
  mode: 'create' | 'edit';
  kind: EventKind;
  initial?: EventFormState;
  onClose: () => void;
  onSubmit: (form: EventFormState) => void;
};

function nowUs(): number {
  return Date.now() * 1000;
}

function emptyForm(kind: EventKind): EventFormState {
  const event_ts = nowUs();
  switch (kind) {
    case 'trade':
      return {
        kind: 'trade',
        instrument_id: '',
        side: 'buy',
        price: 0,
        quantity: 0,
        currency: 'USD',
        venue: 'manual',
        commission: undefined,
        fees: undefined,
        event_ts,
      };
    case 'dividend':
      return {
        kind: 'dividend',
        instrument_id: '',
        gross_native: 0,
        withholding_native: undefined,
        currency: 'USD',
        event_ts,
      };
    case 'cashflow':
      return {
        kind: 'cashflow',
        cashflow_type: 'DEPOSIT',
        amount_native: 0,
        currency: 'USD',
        event_ts,
      };
    case 'fx_conversion':
      return {
        kind: 'fx_conversion',
        from_currency: 'EUR',
        from_amount: 0,
        to_currency: 'USD',
        to_amount: 0,
        rate: 0,
        event_ts,
      };
    case 'transfer_in':
      return {
        kind: 'transfer_in',
        instrument_id: '',
        quantity: 0,
        cost_basis_native: 0,
        currency: 'USD',
        acquisition_date: event_ts,
        fx_rate_at_acquisition: 1,
        lot_id: '',
        event_ts,
      };
  }
}

export function EventDrawer({ mode, kind, initial, onClose, onSubmit }: Props) {
  const [form, setForm] = useState<EventFormState>(initial ?? emptyForm(kind));

  return (
    <Drawer
      title={`${mode === 'edit' ? 'Edit' : 'Add'} ${kind.replace('_', ' ')}`}
      onClose={onClose}
      size="md"
    >
      <Stack direction="column" gap={2}>
        {renderFields(form, setForm)}
        <Stack direction="row" gap={1} justifyContent="flex-end">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => onSubmit(form)} icon="save">
            {mode === 'edit' ? 'Save changes' : 'Create'}
          </Button>
        </Stack>
      </Stack>
    </Drawer>
  );
}

function renderFields(form: EventFormState, setForm: (f: EventFormState) => void) {
  const onChangeTs = (val: string) => {
    const ms = Date.parse(val);
    if (!Number.isFinite(ms)) return;
    setForm({ ...(form as any), event_ts: ms * 1000 });
  };
  const tsValue = new Date(form.event_ts / 1000).toISOString().slice(0, 16);

  if (form.kind === 'trade') {
    return (
      <>
        <Field label="Instrument ID" required>
          <Input
            value={form.instrument_id}
            onChange={(e) => setForm({ ...form, instrument_id: e.currentTarget.value })}
          />
        </Field>
        <Stack direction="row" gap={1}>
          <Field label="Side">
            <Select
              width={14}
              value={form.side}
              options={[
                { label: 'Buy', value: 'buy' },
                { label: 'Sell', value: 'sell' },
              ]}
              onChange={(opt) => setForm({ ...form, side: (opt.value as 'buy' | 'sell') ?? 'buy' })}
            />
          </Field>
          <Field label="Quantity">
            <Input
              type="number"
              value={form.quantity}
              onChange={(e) => setForm({ ...form, quantity: Number(e.currentTarget.value) })}
            />
          </Field>
          <Field label="Price">
            <Input
              type="number"
              value={form.price}
              onChange={(e) => setForm({ ...form, price: Number(e.currentTarget.value) })}
            />
          </Field>
          <Field label="Currency">
            <Input
              width={10}
              value={form.currency}
              onChange={(e) => setForm({ ...form, currency: e.currentTarget.value.toUpperCase() })}
            />
          </Field>
        </Stack>
        <Stack direction="row" gap={1}>
          <Field label="Venue">
            <Input
              value={form.venue}
              onChange={(e) => setForm({ ...form, venue: e.currentTarget.value })}
            />
          </Field>
          <Field label="Commission (optional)">
            <Input
              type="number"
              value={form.commission ?? ''}
              onChange={(e) =>
                setForm({
                  ...form,
                  commission: e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value),
                })
              }
            />
          </Field>
          <Field label="Fees (optional)">
            <Input
              type="number"
              value={form.fees ?? ''}
              onChange={(e) =>
                setForm({
                  ...form,
                  fees: e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value),
                })
              }
            />
          </Field>
        </Stack>
        <Field label="Event time (UTC)">
          <Input type="datetime-local" value={tsValue} onChange={(e) => onChangeTs(e.currentTarget.value)} />
        </Field>
      </>
    );
  }
  if (form.kind === 'dividend') {
    return (
      <>
        <Field label="Instrument ID" required>
          <Input value={form.instrument_id} onChange={(e) => setForm({ ...form, instrument_id: e.currentTarget.value })} />
        </Field>
        <Stack direction="row" gap={1}>
          <Field label="Gross (native)">
            <Input type="number" value={form.gross_native} onChange={(e) => setForm({ ...form, gross_native: Number(e.currentTarget.value) })} />
          </Field>
          <Field label="Withholding (optional)">
            <Input
              type="number"
              value={form.withholding_native ?? ''}
              onChange={(e) =>
                setForm({
                  ...form,
                  withholding_native: e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value),
                })
              }
            />
          </Field>
          <Field label="Currency">
            <Input width={10} value={form.currency} onChange={(e) => setForm({ ...form, currency: e.currentTarget.value.toUpperCase() })} />
          </Field>
        </Stack>
        <Field label="Event time (UTC)">
          <Input type="datetime-local" value={tsValue} onChange={(e) => onChangeTs(e.currentTarget.value)} />
        </Field>
      </>
    );
  }
  if (form.kind === 'cashflow') {
    return (
      <>
        <Stack direction="row" gap={1}>
          <Field label="Type">
            <Select
              width={20}
              value={form.cashflow_type}
              options={[
                { label: 'Deposit', value: 'DEPOSIT' },
                { label: 'Withdrawal', value: 'WITHDRAWAL' },
                { label: 'Interest on cash', value: 'INTEREST_ON_CASH' },
                { label: 'Fee', value: 'FEE' },
              ]}
              onChange={(opt) =>
                setForm({ ...form, cashflow_type: (opt.value as CashflowType) ?? 'DEPOSIT' })
              }
            />
          </Field>
          <Field label="Amount (native)">
            <Input type="number" value={form.amount_native} onChange={(e) => setForm({ ...form, amount_native: Number(e.currentTarget.value) })} />
          </Field>
          <Field label="Currency">
            <Input width={10} value={form.currency} onChange={(e) => setForm({ ...form, currency: e.currentTarget.value.toUpperCase() })} />
          </Field>
        </Stack>
        <Field label="Event time (UTC)">
          <Input type="datetime-local" value={tsValue} onChange={(e) => onChangeTs(e.currentTarget.value)} />
        </Field>
      </>
    );
  }
  if (form.kind === 'fx_conversion') {
    return (
      <>
        <Stack direction="row" gap={1}>
          <Field label="From CCY">
            <Input width={10} value={form.from_currency} onChange={(e) => setForm({ ...form, from_currency: e.currentTarget.value.toUpperCase() })} />
          </Field>
          <Field label="From amount">
            <Input type="number" value={form.from_amount} onChange={(e) => setForm({ ...form, from_amount: Number(e.currentTarget.value) })} />
          </Field>
          <Field label="To CCY">
            <Input width={10} value={form.to_currency} onChange={(e) => setForm({ ...form, to_currency: e.currentTarget.value.toUpperCase() })} />
          </Field>
          <Field label="To amount">
            <Input type="number" value={form.to_amount} onChange={(e) => setForm({ ...form, to_amount: Number(e.currentTarget.value) })} />
          </Field>
        </Stack>
        <Field label="Rate">
          <Input type="number" value={form.rate} onChange={(e) => setForm({ ...form, rate: Number(e.currentTarget.value) })} />
        </Field>
        <Field label="Event time (UTC)">
          <Input type="datetime-local" value={tsValue} onChange={(e) => onChangeTs(e.currentTarget.value)} />
        </Field>
      </>
    );
  }
  // transfer_in
  return (
    <>
      <Field label="Instrument ID" required>
        <Input value={form.instrument_id} onChange={(e) => setForm({ ...form, instrument_id: e.currentTarget.value })} />
      </Field>
      <Stack direction="row" gap={1}>
        <Field label="Quantity">
          <Input type="number" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: Number(e.currentTarget.value) })} />
        </Field>
        <Field label="Cost basis (native)">
          <Input type="number" value={form.cost_basis_native} onChange={(e) => setForm({ ...form, cost_basis_native: Number(e.currentTarget.value) })} />
        </Field>
        <Field label="Currency">
          <Input width={10} value={form.currency} onChange={(e) => setForm({ ...form, currency: e.currentTarget.value.toUpperCase() })} />
        </Field>
      </Stack>
      <Stack direction="row" gap={1}>
        <Field label="Acquisition date (UTC)">
          <Input
            type="datetime-local"
            value={new Date(form.acquisition_date / 1000).toISOString().slice(0, 16)}
            onChange={(e) => {
              const ms = Date.parse(e.currentTarget.value);
              if (Number.isFinite(ms)) setForm({ ...form, acquisition_date: ms * 1000 });
            }}
          />
        </Field>
        <Field label="FX at acquisition">
          <Input type="number" value={form.fx_rate_at_acquisition} onChange={(e) => setForm({ ...form, fx_rate_at_acquisition: Number(e.currentTarget.value) })} />
        </Field>
      </Stack>
      <Field label="Lot ID (auto if empty)">
        <Input value={form.lot_id} onChange={(e) => setForm({ ...form, lot_id: e.currentTarget.value })} />
      </Field>
      <Field label="Event time (UTC)">
        <Input type="datetime-local" value={tsValue} onChange={(e) => onChangeTs(e.currentTarget.value)} />
      </Field>
    </>
  );
}
