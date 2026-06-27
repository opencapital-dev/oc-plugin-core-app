package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/opencapital-dev/oc-plugin-sdk/datakey"
)

// execer is the write seam used by insertEvent, insertData, and deleteEvent.
// *pluginclient.Client satisfies this interface via its Exec method. Tests
// inject a fakeExecer to capture SQL + args without a live database.
type execer interface {
	Exec(ctx context.Context, sql string, args ...any) (int64, error)
}

// nowMicros is the default business_ts when the request body omits it.
func nowMicros() int64 {
	return time.Now().UTC().UnixMicro()
}

// clampAcqMicros guards a TRANSFER_IN acquisition_date (epoch µs). A source that
// omits it serializes Go's zero time (≈ -6.2e16 µs = year 0002); using that as
// business_ts corrupts the fold/MtM timeline (the lot anchors at year 0002 and is
// densified back to the earliest price-day, zeroing historical NAV). Anything
// before 1990 is treated as missing and replaced with the ingest time.
func clampAcqMicros(acq int64) int64 {
	const minValidAcqMicros = int64(631152000) * 1_000_000 // 1990-01-01T00:00:00Z
	if acq < minValidAcqMicros {
		return nowMicros()
	}
	return acq
}

// genID returns a UUIDv4 string.
func genID() string {
	return uuid.NewString()
}

// ptrStr lifts a non-empty string to *string, nil otherwise.
func ptrStr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// derefStr returns *p or fallback when p is nil.
func derefStr(p *string, fallback string) string {
	if p == nil {
		return fallback
	}
	return *p
}

// marshalPayload JSON-encodes a portfolio-event payload map into the string
// that goes into the payload column.
func marshalPayload(m map[string]any) (string, error) {
	b, err := json.Marshal(m)
	if err != nil {
		return "", fmt.Errorf("marshal payload: %w", err)
	}
	return string(b), nil
}

// insertEvent inserts one row into portfolio_events_log via RisingWave pgwire.
// instrumentID may be nil; a nil pointer binds as SQL NULL so the RW pipeline's
// "instrument_id IS NULL" and "NOT LIKE 'CASH:%'" filters work correctly.
func (a *App) insertEvent(ctx context.Context, eventType, sourceID, portfolioID string, instrumentID *string, businessTsMicros int64, payloadJSON string) error {
	return insertEvent(ctx, a.client, a.pluginID, a.newID(), eventType, sourceID, portfolioID, instrumentID, businessTsMicros, payloadJSON)
}

// insertEvent is the package-level helper that accepts an execer seam so it
// can be called from tests without a live RisingWave connection.
func insertEvent(ctx context.Context, db execer, pluginID, traceID, eventType, sourceID, portfolioID string, instrumentID *string, businessTsMicros int64, payloadJSON string) error {
	rwKey := datakey.EventKey(pluginID, sourceID)
	// Bind instrumentID as SQL NULL when nil; binding "" would create phantom
	// rows in the RW pipeline's IS NULL / NOT LIKE 'CASH:%' fold paths.
	var instrArg interface{}
	if instrumentID != nil {
		instrArg = *instrumentID
	}
	_, err := db.Exec(ctx,
		`INSERT INTO portfolio_events_log
          (source_id, event_type, portfolio_id, instrument_id, business_ts, ingest_ts, source, plugin_id, trace_id, payload, rw_key)
         VALUES ($1,$2,$3,$4, to_timestamp($5/1e6), now(), $6, $7, $8, $9, $10)`,
		sourceID, eventType, portfolioID, instrArg,
		businessTsMicros, "core-app", pluginID, traceID, payloadJSON, rwKey,
	)
	if err != nil {
		return fmt.Errorf("insertEvent %s: %w", eventType, err)
	}
	return nil
}

// insertData inserts one row into data_log via RisingWave pgwire.
func (a *App) insertData(ctx context.Context, namespace, sourceID, portfolioID string, observedAtMicros int64, payloadJSON string) error {
	return insertData(ctx, a.client, a.pluginID, a.newID(), namespace, sourceID, portfolioID, observedAtMicros, payloadJSON)
}

// insertData is the package-level helper that accepts an execer seam.
func insertData(ctx context.Context, db execer, pluginID, traceID, namespace, sourceID, portfolioID string, observedAtMicros int64, payloadJSON string) error {
	rwKey := datakey.DataKey(pluginID, namespace, portfolioID, sourceID, observedAtMicros)
	_, err := db.Exec(ctx,
		`INSERT INTO data_log
          (source_namespace, source_id, portfolio_id, observed_at, ingest_ts, source, plugin_id, trace_id, payload, rw_key)
         VALUES ($1,$2,$3, to_timestamp($4/1e6), now(), $5, $6, $7, $8, $9)`,
		namespace, sourceID, portfolioID,
		observedAtMicros, "core-app", pluginID, traceID, payloadJSON, rwKey,
	)
	if err != nil {
		return fmt.Errorf("insertData %s: %w", namespace, err)
	}
	return nil
}

// deleteEvent deletes a portfolio event by rw_key (tombstone).
func (a *App) deleteEvent(ctx context.Context, sourceID string) error {
	return deleteEvent(ctx, a.client, a.pluginID, sourceID)
}

// deleteEvent is the package-level helper that accepts an execer seam.
func deleteEvent(ctx context.Context, db execer, pluginID, sourceID string) error {
	rwKey := datakey.EventKey(pluginID, sourceID)
	_, err := db.Exec(ctx,
		`DELETE FROM portfolio_events_log WHERE rw_key = $1`,
		rwKey,
	)
	if err != nil {
		return fmt.Errorf("deleteEvent %s: %w", sourceID, err)
	}
	return nil
}
