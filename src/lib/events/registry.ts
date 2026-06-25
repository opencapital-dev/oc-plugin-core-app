import { DEFAULT_UPDATED_BY } from '../attributes';
import { datetimeLocalToMicros, microsToDatetimeLocalValue, parseOptionalNumber } from '../time';
import type { EventInput, EventRow, EventType } from './types';

export type FieldSpec = {
  name: string;
  label: string;
  kind: 'text' | 'number' | 'select' | 'currency' | 'instrument';
  required?: boolean;
  options?: Array<{ label: string; value: string }>;
};

export type EventSummary = { instrument: string; side: string; amount: string; currency: string };
export type EventForm = Record<string, string>;

export type EventTypeDef = {
  type: EventType;
  label: string;
  family: 'trade' | 'income' | 'cash' | 'transfer' | 'option';
  icon: string;
  fields: FieldSpec[];
  summary(row: EventRow): EventSummary;
  toInput(form: EventForm, portfolioId: string): EventInput;
  fromRow(row: EventRow): EventForm;
};

export function fmtNum(v: unknown): string {
  if (v === null || v === undefined || v === '') {
    return '';
  }
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 6 }) : String(v);
}

const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const num = (form: EventForm, key: string): number => Number(form[key] ?? 0);
const optNum = (form: EventForm, key: string): number | undefined => parseOptionalNumber(form[key] ?? '');

// Shared base: every input carries portfolio, updated_by, optional source_id (edit)
// and optional event_ts (from the datetime-local field named `event_ts`).
function base(form: EventForm, portfolioId: string, type: EventType): EventInput {
  const input: EventInput = {
    event_type: type,
    portfolio_id: portfolioId,
    updated_by: DEFAULT_UPDATED_BY,
  };
  if (form.source_id) {
    input.source_id = form.source_id;
  }
  if (form.event_ts && form.event_ts.trim()) {
    input.event_ts = datetimeLocalToMicros(form.event_ts);
  }
  return input;
}

function baseForm(row: EventRow): EventForm {
  return {
    source_id: row.source_id,
    event_ts: microsToDatetimeLocalValue(row.business_ts),
  };
}

const CCY: FieldSpec = { name: 'currency', label: 'Currency', kind: 'currency', required: true };
const INSTR: FieldSpec = { name: 'instrument_id', label: 'Instrument', kind: 'instrument', required: true };
const WHEN: FieldSpec = { name: 'event_ts', label: 'When', kind: 'text' };

export const EVENT_REGISTRY: Record<EventType, EventTypeDef> = {
  TRADE: {
    type: 'TRADE',
    label: 'Trade',
    family: 'trade',
    icon: 'exchange-alt',
    fields: [
      WHEN, INSTR,
      { name: 'side', label: 'Side', kind: 'select', required: true, options: [
        { label: 'Buy', value: 'buy' }, { label: 'Sell', value: 'sell' }] },
      { name: 'quantity', label: 'Quantity', kind: 'number', required: true },
      { name: 'price', label: 'Price', kind: 'number', required: true },
      CCY,
      { name: 'venue', label: 'Venue', kind: 'text' },
      { name: 'commission', label: 'Commission', kind: 'number' },
      { name: 'fees', label: 'Fees', kind: 'number' },
      { name: 'fx_rate_to_base', label: 'FX rate to base', kind: 'number' },
    ],
    summary: (row) => ({
      instrument: s(row.instrument_id) || '—',
      side: s(row.payload.side) || '—',
      amount: `${fmtNum(row.payload.quantity)} @ ${fmtNum(row.payload.price)}`,
      currency: s(row.payload.currency),
    }),
    fromRow: (row) => ({
      ...baseForm(row),
      instrument_id: s(row.instrument_id),
      side: s(row.payload.side),
      quantity: s(row.payload.quantity),
      price: s(row.payload.price),
      currency: s(row.payload.currency),
      venue: s(row.payload.venue),
      commission: s(row.payload.commission),
      fees: s(row.payload.fees),
      fx_rate_to_base: s(row.payload.fx_rate_to_base),
    }),
    toInput: (form, pf) => ({
      ...base(form, pf, 'TRADE'),
      instrument_id: form.instrument_id,
      side: form.side,
      quantity: num(form, 'quantity'),
      price: num(form, 'price'),
      currency: form.currency.toUpperCase(),
      venue: form.venue || 'manual',
      commission: optNum(form, 'commission'),
      fees: optNum(form, 'fees'),
      fx_rate_to_base: optNum(form, 'fx_rate_to_base'),
    }),
  },

  DIVIDEND: {
    type: 'DIVIDEND',
    label: 'Dividend',
    family: 'income',
    icon: 'money-bill',
    fields: [
      WHEN, INSTR,
      { name: 'gross_native', label: 'Gross', kind: 'number', required: true },
      { name: 'withholding_native', label: 'Withholding', kind: 'number' },
      CCY,
    ],
    summary: (row) => ({
      instrument: s(row.instrument_id) || '—',
      side: '—',
      amount: fmtNum(row.payload.gross_native),
      currency: s(row.payload.currency),
    }),
    fromRow: (row) => ({
      ...baseForm(row),
      instrument_id: s(row.instrument_id),
      gross_native: s(row.payload.gross_native),
      withholding_native: s(row.payload.withholding_native),
      currency: s(row.payload.currency),
    }),
    toInput: (form, pf) => ({
      ...base(form, pf, 'DIVIDEND'),
      instrument_id: form.instrument_id,
      gross_native: num(form, 'gross_native'),
      withholding_native: optNum(form, 'withholding_native'),
      currency: form.currency.toUpperCase(),
    }),
  },

  CASHFLOW: {
    type: 'CASHFLOW',
    label: 'Cashflow',
    family: 'cash',
    icon: 'university',
    fields: [
      WHEN,
      { name: 'type', label: 'Type', kind: 'select', required: true, options: [
        { label: 'Deposit', value: 'DEPOSIT' },
        { label: 'Withdrawal', value: 'WITHDRAWAL' },
        { label: 'Interest on cash', value: 'INTEREST_ON_CASH' },
        { label: 'Fee', value: 'FEE' }] },
      { name: 'amount_native', label: 'Amount', kind: 'number', required: true },
      CCY,
    ],
    summary: (row) => ({
      instrument: '—',
      side: '—',
      amount: fmtNum(row.payload.amount_native),
      currency: s(row.payload.currency),
    }),
    fromRow: (row) => ({
      ...baseForm(row),
      type: s(row.payload.type),
      amount_native: s(row.payload.amount_native),
      currency: s(row.payload.currency),
    }),
    toInput: (form, pf) => ({
      ...base(form, pf, 'CASHFLOW'),
      type: form.type,
      amount_native: num(form, 'amount_native'),
      currency: form.currency.toUpperCase(),
    }),
  },

  FX_CONVERSION: {
    type: 'FX_CONVERSION',
    label: 'FX Conversion',
    family: 'trade',
    icon: 'sync',
    fields: [
      WHEN,
      { name: 'from_currency', label: 'From currency', kind: 'currency', required: true },
      { name: 'from_amount', label: 'From amount', kind: 'number', required: true },
      { name: 'to_currency', label: 'To currency', kind: 'currency', required: true },
      { name: 'to_amount', label: 'To amount', kind: 'number', required: true },
      { name: 'rate', label: 'Rate', kind: 'number', required: true },
    ],
    summary: (row) => ({
      instrument: '—',
      side: '—',
      amount: `${fmtNum(row.payload.from_amount)} ${s(row.payload.from_currency)} → ${fmtNum(row.payload.to_amount)} ${s(row.payload.to_currency)}`,
      currency: s(row.payload.to_currency),
    }),
    fromRow: (row) => ({
      ...baseForm(row),
      from_currency: s(row.payload.from_currency),
      from_amount: s(row.payload.from_amount),
      to_currency: s(row.payload.to_currency),
      to_amount: s(row.payload.to_amount),
      rate: s(row.payload.rate),
    }),
    toInput: (form, pf) => ({
      ...base(form, pf, 'FX_CONVERSION'),
      from_currency: form.from_currency.toUpperCase(),
      from_amount: num(form, 'from_amount'),
      to_currency: form.to_currency.toUpperCase(),
      to_amount: num(form, 'to_amount'),
      rate: num(form, 'rate'),
    }),
  },

  TRANSFER_IN: {
    type: 'TRANSFER_IN',
    label: 'Transfer In',
    family: 'transfer',
    icon: 'import',
    fields: [
      WHEN, INSTR,
      { name: 'quantity', label: 'Quantity', kind: 'number', required: true },
      { name: 'cost_basis_native', label: 'Cost basis', kind: 'number', required: true },
      CCY,
      { name: 'fx_rate_at_acquisition', label: 'FX rate at acquisition', kind: 'number', required: true },
    ],
    summary: (row) => ({
      instrument: s(row.instrument_id) || '—',
      side: '—',
      amount: `${fmtNum(row.payload.quantity)} sh`,
      currency: s(row.payload.currency),
    }),
    fromRow: (row) => ({
      ...baseForm(row),
      instrument_id: s(row.instrument_id),
      quantity: s(row.payload.quantity),
      cost_basis_native: s(row.payload.cost_basis_native),
      currency: s(row.payload.currency),
      fx_rate_at_acquisition: s(row.payload.fx_rate_at_acquisition),
    }),
    toInput: (form, pf) => {
      const input = base(form, pf, 'TRANSFER_IN');
      // TRANSFER_IN business_ts = acquisition_date; reuse event_ts (edit) or now.
      const acq = input.event_ts ?? Date.now() * 1000;
      return {
        ...input,
        // source_id, if present, is the lot_id — pass it through so the backend upserts.
        lot_id: form.source_id || undefined,
        instrument_id: form.instrument_id,
        quantity: num(form, 'quantity'),
        cost_basis_native: num(form, 'cost_basis_native'),
        currency: form.currency.toUpperCase(),
        acquisition_date: acq,
        fx_rate_at_acquisition: num(form, 'fx_rate_at_acquisition'),
      };
    },
  },

  OPTION_EXERCISE: optionDeliveryDef('OPTION_EXERCISE', 'Option Exercise', 'exercise_id'),
  OPTION_ASSIGNMENT: optionDeliveryDef('OPTION_ASSIGNMENT', 'Option Assignment', 'assignment_id'),

  OPTION_EXPIRY: {
    type: 'OPTION_EXPIRY',
    label: 'Option Expiry',
    family: 'option',
    icon: 'clock-nine',
    fields: [WHEN, INSTR, CCY],
    summary: (row) => ({
      instrument: s(row.instrument_id) || '—',
      side: '—',
      amount: 'expired',
      currency: s(row.payload.currency),
    }),
    fromRow: (row) => ({
      ...baseForm(row),
      instrument_id: s(row.instrument_id),
      currency: s(row.payload.currency),
    }),
    toInput: (form, pf) => ({
      ...base(form, pf, 'OPTION_EXPIRY'),
      expiry_id: form.source_id || undefined,
      instrument_id: form.instrument_id,
      currency: form.currency.toUpperCase(),
    }),
  },
};

function optionDeliveryDef(type: EventType, label: string, idField: string): EventTypeDef {
  return {
    type,
    label,
    family: 'option',
    icon: 'arrow-right',
    fields: [
      WHEN, INSTR,
      { name: 'underlying_id', label: 'Underlying', kind: 'instrument', required: true },
      { name: 'settlement_price', label: 'Settlement price', kind: 'number', required: true },
      { name: 'delivered_qty', label: 'Delivered qty', kind: 'number', required: true },
      { name: 'delivered_side', label: 'Delivered side', kind: 'select', required: true, options: [
        { label: 'Buy', value: 'buy' }, { label: 'Sell', value: 'sell' }] },
      CCY,
    ],
    summary: (row) => ({
      instrument: s(row.instrument_id) || '—',
      side: s(row.payload.delivered_side) || '—',
      amount: fmtNum(row.payload.delivered_qty),
      currency: s(row.payload.currency),
    }),
    fromRow: (row) => ({
      ...baseForm(row),
      instrument_id: s(row.instrument_id),
      underlying_id: s(row.payload.underlying_id),
      settlement_price: s(row.payload.settlement_price),
      delivered_qty: s(row.payload.delivered_qty),
      delivered_side: s(row.payload.delivered_side),
      currency: s(row.payload.currency),
    }),
    toInput: (form, pf) => ({
      ...base(form, pf, type),
      [idField]: form.source_id || undefined,
      instrument_id: form.instrument_id,
      underlying_id: form.underlying_id,
      settlement_price: num(form, 'settlement_price'),
      delivered_qty: num(form, 'delivered_qty'),
      delivered_side: form.delivered_side,
      currency: form.currency.toUpperCase(),
    }),
  };
}

export const EVENT_TYPES_IN_ORDER: EventType[] = [
  'TRADE', 'FX_CONVERSION', 'DIVIDEND', 'CASHFLOW', 'TRANSFER_IN',
  'OPTION_EXERCISE', 'OPTION_ASSIGNMENT', 'OPTION_EXPIRY',
];
