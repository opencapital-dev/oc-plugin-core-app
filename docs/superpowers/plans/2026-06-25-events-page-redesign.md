# Events Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the empty Events page and replace per-type tabs with one searchable/sortable event table, an Add-Event drawer, and an import event-review step — all driven by a single event-type registry and one direct-RisingWave read/write path.

**Architecture:** The backend gains a unified read (`GET /ref/events`, querying the `events` MV) and a unified write (`POST /ref/events` + `/ref/events/bulk`, dispatching to the existing per-type payload builders and upserting on `rw_key = plugin_id|source_id`). The frontend collapses to one `EventRow` model, one `eventTypeRegistry` that drives the table columns, detail drawer, Add/Edit form, and import preview, and one write path shared by manual entry and CSV import. Add = INSERT new `source_id`; Edit = INSERT same `source_id` (atomic upsert); Delete = existing tombstone.

**Tech Stack:** Go (Grafana plugin backend, `pgx` via `pluginclient`), React + TypeScript + `@grafana/ui`, Jest, `go test`. Build: `mage` (backend), `npm run build` (frontend).

## Global Constraints

- Module path: `github.com/opencapital-dev/oc-plugin-core-app`; backend package `plugin` under `pkg/plugin`.
- RisingWave reads use `a.client.Query(ctx, sql, args...)`; writes use the existing `a.insertEvent(...)` upsert helper. Never add a Kafka/gateway path.
- `events` MV columns: `source_id, portfolio_id, instrument_id, event_type, business_ts (timestamptz), payload (jsonb), enriched (jsonb)`.
- `portfolio_events_log` PK is `rw_key`; re-INSERT with the same `source_id` overwrites; DELETE by `rw_key` tombstones. Edit MUST reuse the row's `source_id`.
- `business_ts` is epoch **microseconds** across the wire (frontend `formatEventMicros` divides by 1000).
- `DEFAULT_UPDATED_BY = 'grafana-portal'` (`src/lib/attributes.ts`).
- Event types that live in `portfolio_events_log` and therefore appear in the table: `TRADE, DIVIDEND, CASHFLOW, FX_CONVERSION, TRANSFER_IN, OPTION_EXERCISE, OPTION_ASSIGNMENT, OPTION_EXPIRY`. **`OPTION_MARK` is excluded** — it writes to `data_log` (a non-portfolio price), so it never appears in `events` and is not an "event" surface.
- Never render a portfolio UUID in UI text or dropdowns — show `name · base_currency`.
- Frontend commands: `npm run test:ci`, `npm run typecheck`, `npm run lint`. Backend: `go test ./pkg/plugin/...`, `mage -v`.
- Work happens in the worktree `oc-plugin-core-app/.worktrees/events-page-redesign` on branch `feat/events-page-redesign`. Paths below are repo-relative.

---

### Task 1: Backend — unified events read (`GET /ref/events`)

**Files:**
- Create: `pkg/plugin/handlers_events_read.go`
- Create: `pkg/plugin/handlers_events_read_test.go`
- Modify: `pkg/plugin/handlers_events.go:5-7` (add the read route to `registerEventRoutes`)

**Interfaces:**
- Consumes: `a.client.Query(ctx, sql, args...) (pluginclient.Result, error)`; `pluginclient.Result{Columns []Column; Rows [][]any}`; helpers `respondErr`, `respondJSON`, `a.handlerCtx`.
- Produces: `type EventRow struct{ SourceID string; EventType string; InstrumentID *string; BusinessTs int64; Payload map[string]any }` (JSON: `source_id, event_type, instrument_id, business_ts, payload`); pure func `mapEventRows(res pluginclient.Result) ([]EventRow, error)`; handler `a.handleListEvents`.

- [ ] **Step 1: Write the failing test for `mapEventRows`**

Create `pkg/plugin/handlers_events_read_test.go`:

```go
package plugin

import (
	"testing"

	"github.com/opencapital-dev/oc-plugin-sdk/pluginclient"
)

func strptr(s string) *string { return &s }

func TestMapEventRows(t *testing.T) {
	res := pluginclient.Result{
		Columns: []pluginclient.Column{
			{Name: "source_id"}, {Name: "event_type"}, {Name: "instrument_id"},
			{Name: "business_ts"}, {Name: "payload"},
		},
		Rows: [][]any{
			{"src-1", "TRADE", "AMRZ", int64(1752756415000000),
				`{"side":"buy","price":50.228,"quantity":35,"currency":"USD","venue":"XLON"}`},
			{"src-2", "CASHFLOW", nil, int64(1767921037000000),
				`{"type":"INTEREST_ON_CASH","amount_native":0.25,"currency":"GBP"}`},
		},
	}

	rows, err := mapEventRows(res)
	if err != nil {
		t.Fatalf("mapEventRows: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("want 2 rows, got %d", len(rows))
	}
	if rows[0].SourceID != "src-1" || rows[0].EventType != "TRADE" {
		t.Fatalf("row0 header wrong: %+v", rows[0])
	}
	if rows[0].InstrumentID == nil || *rows[0].InstrumentID != "AMRZ" {
		t.Fatalf("row0 instrument wrong: %+v", rows[0].InstrumentID)
	}
	if rows[0].BusinessTs != 1752756415000000 {
		t.Fatalf("row0 ts wrong: %d", rows[0].BusinessTs)
	}
	if rows[0].Payload["side"] != "buy" {
		t.Fatalf("row0 payload not decoded: %+v", rows[0].Payload)
	}
	if rows[1].InstrumentID != nil {
		t.Fatalf("row1 instrument should be nil, got %+v", rows[1].InstrumentID)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/ignacioballester/trading-code/oc-plugin-core-app/.worktrees/events-page-redesign && go test ./pkg/plugin/ -run TestMapEventRows -v`
Expected: FAIL — `undefined: mapEventRows`.

- [ ] **Step 3: Implement the read handler + mapper**

Create `pkg/plugin/handlers_events_read.go`:

```go
package plugin

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/opencapital-dev/oc-plugin-sdk/pluginclient"
)

// EventRow is the unified read shape for one portfolio event, sourced from the
// `events` materialized view. Payload carries the type-specific fields; the
// frontend registry decides how to render them.
type EventRow struct {
	SourceID     string         `json:"source_id"`
	EventType    string         `json:"event_type"`
	InstrumentID *string        `json:"instrument_id"`
	BusinessTs   int64          `json:"business_ts"` // epoch micros
	Payload      map[string]any `json:"payload"`
}

// listEventsSQL reads every event for one portfolio, newest first. business_ts
// is converted to epoch micros and payload is cast to text so it decodes
// deterministically as a JSON string (pgx jsonb-via-Values is ambiguous).
const listEventsSQL = `
SELECT source_id,
       event_type,
       instrument_id,
       (extract(epoch FROM business_ts) * 1000000)::bigint AS business_ts,
       payload::text AS payload
  FROM events
 WHERE portfolio_id = $1
 ORDER BY business_ts DESC`

func (a *App) handleListEvents(w http.ResponseWriter, r *http.Request) {
	portfolioID := r.URL.Query().Get("portfolio_id")
	if portfolioID == "" {
		respondErr(w, http.StatusBadRequest, "portfolio_id query param required")
		return
	}
	ctx, ok := a.handlerCtx(w, r)
	if !ok {
		return
	}
	res, err := a.client.Query(ctx, listEventsSQL, portfolioID)
	if err != nil {
		respondErr(w, http.StatusBadGateway, "list events: "+err.Error())
		return
	}
	rows, err := mapEventRows(res)
	if err != nil {
		respondErr(w, http.StatusInternalServerError, "decode events: "+err.Error())
		return
	}
	respondJSON(w, http.StatusOK, rows)
}

// mapEventRows converts the neutral pgwire Result into typed EventRows.
// Column order must match listEventsSQL.
func mapEventRows(res pluginclient.Result) ([]EventRow, error) {
	out := make([]EventRow, 0, len(res.Rows))
	for _, row := range res.Rows {
		if len(row) < 5 {
			continue
		}
		sourceID, _ := row[0].(string)
		eventType, _ := row[1].(string)

		var instrumentID *string
		if s, ok := row[2].(string); ok && s != "" {
			instrumentID = &s
		}

		var businessTs int64
		switch v := row[3].(type) {
		case int64:
			businessTs = v
		case int32:
			businessTs = int64(v)
		case float64:
			businessTs = int64(v)
		}

		payload := map[string]any{}
		switch v := row[4].(type) {
		case string:
			if v != "" {
				if err := json.Unmarshal([]byte(v), &payload); err != nil {
					return nil, fmt.Errorf("source_id %s: %w", sourceID, err)
				}
			}
		case []byte:
			if len(v) > 0 {
				if err := json.Unmarshal(v, &payload); err != nil {
					return nil, fmt.Errorf("source_id %s: %w", sourceID, err)
				}
			}
		}

		out = append(out, EventRow{
			SourceID:     sourceID,
			EventType:    eventType,
			InstrumentID: instrumentID,
			BusinessTs:   businessTs,
			Payload:      payload,
		})
	}
	return out, nil
}
```

- [ ] **Step 4: Wire the route**

Modify `pkg/plugin/handlers_events.go` — change `registerEventRoutes` to:

```go
func (a *App) registerEventRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /ref/events", a.handleListEvents)
	mux.HandleFunc("DELETE /ref/events/{source_id}", a.handleDeleteEvent)
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test ./pkg/plugin/ -run TestMapEventRows -v`
Expected: PASS.

- [ ] **Step 6: Build the backend**

Run: `mage -v` (from the worktree root)
Expected: builds `gpx_core-app_*` with no errors.

- [ ] **Step 7: Commit**

```bash
git add pkg/plugin/handlers_events_read.go pkg/plugin/handlers_events_read_test.go pkg/plugin/handlers_events.go
git commit -m "feat(backend): unified GET /ref/events read from events MV"
```

---

### Task 2: Backend — unified write (`POST /ref/events` + `/ref/events/bulk`)

**Files:**
- Create: `pkg/plugin/handlers_events_write.go`
- Create: `pkg/plugin/handlers_events_write_test.go`
- Modify: `pkg/plugin/routing.go:9-18` (register the write routes)

**Interfaces:**
- Consumes: existing builders `a.publishTrade(ctx, TradeCreate)`, `a.publishDividend(ctx, DividendCreate)`, `a.publishCashflow(ctx, CashflowCreate)`, `a.publishFxConversion(ctx, FxConversionCreate)`, `a.publishTransferIn(ctx, TransferInCreate)`, plus the option delivery/expiry insert paths; `validateFxRate`; `respondErr`, `respondJSON`, `decodeJSON`, `methodGuard`, `a.handlerCtx`.
- Produces: `eventTypeFromRaw(raw []byte) (string, error)`; `a.writeEvent(ctx, raw []byte) error`; handlers `a.handleWriteEvent`, `a.handleWriteEventsBulk`; route registrar `a.registerEventWriteRoutes`.

Each builder already reuses the id it is given as the `source_id`. The unified body carries `event_type` plus that type's existing JSON fields (including its id field — `trade_id`, `dividend_id`, `cashflow_id`, `fx_conversion_id`, `lot_id`, `exercise_id`/`assignment_id`/`expiry_id`). Sending the id field = edit (upsert); omitting it = create. `json.Unmarshal` (not `decodeJSON`, which forbids unknown fields) ignores the extra `event_type` key.

- [ ] **Step 1: Write the failing test**

Create `pkg/plugin/handlers_events_write_test.go`:

```go
package plugin

import "testing"

func TestEventTypeFromRaw(t *testing.T) {
	got, err := eventTypeFromRaw([]byte(`{"event_type":"trade","price":1}`))
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if got != "TRADE" {
		t.Fatalf("want TRADE, got %q", got)
	}
}

func TestEventTypeFromRawMissing(t *testing.T) {
	if _, err := eventTypeFromRaw([]byte(`{"price":1}`)); err == nil {
		t.Fatal("want error for missing event_type")
	}
}

func TestWriteEventUnknownType(t *testing.T) {
	a := &App{}
	err := a.writeEvent(nil, []byte(`{"event_type":"NONSENSE"}`))
	if err == nil {
		t.Fatal("want error for unknown event_type")
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/plugin/ -run 'TestEventType|TestWriteEvent' -v`
Expected: FAIL — `undefined: eventTypeFromRaw`, `undefined: writeEvent`.

- [ ] **Step 3: Implement the dispatcher + handlers**

Create `pkg/plugin/handlers_events_write.go`:

```go
package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// registerEventWriteRoutes wires the unified create/upsert endpoints. A write
// with a source_id (carried in the type's own id field) upserts the existing
// rw_key; without one, the builder generates a fresh id.
func (a *App) registerEventWriteRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /ref/events", a.handleWriteEvent)
	mux.HandleFunc("POST /ref/events/bulk", a.handleWriteEventsBulk)
}

type eventTypeTag struct {
	EventType string `json:"event_type"`
}

// eventTypeFromRaw extracts and upper-cases the event_type discriminant.
func eventTypeFromRaw(raw []byte) (string, error) {
	var tag eventTypeTag
	if err := json.Unmarshal(raw, &tag); err != nil {
		return "", fmt.Errorf("decode event_type: %w", err)
	}
	if strings.TrimSpace(tag.EventType) == "" {
		return "", fmt.Errorf("event_type is required")
	}
	return strings.ToUpper(tag.EventType), nil
}

func (a *App) handleWriteEvent(w http.ResponseWriter, r *http.Request) {
	if !methodGuard(w, r, http.MethodPost) {
		return
	}
	raw, err := readBody(r)
	if err != nil {
		respondErr(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx, ok := a.handlerCtx(w, r)
	if !ok {
		return
	}
	if err := a.writeEvent(ctx, raw); err != nil {
		respondErr(w, http.StatusBadGateway, err.Error())
		return
	}
	respondJSON(w, http.StatusCreated, map[string]string{"status": "ok"})
}

func (a *App) handleWriteEventsBulk(w http.ResponseWriter, r *http.Request) {
	if !methodGuard(w, r, http.MethodPost) {
		return
	}
	raw, err := readBody(r)
	if err != nil {
		respondErr(w, http.StatusBadRequest, err.Error())
		return
	}
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil {
		respondErr(w, http.StatusBadRequest, "expected a JSON array of events: "+err.Error())
		return
	}
	ctx, ok := a.handlerCtx(w, r)
	if !ok {
		return
	}
	for i, item := range items {
		if err := a.writeEvent(ctx, item); err != nil {
			respondErr(w, http.StatusBadGateway, fmt.Sprintf("event %d: %s", i, err.Error()))
			return
		}
	}
	respondJSON(w, http.StatusCreated, map[string]any{"status": "ok", "count": len(items)})
}

// writeEvent decodes the event_type discriminant and dispatches to the existing
// per-type builder. Each builder reuses the supplied id field as source_id, so
// the same payload re-sent with the same id upserts the existing row.
func (a *App) writeEvent(ctx context.Context, raw []byte) error {
	eventType, err := eventTypeFromRaw(raw)
	if err != nil {
		return err
	}
	switch eventType {
	case "TRADE":
		var b TradeCreate
		if err := json.Unmarshal(raw, &b); err != nil {
			return err
		}
		_, err := a.publishTrade(ctx, b)
		return err
	case "DIVIDEND":
		var b DividendCreate
		if err := json.Unmarshal(raw, &b); err != nil {
			return err
		}
		_, err := a.publishDividend(ctx, b)
		return err
	case "CASHFLOW":
		var b CashflowCreate
		if err := json.Unmarshal(raw, &b); err != nil {
			return err
		}
		_, err := a.publishCashflow(ctx, b)
		return err
	case "FX_CONVERSION":
		var b FxConversionCreate
		if err := json.Unmarshal(raw, &b); err != nil {
			return err
		}
		if strings.EqualFold(b.FromCurrency, b.ToCurrency) {
			return fmt.Errorf("from_currency and to_currency must differ")
		}
		if err := validateFxRate(b); err != nil {
			return err
		}
		_, err := a.publishFxConversion(ctx, b)
		return err
	case "TRANSFER_IN":
		var b TransferInCreate
		if err := json.Unmarshal(raw, &b); err != nil {
			return err
		}
		_, err := a.publishTransferIn(ctx, b)
		return err
	case "OPTION_EXERCISE", "OPTION_ASSIGNMENT":
		var b OptionDeliveryCreate
		if err := json.Unmarshal(raw, &b); err != nil {
			return err
		}
		return a.insertOptionDelivery(ctx, eventType, b)
	case "OPTION_EXPIRY":
		var b OptionExpiryCreate
		if err := json.Unmarshal(raw, &b); err != nil {
			return err
		}
		return a.insertOptionExpiry(ctx, b)
	default:
		return fmt.Errorf("unknown event_type %q", eventType)
	}
}
```

Add `readBody` to `pkg/plugin/handlers.go` (after `decodeJSON`):

```go
// readBody reads and returns the whole request body, capped at 4 MiB.
func readBody(r *http.Request) ([]byte, error) {
	return io.ReadAll(io.LimitReader(r.Body, 4<<20))
}
```

Add `"io"` to the imports in `pkg/plugin/handlers.go`.

- [ ] **Step 4: Extract the option insert helpers so the dispatcher and the legacy routes share them**

In `pkg/plugin/handlers_options.go`, refactor the bodies of `handleOptionDelivery` and `handleOptionExpiry` into reusable methods, leaving the HTTP handlers as thin wrappers. Add:

```go
// insertOptionDelivery upserts an OPTION_EXERCISE/OPTION_ASSIGNMENT event.
func (a *App) insertOptionDelivery(ctx context.Context, eventType string, body OptionDeliveryCreate) error {
	if body.SettlementPrice < 0 {
		return fmt.Errorf("settlement_price must be >= 0")
	}
	srcID := derefStr(body.ExerciseID, "")
	if srcID == "" {
		srcID = derefStr(body.AssignmentID, "")
	}
	if srcID == "" {
		srcID = a.newID()
	}
	eventTs := a.now()
	if body.EventTs != nil {
		eventTs = *body.EventTs
	}
	payloadStr, err := marshalPayload(map[string]any{
		"underlying_id":    ptrStr(body.UnderlyingID),
		"settlement_price": body.SettlementPrice,
		"delivered_qty":    body.DeliveredQty,
		"delivered_side":   strings.ToLower(body.DeliveredSide),
		"currency":         strings.ToUpper(body.Currency),
	})
	if err != nil {
		return err
	}
	instrumentID := body.InstrumentID
	return a.insertEvent(ctx, eventType, srcID, body.PortfolioID, &instrumentID, eventTs, payloadStr)
}

// insertOptionExpiry upserts an OPTION_EXPIRY event.
func (a *App) insertOptionExpiry(ctx context.Context, body OptionExpiryCreate) error {
	srcID := derefStr(body.ExpiryID, "")
	if srcID == "" {
		srcID = a.newID()
	}
	eventTs := a.now()
	if body.EventTs != nil {
		eventTs = *body.EventTs
	}
	payloadStr, err := marshalPayload(map[string]any{
		"currency": strings.ToUpper(body.Currency),
	})
	if err != nil {
		return err
	}
	instrumentID := body.InstrumentID
	return a.insertEvent(ctx, "OPTION_EXPIRY", srcID, body.PortfolioID, &instrumentID, eventTs, payloadStr)
}
```

Then rewrite `handleOptionDelivery`'s insert section and `handleOptionExpiry`'s insert section to call these helpers (keep their existing `respondJSON` success shapes). This keeps `mage` green and avoids duplicating payload logic.

- [ ] **Step 5: Register the write routes**

Modify `pkg/plugin/routing.go` `registerLocalRoutes` — add one line after `a.registerEventRoutes(mux)`:

```go
	a.registerEventRoutes(mux)
	a.registerEventWriteRoutes(mux)
```

- [ ] **Step 6: Run tests + build**

Run: `go test ./pkg/plugin/ -run 'TestEventType|TestWriteEvent' -v && go test ./pkg/plugin/ && mage -v`
Expected: PASS; build succeeds.

- [ ] **Step 7: Commit**

```bash
git add pkg/plugin/handlers_events_write.go pkg/plugin/handlers_events_write_test.go pkg/plugin/handlers_options.go pkg/plugin/handlers.go pkg/plugin/routing.go
git commit -m "feat(backend): unified POST /ref/events create+upsert dispatch"
```

---

### Task 3: Frontend — event model + API layer

**Files:**
- Create: `src/lib/events/types.ts`
- Modify: `src/api/reference.ts` (add `listEvents`, `writeEvent`, `writeEventsBulk`; keep `deleteEvent`; leave legacy functions until Task 9)

**Interfaces:**
- Consumes: `refRequest` (`src/api/client.ts`).
- Produces: `EventType`, `EventRow`, `EventInput` (in `src/lib/events/types.ts`); `listEvents(portfolioId): Promise<EventRow[]>`, `writeEvent(input: EventInput): Promise<unknown>`, `writeEventsBulk(inputs: EventInput[]): Promise<unknown>`.

- [ ] **Step 1: Create the shared types**

Create `src/lib/events/types.ts`:

```ts
// Event types that live in portfolio_events_log and appear in the events table.
// OPTION_MARK is intentionally excluded — it is a data_log price, not an event.
export type EventType =
  | 'TRADE'
  | 'DIVIDEND'
  | 'CASHFLOW'
  | 'FX_CONVERSION'
  | 'TRANSFER_IN'
  | 'OPTION_EXERCISE'
  | 'OPTION_ASSIGNMENT'
  | 'OPTION_EXPIRY';

// Unified read shape returned by GET /ref/events.
export type EventRow = {
  source_id: string;
  event_type: EventType;
  instrument_id: string | null;
  business_ts: number; // epoch micros
  payload: Record<string, unknown>;
};

// Unified write shape sent to POST /ref/events. Carries the discriminant plus
// the type-specific fields the Go builder expects. `source_id` present = edit
// (the builder reuses it as the row id and upserts); absent = create.
export type EventInput = {
  event_type: EventType;
  source_id?: string;
  portfolio_id: string;
  updated_by: string;
  event_ts?: number;
  instrument_id?: string;
} & Record<string, unknown>;
```

- [ ] **Step 2: Add the API functions**

In `src/api/reference.ts`, add an import at the top and the three functions near `deleteEvent`:

```ts
import type { EventInput, EventRow } from '../lib/events/types';

export function listEvents(portfolioId: string) {
  return refRequest<EventRow[]>(`/events?portfolio_id=${encodeURIComponent(portfolioId)}`);
}

export function writeEvent(input: EventInput) {
  return refRequest<{ status: string }>('/events', { method: 'POST', body: input });
}

export function writeEventsBulk(inputs: EventInput[]) {
  return refRequest<{ status: string; count: number }>('/events/bulk', {
    method: 'POST',
    body: inputs,
  });
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no references removed yet, so nothing breaks).

- [ ] **Step 4: Commit**

```bash
git add src/lib/events/types.ts src/api/reference.ts
git commit -m "feat(frontend): EventRow/EventInput model + unified events API"
```

---

### Task 4: Frontend — the event-type registry (keystone)

**Files:**
- Create: `src/lib/events/registry.ts`
- Create: `src/lib/events/registry.test.ts`

**Interfaces:**
- Consumes: `EventType`, `EventRow`, `EventInput`; `datetimeLocalToMicros`, `microsToDatetimeLocalValue`, `parseOptionalNumber` (`src/lib/time.ts`); `DEFAULT_UPDATED_BY` (`src/lib/attributes.ts`).
- Produces:
  - `type FieldSpec = { name: string; label: string; kind: 'text'|'number'|'select'|'currency'|'instrument'; required?: boolean; options?: Array<{label:string; value:string}> }`
  - `type EventSummary = { instrument: string; side: string; amount: string; currency: string }`
  - `type EventForm = Record<string, string>`
  - `type EventTypeDef = { type: EventType; label: string; family: 'trade'|'income'|'cash'|'transfer'|'option'; icon: string; fields: FieldSpec[]; summary(row: EventRow): EventSummary; toInput(form: EventForm, portfolioId: string): EventInput; fromRow(row: EventRow): EventForm }`
  - `EVENT_REGISTRY: Record<EventType, EventTypeDef>`
  - `EVENT_TYPES_IN_ORDER: EventType[]`
  - helper `fmtNum(v: unknown): string`

Design: form values are strings (raw input values). `fromRow` stringifies the row's payload/header into form fields; `toInput` parses them back into an `EventInput`. The round-trip `toInput(fromRow(row))` must reproduce the row's semantic values. `summary` produces the universal table cells.

- [ ] **Step 1: Write the failing round-trip + summary test**

Create `src/lib/events/registry.test.ts`:

```ts
import { EVENT_REGISTRY } from './registry';
import type { EventRow } from './types';

const tradeRow: EventRow = {
  source_id: 'src-1',
  event_type: 'TRADE',
  instrument_id: 'KBR',
  business_ts: 1_700_000_000_000_000,
  payload: { side: 'buy', price: 32.1, quantity: 25, currency: 'USD', venue: 'XLON' },
};

describe('event registry', () => {
  it('summarises a trade for the table', () => {
    const s = EVENT_REGISTRY.TRADE.summary(tradeRow);
    expect(s.instrument).toBe('KBR');
    expect(s.side.toLowerCase()).toBe('buy');
    expect(s.currency).toBe('USD');
    expect(s.amount).toContain('25');
  });

  it('round-trips a trade row through fromRow -> toInput', () => {
    const def = EVENT_REGISTRY.TRADE;
    const input = def.toInput(def.fromRow(tradeRow), 'pf-1');
    expect(input.event_type).toBe('TRADE');
    expect(input.source_id).toBe('src-1'); // edit reuses the row id
    expect(input.portfolio_id).toBe('pf-1');
    expect(input.instrument_id).toBe('KBR');
    expect(input.side).toBe('buy');
    expect(input.price).toBe(32.1);
    expect(input.quantity).toBe(25);
    expect(input.currency).toBe('USD');
  });

  it('round-trips a cashflow row (no instrument)', () => {
    const row: EventRow = {
      source_id: 'src-2',
      event_type: 'CASHFLOW',
      instrument_id: null,
      business_ts: 1_700_000_000_000_000,
      payload: { type: 'INTEREST_ON_CASH', amount_native: 0.25, currency: 'GBP' },
    };
    const def = EVENT_REGISTRY.CASHFLOW;
    const input = def.toInput(def.fromRow(row), 'pf-1');
    expect(input.event_type).toBe('CASHFLOW');
    expect(input.type).toBe('INTEREST_ON_CASH');
    expect(input.amount_native).toBe(0.25);
    expect(input.currency).toBe('GBP');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/lib/events/registry.test.ts`
Expected: FAIL — cannot find module `./registry`.

- [ ] **Step 3: Implement the registry**

Create `src/lib/events/registry.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/lib/events/registry.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`

```bash
git add src/lib/events/registry.ts src/lib/events/registry.test.ts
git commit -m "feat(frontend): event-type registry driving table/drawer/import"
```

---

### Task 5: Frontend — single events table page

**Files:**
- Create: `src/components/events/EventsTable.tsx`
- Create: `src/components/events/EventsTable.test.tsx`
- Modify: `src/pages/EventsPage.tsx` (full rewrite of the page body; keep the `Page`/`PortfolioSelector` shell)

**Interfaces:**
- Consumes: `listEvents`, `deleteEvent`; `EVENT_REGISTRY`, `EVENT_TYPES_IN_ORDER`, `fmtNum`, `EventSummary`; `EventRow`, `EventType`; `formatEventMicros`; `usePortfolio`.
- Produces: `EventsTable` component (props below); a `filterAndSortEvents(rows, { query, family, sortDir }): EventRow[]` pure helper exported for testing; `EventsPage` rendering the table + detail drawer.

`EventsTable` props:
```ts
type EventsTableProps = {
  rows: EventRow[];
  query: string;
  family: 'all' | 'trade' | 'income' | 'cash' | 'transfer' | 'option';
  sortDir: 'asc' | 'desc';
  onRowClick: (row: EventRow) => void;
};
```

- [ ] **Step 1: Write the failing test for the pure filter/sort helper**

Create `src/components/events/EventsTable.test.tsx`:

```ts
import { filterAndSortEvents } from './EventsTable';
import type { EventRow } from '../../lib/events/types';

const rows: EventRow[] = [
  { source_id: 'a', event_type: 'TRADE', instrument_id: 'KBR', business_ts: 200,
    payload: { side: 'buy', price: 1, quantity: 1, currency: 'USD' } },
  { source_id: 'b', event_type: 'CASHFLOW', instrument_id: null, business_ts: 300,
    payload: { type: 'DEPOSIT', amount_native: 5, currency: 'GBP' } },
  { source_id: 'c', event_type: 'TRADE', instrument_id: 'CHTR', business_ts: 100,
    payload: { side: 'sell', price: 2, quantity: 3, currency: 'USD' } },
];

describe('filterAndSortEvents', () => {
  it('sorts by business_ts desc by default', () => {
    const out = filterAndSortEvents(rows, { query: '', family: 'all', sortDir: 'desc' });
    expect(out.map((r) => r.source_id)).toEqual(['b', 'a', 'c']);
  });

  it('filters by free-text search across instrument + type', () => {
    const out = filterAndSortEvents(rows, { query: 'chtr', family: 'all', sortDir: 'desc' });
    expect(out.map((r) => r.source_id)).toEqual(['c']);
  });

  it('filters by family (trade family excludes cashflow)', () => {
    const out = filterAndSortEvents(rows, { query: '', family: 'trade', sortDir: 'desc' });
    expect(out.every((r) => r.event_type === 'TRADE')).toBe(true);
    expect(out).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/components/events/EventsTable.test.tsx`
Expected: FAIL — cannot find module `./EventsTable`.

- [ ] **Step 3: Implement `EventsTable` with the pure helper**

Create `src/components/events/EventsTable.tsx`:

```tsx
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/components/events/EventsTable.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Rewrite `EventsPage.tsx`**

Replace the entire contents of `src/pages/EventsPage.tsx` with:

```tsx
import React, { useCallback, useEffect, useState } from 'react';
import { css } from '@emotion/css';
import { useNavigate } from 'react-router-dom';

import { AppEvents, type GrafanaTheme2 } from '@grafana/data';
import { Button, ConfirmModal, FilterPill, Input, Stack, useStyles2 } from '@grafana/ui';

import { Page } from '../components/Page';
import { PortfolioSelector } from '../components/PortfolioSelector';
import { PLUGIN_BASE_URL, ROUTES } from '../constants';
import { usePortfolio } from '../contexts/PortfolioContext';
import { deleteEvent, listEvents, writeEvent } from '../api/reference';
import { appEvents } from '../lib/toast';
import { EVENT_REGISTRY } from '../lib/events/registry';
import type { EventRow } from '../lib/events/types';
import { EventsTable, type FamilyFilter } from '../components/events/EventsTable';
import { EventDrawer, type DrawerState } from '../components/events/EventDrawer';

const FAMILY_PILLS: Array<{ label: string; value: FamilyFilter }> = [
  { label: 'All', value: 'all' },
  { label: 'Trades', value: 'trade' },
  { label: 'Income', value: 'income' },
  { label: 'Cash', value: 'cash' },
  { label: 'Transfers', value: 'transfer' },
  { label: 'Options', value: 'option' },
];

export function EventsPage() {
  const styles = useStyles2(getStyles);
  const navigate = useNavigate();
  const { selected, selectedPortfolio, portfolios, loading } = usePortfolio();

  const [rows, setRows] = useState<EventRow[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [family, setFamily] = useState<FamilyFilter>('all');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<EventRow | null>(null);

  const refresh = useCallback(async () => {
    if (!selected) {
      return;
    }
    setRefreshing(true);
    try {
      setRows(await listEvents(selected));
    } catch (err) {
      appEvents.emit(AppEvents.alertError, [err instanceof Error ? err.message : 'Failed to load events']);
    } finally {
      setRefreshing(false);
    }
  }, [selected]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleSubmit = async (input: ReturnType<typeof EVENT_REGISTRY.TRADE.toInput>) => {
    try {
      await writeEvent(input);
      appEvents.emit(AppEvents.alertSuccess, ['Saved event.']);
      setDrawer(null);
      await refresh();
    } catch (err) {
      appEvents.emit(AppEvents.alertError, [err instanceof Error ? err.message : 'Save failed']);
    }
  };

  const handleDelete = async (row: EventRow) => {
    if (!selected) {
      return;
    }
    try {
      await deleteEvent(row.source_id, selected);
      appEvents.emit(AppEvents.alertSuccess, ['Deleted event.']);
      await refresh();
    } catch (err) {
      appEvents.emit(AppEvents.alertError, [err instanceof Error ? err.message : 'Delete failed']);
    }
  };

  const portfolioLabel = selectedPortfolio
    ? `${selectedPortfolio.attributes?.name?.trim() || 'Untitled portfolio'} · ${selectedPortfolio.base_currency}`
    : '';

  return (
    <Page>
      <PortfolioSelector />

      {!selected && !loading && (
        <div className={styles.muted}>
          {portfolios.length === 0 ? 'Create a portfolio first.' : 'Pick a portfolio from the selector above.'}
        </div>
      )}

      {selected && (
        <>
          <div className={styles.headerRow}>
            <div>
              <h2 className={styles.h2}>Events · {portfolioLabel}</h2>
              <p className={styles.sub}>All trades, income, cash, transfers and option events for this portfolio.</p>
            </div>
            <Stack direction="row" gap={1}>
              <Button variant="secondary" icon="upload" onClick={() => navigate(`${PLUGIN_BASE_URL}/${ROUTES.Import}`)}>
                Bulk import
              </Button>
              <Button icon="plus" onClick={() => setDrawer({ mode: 'create', type: 'TRADE' })}>
                Add event
              </Button>
            </Stack>
          </div>

          <div className={styles.controls}>
            <Input
              prefix={<span>🔎</span>}
              placeholder="Search events…"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              width={40}
            />
            <Stack direction="row" gap={0.5}>
              {FAMILY_PILLS.map((p) => (
                <FilterPill key={p.value} label={p.label} selected={family === p.value} onClick={() => setFamily(p.value)} />
              ))}
            </Stack>
          </div>

          <div className={styles.tableWrapper}>
            <EventsTable
              rows={rows}
              query={query}
              family={family}
              sortDir={sortDir}
              onToggleSort={() => setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))}
              onRowClick={(row) => setDrawer({ mode: 'detail', type: row.event_type, row })}
            />
          </div>
          {refreshing && <div className={styles.muted}>Loading…</div>}
        </>
      )}

      {deleteTarget && (
        <ConfirmModal
          isOpen
          title="Delete event"
          body="This records a tombstone and removes the event from the portfolio. This cannot be undone."
          confirmText="Delete"
          dismissText="Cancel"
          onConfirm={() => {
            const row = deleteTarget;
            setDeleteTarget(null);
            setDrawer(null);
            void handleDelete(row);
          }}
          onDismiss={() => setDeleteTarget(null)}
        />
      )}

      {drawer && selected && (
        <EventDrawer
          state={drawer}
          portfolioId={selected}
          onClose={() => setDrawer(null)}
          onSubmit={handleSubmit}
          onEdit={(row) => setDrawer({ mode: 'edit', type: row.event_type, row })}
          onDelete={(row) => setDeleteTarget(row)}
        />
      )}
    </Page>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  headerRow: css({
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    marginBottom: theme.spacing(2),
    gap: theme.spacing(2),
    flexWrap: 'wrap',
  }),
  h2: css({ margin: 0, fontSize: theme.typography.h3.fontSize }),
  sub: css({ color: theme.colors.text.secondary, marginTop: theme.spacing(0.5), marginBottom: 0 }),
  controls: css({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing(2),
    marginBottom: theme.spacing(1.5),
    flexWrap: 'wrap',
  }),
  tableWrapper: css({
    backgroundColor: theme.colors.background.primary,
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    overflow: 'auto',
  }),
  muted: css({ color: theme.colors.text.secondary, padding: theme.spacing(2) }),
});
```

> Note: `selectedPortfolio` and the `DrawerState`/`EventDrawer` props come from Task 8 and Task 6 respectively. Implement Task 6 and Task 8 before this page typechecks cleanly; the table component (Steps 1–4) is independently testable now. If executing strictly in order, land Steps 1–4 (table + test + commit) here, then complete the `EventsPage.tsx` rewrite at the end of Task 6.

- [ ] **Step 6: Commit the table (page rewrite verified after Task 6/8)**

```bash
git add src/components/events/EventsTable.tsx src/components/events/EventsTable.test.tsx
git commit -m "feat(frontend): searchable/sortable EventsTable + filter helper"
```

---

### Task 6: Frontend — Add/Edit/detail drawer (registry-driven)

**Files:**
- Rewrite: `src/components/events/EventDrawer.tsx` (replace the old per-kind drawer entirely)

**Interfaces:**
- Consumes: `EVENT_REGISTRY`, `EVENT_TYPES_IN_ORDER`, `EventTypeDef`, `EventForm`, `FieldSpec`, `EventSummary`; `EventRow`, `EventType`, `EventInput`; `formatEventMicros`.
- Produces:
  - `type DrawerState = { mode: 'create'; type: EventType } | { mode: 'edit'; type: EventType; row: EventRow } | { mode: 'detail'; type: EventType; row: EventRow }`
  - `EventDrawer` component with props `{ state: DrawerState; portfolioId: string; onClose(): void; onSubmit(input: EventInput): void; onEdit(row: EventRow): void; onDelete(row: EventRow): void }`

Behavior: `detail` renders a read-only field grid (from `def.fromRow(row)`) with Edit + Delete buttons. `edit`/`create` render an editable form from `def.fields`; `create` shows a type dropdown at the top (options = `EVENT_TYPES_IN_ORDER` mapped to `def.label`); changing it resets the form. Submit calls `def.toInput(form, portfolioId)` → `onSubmit`.

- [ ] **Step 1: Implement the drawer**

Replace the entire contents of `src/components/events/EventDrawer.tsx` with:

```tsx
import React, { useMemo, useState } from 'react';
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
```

> Note: the `event_ts` field is rendered as a free-text input accepting a date/time string; `registry.base()` parses it with `datetimeLocalToMicros`, which accepts `YYYY-MM-DDTHH:mm:ss`. To use the native picker instead, set its input `type` to `datetime-local` — optional polish, not required.

- [ ] **Step 2: Complete the `EventsPage.tsx` rewrite from Task 5 Step 5**

Apply the Task 5 Step 5 file content now that `DrawerState`/`EventDrawer` exist. Fix the `handleSubmit` signature to accept `EventInput`:

```tsx
import type { EventInput, EventRow } from '../lib/events/types';
// ...
const handleSubmit = async (input: EventInput) => {
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS once Task 8 (`selectedPortfolio` on the context) is also applied. If running strictly in order and Task 8 is not yet done, temporarily derive the label inline: `const sp = portfolios.find((p) => p.portfolio_id === selected);` and use `sp?.attributes?.name`. Replace with `selectedPortfolio` after Task 8.

- [ ] **Step 4: Run all frontend tests**

Run: `npm run test:ci`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/events/EventDrawer.tsx src/pages/EventsPage.tsx
git commit -m "feat(frontend): registry-driven Add/Edit/detail event drawer + page"
```

---

### Task 7: Frontend — import event-review step (reuse table + drawer)

**Files:**
- Create: `src/lib/events/fromBrokerResult.ts`
- Create: `src/lib/events/fromBrokerResult.test.ts`
- Modify: `src/pages/ImportPage.tsx` (replace the `map` step with a `review` step; persist via `writeEventsBulk`)

**Interfaces:**
- Consumes: `BrokerImportResult` (`src/lib/import/types.ts`); `withInstrumentIdentity` (`src/lib/import/withInstrumentIdentity.ts`); `EventInput`, `EventRow`; `EVENT_REGISTRY`; `EventsTable`; `EventDrawer`; `writeEventsBulk`.
- Produces: `brokerResultToInputs(result: BrokerImportResult): EventInput[]`; `inputsToRows(inputs: EventInput[]): EventRow[]` (for previewing parsed events in the same table before they have a server `source_id`).

The importer already produces typed request arrays. Convert each to an `EventInput` by stamping `event_type` and copying fields. `inputsToRows` projects an `EventInput` into a display `EventRow` (synthesising a temporary `source_id` and moving non-envelope fields into `payload`) so the existing `EventsTable` renders the preview.

- [ ] **Step 1: Write the failing mapper test**

Create `src/lib/events/fromBrokerResult.test.ts`:

```ts
import { brokerResultToInputs, inputsToRows } from './fromBrokerResult';
import type { BrokerImportResult } from '../import/types';

const empty: BrokerImportResult = {
  trades: [], dividends: [], cashflows: [], fxConversions: [], transferIns: [],
  optionExercises: [], optionAssignments: [], optionExpiries: [], optionMarks: [],
  instrumentsToRegister: [], skipped: 0, errors: [],
};

describe('brokerResultToInputs', () => {
  it('maps a trade request to a TRADE EventInput', () => {
    const result: BrokerImportResult = {
      ...empty,
      trades: [{
        portfolio_id: 'pf', instrument_id: 'KBR', side: 'buy', price: 32.1, quantity: 25,
        currency: 'USD', venue: 'XLON', updated_by: 'x',
      }],
    };
    const inputs = brokerResultToInputs(result);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].event_type).toBe('TRADE');
    expect(inputs[0].instrument_id).toBe('KBR');
    expect(inputs[0].price).toBe(32.1);
  });

  it('excludes option marks (not portfolio events)', () => {
    const result: BrokerImportResult = {
      ...empty,
      optionMarks: [{ instrument_id: 'X', observed_at: 1, close: 2, currency: 'USD', updated_by: 'x' }],
    };
    expect(brokerResultToInputs(result)).toHaveLength(0);
  });

  it('projects inputs into rows the table can render', () => {
    const rows = inputsToRows(brokerResultToInputs({
      ...empty,
      cashflows: [{ portfolio_id: 'pf', type: 'DEPOSIT', amount_native: 5, currency: 'GBP', updated_by: 'x' }],
    }));
    expect(rows[0].event_type).toBe('CASHFLOW');
    expect(rows[0].payload.amount_native).toBe(5);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/lib/events/fromBrokerResult.test.ts`
Expected: FAIL — cannot find module `./fromBrokerResult`.

- [ ] **Step 3: Implement the mapper**

Create `src/lib/events/fromBrokerResult.ts`:

```ts
import type { BrokerImportResult } from '../import/types';
import type { EventInput, EventRow, EventType } from './types';

// Envelope keys live as columns on EventRow; everything else is payload.
const ENVELOPE = new Set(['event_type', 'source_id', 'portfolio_id', 'updated_by', 'event_ts', 'instrument_id']);

// brokerResultToInputs flattens the importer's typed arrays into the unified
// write shape. OPTION_MARK is excluded — it is a data_log price, not an event.
export function brokerResultToInputs(r: BrokerImportResult): EventInput[] {
  const out: EventInput[] = [];
  const push = (type: EventType, items: Array<Record<string, unknown>>) => {
    for (const it of items) {
      out.push({ ...(it as object), event_type: type } as EventInput);
    }
  };
  push('TRADE', r.trades);
  push('DIVIDEND', r.dividends);
  push('CASHFLOW', r.cashflows);
  push('FX_CONVERSION', r.fxConversions);
  push('TRANSFER_IN', r.transferIns);
  push('OPTION_EXERCISE', r.optionExercises);
  push('OPTION_ASSIGNMENT', r.optionAssignments);
  push('OPTION_EXPIRY', r.optionExpiries);
  return out;
}

// inputsToRows projects write inputs into display rows so the events table can
// preview parsed-but-unsaved events. source_id is a synthetic preview key.
export function inputsToRows(inputs: EventInput[]): EventRow[] {
  return inputs.map((input, i) => {
    const payload: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
      if (!ENVELOPE.has(k)) {
        payload[k] = v;
      }
    }
    return {
      source_id: `preview-${i}`,
      event_type: input.event_type,
      instrument_id: (input.instrument_id as string) ?? null,
      business_ts: (input.event_ts as number) ?? Date.now() * 1000,
      payload,
    };
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/lib/events/fromBrokerResult.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Rewire `ImportPage.tsx` — replace `map` with `review`, persist via bulk**

In `src/pages/ImportPage.tsx`:

1. Change the `Step` type (line 56) and step orders (lines 799-800):

```tsx
type Step = 'upload' | 'review' | 'done';
// ...
const STEP_ORDER: Step[] = ['upload', 'review', 'done'];
```

Delete `STEP_ORDER_WITH_LOTS`, `STEP_ORDER_NO_LOTS`, and the `includeLots` logic (lines ~799-810); the lots breakdown is no longer a separate step.

2. After a successful parse, build the preview inputs and go to `review` instead of `map`. Replace the `setStep('map')` site (line ~384) and add state near the other `useState`s:

```tsx
import { brokerResultToInputs, inputsToRows } from '../lib/events/fromBrokerResult';
import { writeEventsBulk } from '../api/reference';
import { EventsTable, type FamilyFilter } from '../components/events/EventsTable';
import { EventDrawer, type DrawerState } from '../components/events/EventDrawer';
import { EVENT_REGISTRY } from '../lib/events/registry';
import type { EventInput } from '../lib/events/types';
// ...
const [previewInputs, setPreviewInputs] = useState<EventInput[]>([]);
const [reviewQuery, setReviewQuery] = useState('');
const [reviewFamily, setReviewFamily] = useState<FamilyFilter>('all');
const [reviewDrawer, setReviewDrawer] = useState<DrawerState | null>(null);
```

In the parse handler, after computing the `ParseResult` `r`, stamp instrument identity onto trades exactly as the old `runImport` did, then:

```tsx
const stampedTrades = withInstrumentIdentity(r.trades, r.instrumentsToRegister);
setPreviewInputs(brokerResultToInputs({ ...r, trades: stampedTrades }));
setStep('review');
```

3. Replace the `map`/`lots`/`confirm` step JSX blocks (lines ~654-783) with a single `review` block that reuses the events table + drawer and lets the user edit/remove parsed rows before commit:

```tsx
{step === 'review' ? (
  <>
    <div className={styles.reviewHeader}>
      <h3>Review {previewInputs.length} parsed events</h3>
      <Stack direction="row" gap={1}>
        <Button variant="secondary" onClick={() => setStep('upload')}>Back</Button>
        <Button onClick={() => void commitReview()} disabled={previewInputs.length === 0}>
          Import {previewInputs.length} events
        </Button>
      </Stack>
    </div>
    <div className={styles.tableWrapper}>
      <EventsTable
        rows={inputsToRows(previewInputs)}
        query={reviewQuery}
        family={reviewFamily}
        sortDir="desc"
        onToggleSort={() => undefined}
        onRowClick={(row) => {
          const idx = Number(row.source_id.replace('preview-', ''));
          setReviewDrawer({ mode: 'detail', type: row.event_type, row });
          // idx is available for edit/remove wiring below
          void idx;
        }}
      />
    </div>
  </>
) : null}
```

4. Add the commit function (replaces `runImport`'s many bulk calls with one):

```tsx
const commitReview = async () => {
  try {
    await writeEventsBulk(previewInputs);
    appEvents.emit(AppEvents.alertSuccess, [`Imported ${previewInputs.length} events.`]);
    setStep('done');
    // existing post-import refresh/summary logic stays
  } catch (err) {
    appEvents.emit(AppEvents.alertError, [err instanceof Error ? err.message : 'Import failed']);
  }
};
```

5. Delete the now-unused imports and code: the `map`-step instrument-mapping JSX, `LotsStep` usage, and the per-type `submit*Bulk` imports (lines 23-31). Remove the `InstrumentsStep`/map helpers if they are local to this file. The transfer-in lot breakdown is handled by editing the TRANSFER_IN rows in the review drawer (each parsed lot is already its own row).

6. Add the two styles used above to the page's `getStyles`:

```tsx
reviewHeader: css({ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: theme.spacing(2) }),
tableWrapper: css({ border: `1px solid ${theme.colors.border.weak}`, borderRadius: theme.shape.radius.default, overflow: 'auto', marginBottom: theme.spacing(2) }),
```

- [ ] **Step 6: Wire review-drawer edit/remove (in-memory)**

Render the review `EventDrawer` with handlers that mutate `previewInputs` instead of calling the server, so edits apply to the pending batch:

```tsx
{reviewDrawer && (
  <EventDrawer
    state={reviewDrawer}
    portfolioId={portfolioId}
    onClose={() => setReviewDrawer(null)}
    onSubmit={(input) => {
      const idx = reviewDrawer.mode !== 'create' ? Number(reviewDrawer.row.source_id.replace('preview-', '')) : -1;
      setPreviewInputs((prev) => prev.map((p, i) => (i === idx ? input : p)));
      setReviewDrawer(null);
    }}
    onEdit={(row) => setReviewDrawer({ mode: 'edit', type: row.event_type, row })}
    onDelete={(row) => {
      const idx = Number(row.source_id.replace('preview-', ''));
      setPreviewInputs((prev) => prev.filter((_, i) => i !== idx));
      setReviewDrawer(null);
    }}
  />
)}
```

(`portfolioId` is the import target portfolio already held in `ImportPage` state.)

- [ ] **Step 7: Typecheck, lint, test, build**

Run: `npm run typecheck && npm run lint && npm run test:ci && npm run build`
Expected: PASS; production bundle builds.

- [ ] **Step 8: Commit**

```bash
git add src/lib/events/fromBrokerResult.ts src/lib/events/fromBrokerResult.test.ts src/pages/ImportPage.tsx
git commit -m "feat(frontend): import event-review reuses events table + bulk write"
```

---

### Task 8: Frontend — portfolio names everywhere (never UUIDs)

**Files:**
- Modify: `src/contexts/PortfolioContext.tsx` (expose `selectedPortfolio`)
- Modify: `src/components/PortfolioSelector.tsx` (drop the UUID fallback)
- Audit: any remaining `portfolio_id` rendered as text

**Interfaces:**
- Consumes: `PortfolioEntity`.
- Produces: `PortfolioContextValue.selectedPortfolio: PortfolioEntity | null`.

- [ ] **Step 1: Expose the selected portfolio object on the context**

In `src/contexts/PortfolioContext.tsx`, extend the value type and computation:

```tsx
type PortfolioContextValue = {
  portfolios: PortfolioEntity[];
  selected: string | null;
  selectedPortfolio: PortfolioEntity | null;
  setSelected: (id: string | null) => void;
  loading: boolean;
  refresh: () => Promise<void>;
};
```

And before building `value`:

```tsx
const selectedPortfolio = useMemo(
  () => portfolios.find((p) => p.portfolio_id === validatedSelection) ?? null,
  [portfolios, validatedSelection],
);

const value: PortfolioContextValue = {
  portfolios,
  selected: validatedSelection,
  selectedPortfolio,
  setSelected,
  loading,
  refresh,
};
```

- [ ] **Step 2: Drop the UUID fallback in the selector**

In `src/components/PortfolioSelector.tsx`, replace the `options` map (lines 22-28) with:

```tsx
const options = portfolios.map((p) => {
  const name = p.attributes?.name?.trim();
  const label = `${name || 'Untitled portfolio'}  ·  ${p.base_currency}`;
  return { label, value: p.portfolio_id };
});
```

- [ ] **Step 3: Audit for any other raw-ID leak**

Run: `grep -rn "selected}" src/ ; grep -rn "portfolio_id}" src/ ; grep -rn "\.slice(0, 8)" src/`
Expected: no UI text renders a bare `portfolio_id` or `selected` UUID. The Events header (Task 5/6) already uses `selectedPortfolio`. Fix any remaining hit by routing through `selectedPortfolio`/name.

- [ ] **Step 4: Typecheck + test + build**

Run: `npm run typecheck && npm run test:ci && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/contexts/PortfolioContext.tsx src/components/PortfolioSelector.tsx
git commit -m "feat(frontend): show portfolio names, never UUIDs"
```

---

### Task 9: Cleanup — remove dead per-type API + retire correction path

**Files:**
- Modify: `src/api/reference.ts` (remove now-unused list/submit/correction functions and their list-row types)
- Modify: `src/pages/EventsPage.tsx` / `src/pages/ImportPage.tsx` (confirm no remaining imports of removed symbols)
- Optional: `pkg/plugin/handlers_trades.go` (remove `handleTradeCorrection` + route), `pkg/plugin/handlers_events.go` legacy per-type routes — only if nothing references them.

**Interfaces:**
- Consumes: nothing new.
- Produces: a smaller `reference.ts` exporting only `listEvents`, `writeEvent`, `writeEventsBulk`, `deleteEvent`, portfolio + instrument functions, and the option/instrument types still used by the importer (`InstrumentRegistration`, request types consumed by `withInstrumentIdentity`).

- [ ] **Step 1: Find dead references**

Run: `grep -rn "submitTrade\|submitDividend\|submitCashflow\|submitFxConversion\|submitTransferIn\|submitTradeCorrection\|listTrades\|listDividends\|listCashflows\|listFxConversions\|listTransferIns\|submit.*Bulk\|TradeListRow\|DividendListRow\|CashflowListRow\|FxConversionListRow\|TransferInListRow" src/`
Expected: only `src/api/reference.ts` definitions (no callers) plus the importer's use of the `*Request` types (keep those).

- [ ] **Step 2: Remove the dead functions/types**

Delete from `src/api/reference.ts`: `submitTrade`, `listTrades`, `submitTradesBulk`, `submitTradeCorrection`, `TradeListRow`, `TradeCorrectionPayload`; the equivalent dividend/cashflow/fx/transfer `submit*`, `submit*Bulk`, `list*`, and `*ListRow` symbols. Keep `*Request`/`*Out` types still imported by the importer and `withInstrumentIdentity`. Keep `deleteEvent`, `listPortfolios`, `createPortfolio`, `deletePortfolio`, `listInstruments`, `lookupSymbol`, and option submit functions if still referenced (grep to confirm before deleting any).

- [ ] **Step 3: Retire the trade-correction backend route (optional)**

If `grep -rn "corrections" src/` returns nothing, remove `handleTradeCorrection` and its `mux.HandleFunc("/ref/trades/{id}/corrections", ...)` line from `pkg/plugin/handlers_trades.go`. Leave the per-type create routes (`/ref/trades` POST etc.) — they share the `publish*` builders and are harmless.

- [ ] **Step 4: Full verification**

Run: `npm run typecheck && npm run lint && npm run test:ci && npm run build && go test ./pkg/plugin/... && mage -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(frontend): drop dead per-type event API + correction path"
```

---

### Task 10: End-to-end verification against the running stack

**Files:** none (manual verification).

- [ ] **Step 1: Rebuild and load the plugin**

Backend: `mage -v`. Frontend: `npm run build`. Restart/reload the plugin in the running Grafana (or `npm run server` if using the bundled docker stack) so both artifacts are picked up. RisingWave must be running on `localhost:4566`.

- [ ] **Step 2: Verify the read path (the original bug)**

Open the Events page for portfolio `demo · GBP`. Expected: the single table shows the portfolio's events (the seed data has 397 trades, 161 cashflows, 15 dividends, 2 transfers = 575 rows), newest first, header reads `Events · demo · GBP` (no UUID). Cross-check the count with:
`psql -h localhost -p 4566 -d dev -U root -c "SELECT count(*) FROM events WHERE portfolio_id='74691756-eb90-438a-a200-095651ef2ba6';"`

- [ ] **Step 3: Verify search/sort/filter**

Type an instrument symbol in search → table narrows. Click a family pill (e.g. Trades) → only trade-family rows. Click the Time header → sort flips.

- [ ] **Step 4: Verify add + edit (upsert) + delete**

Add event → pick Cashflow → fill amount/currency → Create. Confirm a new row appears and a matching `portfolio_events_log` row exists. Open it → Edit → change the amount → Save. Confirm the SAME row updates (no duplicate) — verify via:
`psql -h localhost -p 4566 -d dev -U root -c "SELECT count(*) FROM portfolio_events_log WHERE source_id='<the source_id>';"` returns 1. Delete it → row disappears and the count goes to 0.

- [ ] **Step 5: Verify import event-review**

Bulk import a sample CSV → confirm the wizard goes upload → review (no instruments step), the review table shows parsed events using the same components, editing/removing a row updates the pending batch, and Import persists them (re-check the events table count rose by the imported amount).

- [ ] **Step 6: Final commit (if any verification fixups were needed)**

```bash
git add -A && git commit -m "fix: events page redesign verification fixups"
```

---

## Self-Review Notes

- **Spec coverage:** empty-page fix (Task 1), unified write/upsert replacing corrections (Task 2), single searchable/sortable table (Task 5), FX-as-trade family + options visible (Task 4 registry + Task 1 read), Add-Event type-dropdown drawer (Task 6), shared create/import logic (Task 2 backend + Task 7 mapper both feed `writeEvent(s)`), import event-review reusing components (Task 7), drop instruments step (Task 7), portfolio names (Task 8), testing (Tasks 1–8 unit + Task 10 e2e). `OPTION_MARK` exclusion is documented (Global Constraints, Task 7) — flag for the user.
- **Cross-task type consistency:** `EventRow`/`EventInput`/`EventType` defined in Task 3 and used verbatim in Tasks 4–8; `DrawerState`/`EventDrawer` defined in Task 6 and consumed in Tasks 5 and 7; `filterAndSortEvents`/`EventsTable` defined in Task 5 and reused in Task 7.
- **Build-green ordering:** new API functions are added (Task 3) before old ones are removed (Task 9); the `EventsPage.tsx` rewrite is split so the table lands testable in Task 5 and the page compiles after Task 6/8.
