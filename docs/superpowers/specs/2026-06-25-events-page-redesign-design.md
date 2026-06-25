# Events page redesign + read-path fix — design

Date: 2026-06-25
Repo: `oc-plugin-core-app` (Grafana app plugin: Go backend + React frontend)

## Problem

The Events page renders empty (every tab shows 0) for a portfolio that has data. Beyond the
empty page, the page has structural issues: tabs per event type, restrictive trade columns,
options that never appear, a redundant "review instruments" import step with no event review,
and raw portfolio UUIDs shown in the UI.

### Root cause of the empty page

The backend has **no read path for events**. In `pkg/plugin`, every event route is POST (create)
or DELETE only:

- `registerRefRoutes` (`handlers_ref.go`) reads only `portfolios` and `instruments`.
- `/ref/trades`, `/ref/dividends`, `/ref/cashflows`, `/ref/fx-conversions`, `/ref/transfer-ins`
  are all **POST-only** (`dispatchTradesRoot` rejects non-POST, etc.).

The frontend `listTrades()/listDividends()/…` (`src/api/reference.ts`) issue `GET /ref/<type>?portfolio_id=…`,
which hit POST-only handlers → 405 → caught → the page shows 0. The data exists; nothing fetches it.

### Data confirmed in RisingWave (portfolio `demo · GBP`, `74691756-…`)

`events` materialized view holds **575 events**: 397 TRADE, 161 CASHFLOW, 15 DIVIDEND, 2 TRANSFER_IN,
0 FX_CONVERSION. A single query returns them mixed, newest-first:

```sql
SELECT source_id, event_type, instrument_id, business_ts, payload, enriched
FROM events WHERE portfolio_id = $1 ORDER BY business_ts DESC;
```

### Fields available per type (today, from real payloads + `enriched`)

The current trade table shows only When/Instrument/Side/Qty/Price/CCY; the rest is discarded.

| Type | Fields present in `payload` |
|---|---|
| TRADE | side, price, quantity, currency, venue, commission, fees, fx_rate_to_base, fx_fees_native, fx_fees_currency, instrument_kind, contract_multiplier |
| DIVIDEND | gross_native, withholding_native, currency, fx_rate_to_base, fx_fees_native, fx_fees_currency |
| CASHFLOW | type (DEPOSIT/WITHDRAWAL/INTEREST_ON_CASH/FEE), amount_native, currency |
| TRANSFER_IN | quantity, cost_basis_native, currency, acquisition_date, fx_rate_at_acquisition, fx_rate_to_base, transfer_id |
| FX_CONVERSION | from_currency, from_amount, to_currency, to_amount, rate |

Common envelope columns (all types): `source_id`, `event_type`, `portfolio_id`, `instrument_id`,
`business_ts`. `enriched` additionally carries `base_currency` and `event_time_fx`.

## Goals

1. The Events page renders all events for the selected portfolio.
2. One searchable, sortable table instead of tabs; FX Conversion lives in the Trade family.
3. Expand visible information: summary columns + a detail drawer exposing every field.
4. Options appear (option trades and `OPTION_*` lifecycle events).
5. "Add trade" → "Add event": a type dropdown drawer that renders fields per selected type.
6. One create/edit/import code path (no duplicated persistence logic).
7. Import drops the "review instruments" step and gains an "event review" step reusing the
   same table + drawer, populated from the parsed CSV.
8. Portfolio names everywhere; never a raw UUID in headers, labels, or dropdowns.

## Non-goals

- No change to the RisingWave schema or downstream MVs.
- No change to broker parsers (`lib/import/t212`, `lib/import/ibkr`) beyond mapping their output
  into the shared event model.
- No new analytics/positions views.

## Data-model rethink (direct RisingWave, no Kafka)

`portfolio_events_log` is a regular RisingWave **table**, PK = `rw_key = plugin_id|source_id`.
Its own DDL comment states the contract: *"An INSERT with an existing rw_key overwrites
(RW native upsert-on-PK); a DELETE by rw_key retracts through every downstream MV."*

The old append-only/Kafka-tombstone constraint and the trade-"correction" path are obsolete.
Three primitives, each a single atomic statement:

| Action | Operation |
|---|---|
| Add | INSERT with a fresh `source_id` (new `rw_key`) |
| Edit | INSERT with the **same** `source_id` → upsert-on-PK overwrites payload / business_ts / instrument |
| Delete | DELETE by `rw_key` → tombstone retracts through all MVs |

Edit is therefore atomic (no delete+recreate race). Create, edit, and bulk import all share one
write primitive.

## Backend changes (`pkg/plugin`)

### B1. New read endpoint — `GET /ref/events?portfolio_id=…`

Wire in `registerEventRoutes` (`handlers_events.go`). Returns a unified `EventRow[]`:

```go
type EventRow struct {
    SourceID     string         `json:"source_id"`
    EventType    string         `json:"event_type"`
    InstrumentID *string        `json:"instrument_id"`
    BusinessTs   int64          `json:"business_ts"` // epoch micros
    Payload      map[string]any `json:"payload"`
}
```

Query the `events` MV; convert `business_ts` to epoch micros in SQL
(`(extract(epoch FROM business_ts)*1e6)::bigint`); decode `payload` jsonb into a map (mirror the
attrs decode in `handleListPortfolios`). Require `portfolio_id`; scope every read to it.

### B2. Unified write endpoint — `POST /ref/events` and `POST /ref/events/bulk`

Body: `{event_type, source_id?, portfolio_id, business_ts?, instrument_id?, …typed fields}`.
A dispatcher maps `event_type` to the **existing** per-type payload builders
(`handlers_trades.go` / `_dividends` / `_cashflows` / `_fx_conversions` / `_transfer_ins` /
`_options`), then calls the existing upserting `insertEvent` (`events_common.go`). Omit
`source_id` = create (generate one); pass it = edit (same `rw_key` → overwrite). `bulk` accepts a
mixed-type array and loops the same dispatcher — this is the single path the importer uses.

Keep `DELETE /ref/events/{source_id}` (`handlers_events.go`) as-is. The per-type POST builders stay
(reused internally); the frontend stops calling the per-type `/ref/<type>` routes directly.

### B3. Retire

- Trade "correction" route/path (`handleTradeCorrection`, `/ref/trades/{id}/corrections`) — an edit
  is now an upsert through `POST /ref/events`.
- Frontend per-type create/list/bulk functions (replaced by the unified endpoints).

## Frontend changes (`src/`)

### F1. Keystone — event type registry

New `src/lib/events/registry.ts` + `src/lib/events/types.ts`. One entry per event type
(`trade`, `fx_conversion`, `dividend`, `cashflow`, `transfer_in`, `option_exercise`,
`option_assignment`, `option_expiry`, `option_mark`), each exposing:

```ts
interface EventTypeDef {
  type: EventType;
  label: string;            // "Trade", "FX Conversion", …
  family: 'trade' | 'income' | 'cash' | 'transfer' | 'option';
  icon: IconName;
  summaryCells(row: EventRow): { side?: string; instrument?: string; amount: string; ccy: string };
  formFields: FieldSpec[];                 // drives the drawer form
  toPayload(form: EventForm): EventWrite;  // form → POST /ref/events body
  fromPayload(row: EventRow): EventForm;   // row  → editable form
}
```

This single registry drives all four surfaces: table columns, detail drawer, Add/Edit form, and
import preview. FX Conversion has `family: 'trade'`.

`EventRow` is the unified read shape (`{source_id, event_type, business_ts, instrument_id, payload}`).
`EventWrite` is the unified write shape.

### F2. API layer (`src/api/reference.ts`)

- `listEvents(portfolioId): EventRow[]` → `GET /ref/events?portfolio_id=…`.
- `writeEvent(body: EventWrite): EventRow` → `POST /ref/events`.
- `writeEventsBulk(bodies: EventWrite[])` → `POST /ref/events/bulk`.
- `deleteEvent(sourceId, portfolioId)` → existing DELETE.
- Remove the per-type `submit*` / `list*` / `*Bulk` functions and the trade-correction function.

### F3. Single table (`src/components/events/EventsTable.tsx`, rewrites `EventsPage.tsx`)

- Columns (universal summary via registry): **Time · Type · Instrument · Side · Amount · CCY**.
- Client-side **search** (instrument, type label, currency, side, amount text), **sort**
  (default `business_ts` desc; sortable headers), **type-family filter** chips.
- Row click → detail drawer. Instruments shown by symbol; no portfolio UUID anywhere.
- Header `Events · {portfolioName} · {baseCurrency}`; primary button **Add event**.
- Empty state copy stays but now only shows when the portfolio genuinely has no events.

### F4. Add / Edit / detail drawer (`src/components/events/EventDrawer.tsx`)

One drawer component, three modes:

- **detail** — read-only field grid from `fromPayload`, with Edit and Delete.
- **edit** — same fields editable; submit upserts with the row's `source_id`.
- **add** — a type dropdown at top (all registry types); selecting a type renders its `formFields`.

Submit → `toPayload()` → `writeEvent()`. Identical path the importer uses.

### F5. Import: drop "review instruments", add "review events" (`src/pages/ImportPage.tsx`)

- Remove the instrument-mapping (`map`) step.
- After parse, map broker output (`BrokerImportResult`) → `EventRow[]` via the registry and render
  the **same `EventsTable` + drawer**, sourced from the CSV (not RisingWave). The user inspects,
  edits, or deletes any row before commit.
- Fold the transfer_in lot breakdown (`LotsStep`) into the event-review drawer for transfer_in rows,
  rather than a separate wizard step.
- Confirm → `writeEventsBulk()` (the same write primitive). Keep the cash-balance simulation summary.

### F6. Portfolio names, never IDs (`src/contexts/PortfolioContext.tsx`, `PortfolioSelector.tsx`)

- `PortfolioContext` exposes the selected portfolio **object** `{ id, name, base_currency }`, not a
  bare id string (keep id internally for queries).
- `PortfolioSelector` and all labels render `name · base_currency`; drop the
  `portfolio_id.slice(0,8)` fallback — if a name is missing, show base currency only, never a UUID.
- Fix `EventsPage` header (`Events · {selected}` → name) and audit the codebase for any other id
  leak into UI text or dropdowns.

## Testing

- **Go**: unit-test `GET /ref/events` row mapping (payload decode, business_ts → micros); unified
  write dispatch per type; a same-`source_id` upsert test proving edit overwrites; all via the
  existing `fakeExecer` seam (`events_common_test.go`).
- **TS**: registry round-trip (`fromPayload`→`toPayload` stable per type), reused by both manual and
  import paths; table search/sort/filter; import mapping (`BrokerImportResult` → `EventRow[]`).

## Build sequence (each step independently verifiable)

1. Backend `GET /ref/events` + frontend `listEvents` + minimal table → **page renders**.
2. Backend unified write/upsert + delete; frontend `writeEvent`.
3. Event registry + full single table (search/sort/filter) + detail drawer.
4. Add/Edit drawer with type dropdown (all types).
5. Import event-review step reusing table + drawer; bulk write.
6. Portfolio-name context/selector cleanup + id-leak audit.

## Open risks

- `events` MV `payload` decoding in Go must handle jsonb as `map[string]any` / `[]byte` / string
  (same three-way switch already used for portfolio attributes).
- Option lifecycle events were previously import-only; exposing them as user-addable means the
  registry must define complete `formFields` for `OPTION_*` types.
