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
		return "", badRequest("decode event_type: %v", err)
	}
	if strings.TrimSpace(tag.EventType) == "" {
		return "", badRequest("event_type is required")
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
			return badRequest("decode %s body: %v", eventType, err)
		}
		_, err := a.publishTrade(ctx, b)
		return err
	case "DIVIDEND":
		var b DividendCreate
		if err := json.Unmarshal(raw, &b); err != nil {
			return badRequest("decode %s body: %v", eventType, err)
		}
		_, err := a.publishDividend(ctx, b)
		return err
	case "CASHFLOW":
		var b CashflowCreate
		if err := json.Unmarshal(raw, &b); err != nil {
			return badRequest("decode %s body: %v", eventType, err)
		}
		_, err := a.publishCashflow(ctx, b)
		return err
	case "FX_CONVERSION":
		var b FxConversionCreate
		if err := json.Unmarshal(raw, &b); err != nil {
			return badRequest("decode %s body: %v", eventType, err)
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
		_, err := a.publishTransferIn(ctx, b)
		return err
	case "OPTION_EXERCISE", "OPTION_ASSIGNMENT":
		var b OptionDeliveryCreate
		if err := json.Unmarshal(raw, &b); err != nil {
			return badRequest("decode %s body: %v", eventType, err)
		}
		return a.insertOptionDelivery(ctx, eventType, b)
	case "OPTION_EXPIRY":
		var b OptionExpiryCreate
		if err := json.Unmarshal(raw, &b); err != nil {
			return badRequest("decode %s body: %v", eventType, err)
		}
		return a.insertOptionExpiry(ctx, b)
	default:
		return badRequest("unknown event_type %q", eventType)
	}
}
