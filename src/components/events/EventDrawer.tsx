import React, { useEffect, useMemo, useState } from 'react';
import { css } from '@emotion/css';
import { type GrafanaTheme2, type SelectableValue } from '@grafana/data';
import { Button, Drawer, Field, Input, Select, Stack, useStyles2 } from '@grafana/ui';

import { formatEventMicros } from '../../lib/time';
import { EVENT_REGISTRY, EVENT_TYPES_IN_ORDER, type EventForm, type FieldSpec } from '../../lib/events/registry';
import type { EventInput, EventRow, EventType } from '../../lib/events/types';

export type DrawerState =
  | { mode: 'create'; type: EventType }
  | { mode: 'edit'; type: EventType; row: EventRow }
  | { mode: 'detail'; type: EventType; row: EventRow };

type Props = {
  state: DrawerState;
  portfolioId: string;
  onClose: () => void;
  onSubmit: (input: EventInput) => void;
  onEdit: (row: EventRow) => void;
  onDelete: (row: EventRow) => void;
};

export function EventDrawer({ state, portfolioId, onClose, onSubmit, onEdit, onDelete }: Props) {
  const styles = useStyles2(getStyles);
  const [type, setType] = useState<EventType>(state.type);
  const def = EVENT_REGISTRY[type];

  const initialForm = useMemo<EventForm>(() => {
    if (state.mode === 'create') {
      return {};
    }
    return EVENT_REGISTRY[state.type].fromRow(state.row);
  }, [state]);

  const [form, setForm] = useState<EventForm>(initialForm);

  useEffect(() => {
    setType(state.type);
    setForm(state.mode === 'create' ? {} : EVENT_REGISTRY[state.type].fromRow(state.row));
  }, [state]);

  const set = (name: string, value: string) => setForm((f) => ({ ...f, [name]: value }));

  const title =
    state.mode === 'detail'
      ? `${def.label}${state.row.instrument_id ? ` · ${state.row.instrument_id}` : ''}`
      : state.mode === 'edit'
        ? `Edit ${def.label.toLowerCase()}`
        : 'Add event';

  if (state.mode === 'detail') {
    const detailForm = def.fromRow(state.row);
    return (
      <Drawer title={title} onClose={onClose} size="md">
        <div className={styles.grid}>
          <div className={styles.cellKey}>Time</div>
          <div className={styles.cellVal}>{formatEventMicros(state.row.business_ts)}</div>
          {def.fields
            .filter((f) => f.name !== 'event_ts')
            .map((f) => (
              <React.Fragment key={f.name}>
                <div className={styles.cellKey}>{f.label}</div>
                <div className={styles.cellVal}>{detailForm[f.name] || '—'}</div>
              </React.Fragment>
            ))}
        </div>
        <Stack direction="row" gap={1}>
          <Button icon="edit" onClick={() => onEdit(state.row)}>Edit</Button>
          <Button variant="destructive" icon="trash-alt" onClick={() => onDelete(state.row)}>Delete</Button>
        </Stack>
      </Drawer>
    );
  }

  const submit = () => {
    onSubmit(def.toInput(form, portfolioId));
  };

  return (
    <Drawer title={title} onClose={onClose} size="md">
      {state.mode === 'create' && (
        <Field label="Event type">
          <Select
            options={EVENT_TYPES_IN_ORDER.map((t) => ({ label: EVENT_REGISTRY[t].label, value: t }))}
            value={type}
            onChange={(opt: SelectableValue<EventType>) => {
              if (opt?.value) {
                setType(opt.value);
                setForm({});
              }
            }}
          />
        </Field>
      )}

      {def.fields.map((f) => (
        <FieldInput key={f.name} spec={f} value={form[f.name] ?? ''} onChange={(v) => set(f.name, v)} />
      ))}

      <Stack direction="row" gap={1}>
        <Button onClick={submit}>{state.mode === 'edit' ? 'Save changes' : 'Create event'}</Button>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
      </Stack>
    </Drawer>
  );
}

function FieldInput({ spec, value, onChange }: { spec: FieldSpec; value: string; onChange: (v: string) => void }) {
  if (spec.kind === 'select') {
    return (
      <Field label={spec.label}>
        <Select
          options={spec.options ?? []}
          value={value}
          onChange={(opt: SelectableValue<string>) => onChange(opt?.value ?? '')}
        />
      </Field>
    );
  }
  const placeholder =
    spec.name === 'event_ts' ? 'e.g. 2026-05-19 13:20 (blank = now)' : spec.kind === 'currency' ? 'USD' : undefined;
  return (
    <Field label={spec.label}>
      <Input
        type={spec.kind === 'number' ? 'number' : 'text'}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.currentTarget.value)}
      />
    </Field>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  grid: css({
    display: 'grid',
    gridTemplateColumns: 'minmax(120px, max-content) 1fr',
    gap: theme.spacing(1, 2),
    marginBottom: theme.spacing(3),
  }),
  cellKey: css({ color: theme.colors.text.secondary, fontSize: theme.typography.bodySmall.fontSize }),
  cellVal: css({ fontFamily: theme.typography.fontFamilyMonospace, wordBreak: 'break-word' }),
});
