# Code-Review Fix Report

## Build + Test Result

```
go build ./...   → (no output, success)
go vet ./...     → (no output, success)
go test ./...    → ok  github.com/portfolio-management/portfolio-admin-v2/pkg/plugin  0.983s
```

---

## Changes Made

### Critical 1 — nil instrument_id → SQL NULL (events_common.go)

Fixed `insertEvent`: replaced the `instrVal := ""` coercion with a proper
`var instrArg interface{} = nil; if instrumentID != nil { instrArg = *instrumentID }`
pattern. Binding `nil` sends SQL NULL to RisingWave, preserving the pipeline's
`IS NULL` / `NOT LIKE 'CASH:%'` fold semantics. `insertData` and `deleteEvent`
had no nullable columns with the same bug — confirmed clean.

### Critical 2 — Tests for write helpers (events_common_test.go)

Introduced `execer` interface (`Exec(ctx, sql string, args ...any) (int64, error)`)
and refactored `insertEvent`, `insertData`, `deleteEvent` into package-level
functions accepting an `execer` seam. The `App` methods delegate to these
package-level helpers. Added `fakeExecer` in the test file and new tests:

- `TestInsertEvent_SQL`: asserts column list, 10 arg positions, `rw_key == datakey.EventKey(pluginID, sourceID)`, `event_type` at `$2`
- `TestInsertEvent_NilInstrumentID`: asserts `$4` is `nil` (SQL NULL) for a nil instrumentID — directly guards Critical 1
- `TestInsertEvent_EventTypePropagation`: asserts event_type reaches `$2` for all event types
- `TestInsertData_SQL`: asserts column list, 9 arg positions, `rw_key == datakey.DataKey(...)`
- `TestDeleteEvent_SQL`: asserts DELETE SQL, 1 arg = `datakey.EventKey(pluginID, sourceID)`
- Retained all prior helper tests (marshalPayload, ptrStr, derefStr, nowMicros, genID)

### Important 3 — acquisition_date unit (handlers_transfer_ins.go)

Confirmed: the frontend's `parseEventTs` returns `ms * 1000` (epoch microseconds).
`TransferInRequest.acquisition_date` carries epoch-µs. The SQL `to_timestamp($5/1e6)`
correctly converts µs→seconds for RisingWave TIMESTAMPTZ. No conversion change
needed — added a clarifying comment at the call site to document the invariant.

### Important 4 — InstrumentEntity under-populated (handlers_ref.go)

The `instruments_catalog` view provides: `instrument_id`, `kind`,
`contract_multiplier`, `currency`, `base_currency`. The frontend
`InstrumentEntity` type also declares `sector`, `subindustry`,
`underlying_id`, `strike`, `expiry_date`, `option_type` — none of these
exist in the view; all are nullable in the TypeScript type, so returning null
is correct behavior.

Extended the SELECT to include `currency` and `base_currency` (columns that
exist in the view but were previously omitted). Refactored the row scanner to
use two new private helpers `asFloat64Ptr` / `asStringPtr` for clean type
switching. The six fields that don't exist in the view remain nil/null in the
response — this matches the declared TypeScript nullability.

### Important 5 — Non-atomic bulk (handlers_*_bulk)

**Decision: doc-comment approach (option b).**

Rationale: building a single multi-row `INSERT … VALUES (…),(…),…` would
require passing typed per-row data into a generic SQL builder, generating
placeholders dynamically, and restructuring every `publish*` helper to return
SQL+args instead of executing. That is a significant refactor touching 5 files
with no SDK tx primitive to validate against. Instead, each bulk handler now
carries a standardised doc comment explaining the partial-insert risk and
advising idempotent retry using the same ID values (trade_id, dividend_id,
cashflow_id, fx_conversion_id, lot_id). This is the right call until the SDK
gains a transaction/batch-exec API.

### Minors — handlers_ref.go

- Removed stale `"v6"` from the 501 error messages in `dispatchPortfolioByID`
  and `dispatchInstrumentByID`.
- Removed the misleading `Allow: DELETE` response header on both 405 paths.
- `UpdatedAt=0` in the create-portfolio response: noted for later (not
  addressed in this pass as instructed).
