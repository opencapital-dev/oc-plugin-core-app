package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
)

// validationError signals a client-input problem (HTTP 400). Infrastructure /
// upstream failures are plain errors (HTTP 502).
type validationError struct{ msg string }

func (e validationError) Error() string { return e.msg }

func badRequest(format string, args ...any) error {
	return validationError{msg: fmt.Sprintf(format, args...)}
}

// registerEventWriteRoutes wires the unified create/upsert endpoints. A write
// with a top-level source_id upserts the existing rw_key; without one, the
// builder generates a fresh id.
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
		return "", badRequest("decode event_type: %v", err)
	}
	if strings.TrimSpace(tag.EventType) == "" {
		return "", badRequest("event_type is required")
	}
	return strings.ToUpper(tag.EventType), nil
}

type sourceIDTag struct {
	SourceID string `json:"source_id"`
}

// sourceIDFromRaw extracts the top-level source_id field. An empty string
// means no source_id was supplied (new create; the builder generates a fresh
// id). A non-empty value is injected into the typed struct before calling the
// builder so the row is upserted rather than duplicated.
func sourceIDFromRaw(raw []byte) (string, error) {
	var tag sourceIDTag
	if err := json.Unmarshal(raw, &tag); err != nil {
		return "", badRequest("decode source_id: %v", err)
	}
	return strings.TrimSpace(tag.SourceID), nil
}

// tradeCreateFromRaw unmarshals a TRADE body and, if sourceID is non-empty,
// injects it as TradeID so the builder upserts the existing row instead of
// generating a fresh id.
func tradeCreateFromRaw(raw []byte, sourceID string) (TradeCreate, error) {
	var b TradeCreate
	if err := json.Unmarshal(raw, &b); err != nil {
		return TradeCreate{}, badRequest("decode TRADE body: %v", err)
	}
	if sourceID != "" {
		b.TradeID = &sourceID
	}
	return b, nil
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
		var ve validationError
		if errors.As(err, &ve) {
			respondErr(w, http.StatusBadRequest, err.Error())
		} else {
			respondErr(w, http.StatusBadGateway, err.Error())
		}
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
			var ve validationError
			status := http.StatusBadGateway
			if errors.As(err, &ve) {
				status = http.StatusBadRequest
			}
			respondErr(w, status, fmt.Sprintf("event %d: %s", i, err.Error()))
			return
		}
	}
	respondJSON(w, http.StatusCreated, map[string]any{"status": "ok", "count": len(items)})
}

// writeEvent decodes the event_type discriminant and the universal top-level
// source_id, then dispatches to the per-type builder. If source_id is present
// it is injected as that type's own id field so the builder upserts the
// existing rw_key; if absent the builder generates a fresh id.
func (a *App) writeEvent(ctx context.Context, raw []byte) error {
	eventType, err := eventTypeFromRaw(raw)
	if err != nil {
		return err
	}
	sourceID, err := sourceIDFromRaw(raw)
	if err != nil {
		return err
	}
	switch eventType {
	case "TRADE":
		b, err := tradeCreateFromRaw(raw, sourceID)
		if err != nil {
			return err
		}
		_, err = a.publishTrade(ctx, b)
		return err
	case "DIVIDEND":
		var b DividendCreate
		if err := json.Unmarshal(raw, &b); err != nil {
			return badRequest("decode %s body: %v", eventType, err)
		}
		if sourceID != "" {
			b.DividendID = &sourceID
		}
		_, err := a.publishDividend(ctx, b)
		return err
	case "CASHFLOW":
		var b CashflowCreate
		if err := json.Unmarshal(raw, &b); err != nil {
			return badRequest("decode %s body: %v", eventType, err)
		}
		if sourceID != "" {
			b.CashflowID = &sourceID
		}
		_, err := a.publishCashflow(ctx, b)
		return err
	case "FX_CONVERSION":
		var b FxConversionCreate
		if err := json.Unmarshal(raw, &b); err != nil {
			return badRequest("decode %s body: %v", eventType, err)
		}
		if sourceID != "" {
			b.FxConversionID = &sourceID
		}
		if strings.EqualFold(b.FromCurrency, b.ToCurrency) {
			return badRequest("from_currency and to_currency must differ")
		}
		if err := validateFxRate(b); err != nil {
			return badRequest("%v", err)
		}
		_, err := a.publishFxConversion(ctx, b)
		return err
	case "TRANSFER_IN":
		var b TransferInCreate
		if err := json.Unmarshal(raw, &b); err != nil {
			return badRequest("decode %s body: %v", eventType, err)
		}
		if sourceID != "" {
			b.LotID = &sourceID
		}
		_, err := a.publishTransferIn(ctx, b)
		return err
	case "OPTION_EXERCISE", "OPTION_ASSIGNMENT":
		var b OptionDeliveryCreate
		if err := json.Unmarshal(raw, &b); err != nil {
			return badRequest("decode %s body: %v", eventType, err)
		}
		if sourceID != "" {
			if eventType == "OPTION_EXERCISE" {
				b.ExerciseID = &sourceID
			} else {
				b.AssignmentID = &sourceID
			}
		}
		return a.insertOptionDelivery(ctx, eventType, b)
	case "OPTION_EXPIRY":
		var b OptionExpiryCreate
		if err := json.Unmarshal(raw, &b); err != nil {
			return badRequest("decode %s body: %v", eventType, err)
		}
		if sourceID != "" {
			b.ExpiryID = &sourceID
		}
		return a.insertOptionExpiry(ctx, b)
	default:
		return badRequest("unknown event_type %q", eventType)
	}
}
