package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/opencapital-dev/oc-plugin-sdk/datakey"
)

// nowMicros is the default business_ts when the request body omits it.
func nowMicros() int64 {
	return time.Now().UTC().UnixMicro()
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
func (a *App) insertEvent(ctx context.Context, eventType, sourceID, portfolioID string, instrumentID *string, businessTsMicros int64, payloadJSON string) error {
	rwKey := datakey.EventKey(a.pluginID, sourceID)
	instrVal := ""
	if instrumentID != nil {
		instrVal = *instrumentID
	}
	_, err := a.client.Exec(ctx,
		`INSERT INTO portfolio_events_log
          (source_id, event_type, portfolio_id, instrument_id, business_ts, ingest_ts, source, plugin_id, trace_id, payload, rw_key)
         VALUES ($1,$2,$3,$4, to_timestamp($5/1e6), now(), $6, $7, $8, $9, $10)`,
		sourceID, eventType, portfolioID, instrVal,
		businessTsMicros, "core-app", a.pluginID, a.newID(), payloadJSON, rwKey,
	)
	if err != nil {
		return fmt.Errorf("insertEvent %s: %w", eventType, err)
	}
	return nil
}

// insertData inserts one row into data_log via RisingWave pgwire.
func (a *App) insertData(ctx context.Context, namespace, sourceID, portfolioID string, observedAtMicros int64, payloadJSON string) error {
	rwKey := datakey.DataKey(a.pluginID, namespace, portfolioID, sourceID, observedAtMicros)
	_, err := a.client.Exec(ctx,
		`INSERT INTO data_log
          (source_namespace, source_id, portfolio_id, observed_at, ingest_ts, source, plugin_id, trace_id, payload, rw_key)
         VALUES ($1,$2,$3, to_timestamp($4/1e6), now(), $5, $6, $7, $8, $9)`,
		namespace, sourceID, portfolioID,
		observedAtMicros, "core-app", a.pluginID, a.newID(), payloadJSON, rwKey,
	)
	if err != nil {
		return fmt.Errorf("insertData %s: %w", namespace, err)
	}
	return nil
}

// deleteEvent deletes a portfolio event by rw_key (tombstone).
func (a *App) deleteEvent(ctx context.Context, sourceID string) error {
	rwKey := datakey.EventKey(a.pluginID, sourceID)
	_, err := a.client.Exec(ctx,
		`DELETE FROM portfolio_events_log WHERE rw_key = $1`,
		rwKey,
	)
	if err != nil {
		return fmt.Errorf("deleteEvent %s: %w", sourceID, err)
	}
	return nil
}
