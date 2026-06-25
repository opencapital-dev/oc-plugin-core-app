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
