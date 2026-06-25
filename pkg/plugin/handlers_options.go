package plugin

import (
	"context"
	"net/http"
	"strings"
)

// OptionMarkNamespace is the only data.v2 namespace this plugin publishes.
// Mirrors the pre-v6 data.v1 namespace string so RW source_namespace
// projections see byte-identical values.
const OptionMarkNamespace = "prices.option_mark"

// OptionDeliveryCreate covers OPTION_EXERCISE + OPTION_ASSIGNMENT.
type OptionDeliveryCreate struct {
	PortfolioID     string  `json:"portfolio_id"`
	InstrumentID    string  `json:"instrument_id"`
	UnderlyingID    string  `json:"underlying_id"`
	SettlementPrice float64 `json:"settlement_price"`
	DeliveredQty    float64 `json:"delivered_qty"`
	DeliveredSide   string  `json:"delivered_side"`
	Currency        string  `json:"currency"`
	UpdatedBy       string  `json:"updated_by"`
	EventTs         *int64  `json:"event_ts"`
	ExerciseID      *string `json:"exercise_id"`
	AssignmentID    *string `json:"assignment_id"`
}

type OptionExpiryCreate struct {
	PortfolioID  string  `json:"portfolio_id"`
	InstrumentID string  `json:"instrument_id"`
	Currency     string  `json:"currency"`
	UpdatedBy    string  `json:"updated_by"`
	EventTs      *int64  `json:"event_ts"`
	ExpiryID     *string `json:"expiry_id"`
}

type OptionLifecycleOut struct {
	PortfolioID     string   `json:"portfolio_id"`
	InstrumentID    string   `json:"instrument_id"`
	EventType       string   `json:"event_type"`
	SourceID        string   `json:"source_id"`
	UnderlyingID    *string  `json:"underlying_id"`
	SettlementPrice *float64 `json:"settlement_price"`
	DeliveredQty    *float64 `json:"delivered_qty"`
	DeliveredSide   *string  `json:"delivered_side"`
	Currency        string   `json:"currency"`
	EventTs         int64    `json:"event_ts"`
	ObservationID   string   `json:"observation_id"`
	GatewayOffset   int64    `json:"gateway_offset"`
}

type OptionMarkCreate struct {
	InstrumentID string  `json:"instrument_id"`
	ObservedAt   int64   `json:"observed_at"`
	Close        float64 `json:"close"`
	Currency     string  `json:"currency"`
	UpdatedBy    string  `json:"updated_by"`
}

type OptionMarkOut struct {
	InstrumentID    string  `json:"instrument_id"`
	ObservedAt      int64   `json:"observed_at"`
	Close           float64 `json:"close"`
	Currency        string  `json:"currency"`
	SourceNamespace string  `json:"source_namespace"`
	GatewayOffset   int64   `json:"gateway_offset"`
}

func (a *App) registerOptionLifecycleRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/ref/option_exercises", a.handleOptionExercise)
	mux.HandleFunc("/ref/option_assignments", a.handleOptionAssignment)
	mux.HandleFunc("/ref/option_expiries", a.handleOptionExpiry)
}

func (a *App) registerOptionMarkRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/ref/option_marks", a.handleOptionMark)
}

func (a *App) handleOptionExercise(w http.ResponseWriter, r *http.Request) {
	a.handleOptionDelivery(w, r, "OPTION_EXERCISE")
}

func (a *App) handleOptionAssignment(w http.ResponseWriter, r *http.Request) {
	a.handleOptionDelivery(w, r, "OPTION_ASSIGNMENT")
}

func (a *App) handleOptionDelivery(w http.ResponseWriter, r *http.Request, eventType string) {
	if !methodGuard(w, r, http.MethodPost) {
		return
	}
	body, ok := decodeJSON[OptionDeliveryCreate](w, r)
	if !ok {
		return
	}
	if body.SettlementPrice < 0 {
		respondErr(w, http.StatusBadRequest, "settlement_price must be >= 0")
		return
	}
	ctx, ok := a.handlerCtx(w, r)
	if !ok {
		return
	}
	// Pre-compute srcID and eventTs so we can echo them in the response.
	// Inject any freshly-generated values back into the body so that
	// insertOptionDelivery (which re-derives from body fields) uses the
	// same values and the DB row matches what we report.
	srcID := derefStr(body.ExerciseID, "")
	if srcID == "" {
		srcID = derefStr(body.AssignmentID, "")
	}
	if srcID == "" {
		newID := a.newID()
		srcID = newID
		body.ExerciseID = &newID
	}
	eventTs := a.now()
	if body.EventTs != nil {
		eventTs = *body.EventTs
	} else {
		body.EventTs = &eventTs
	}
	if err := a.insertOptionDelivery(ctx, eventType, body); err != nil {
		respondErr(w, http.StatusBadGateway, err.Error())
		return
	}
	underlying := body.UnderlyingID
	delSide := strings.ToLower(body.DeliveredSide)
	respondJSON(w, http.StatusCreated, OptionLifecycleOut{
		PortfolioID:     body.PortfolioID,
		InstrumentID:    body.InstrumentID,
		EventType:       eventType,
		SourceID:        srcID,
		UnderlyingID:    &underlying,
		SettlementPrice: &body.SettlementPrice,
		DeliveredQty:    &body.DeliveredQty,
		DeliveredSide:   &delSide,
		Currency:        strings.ToUpper(body.Currency),
		EventTs:         eventTs,
		ObservationID:   a.newID(),
		GatewayOffset:   0,
	})
}

// insertOptionDelivery upserts an OPTION_EXERCISE/OPTION_ASSIGNMENT event.
func (a *App) insertOptionDelivery(ctx context.Context, eventType string, body OptionDeliveryCreate) error {
	if body.SettlementPrice < 0 {
		return validationError{msg: "settlement_price must be >= 0"}
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

func (a *App) handleOptionExpiry(w http.ResponseWriter, r *http.Request) {
	if !methodGuard(w, r, http.MethodPost) {
		return
	}
	body, ok := decodeJSON[OptionExpiryCreate](w, r)
	if !ok {
		return
	}
	ctx, ok := a.handlerCtx(w, r)
	if !ok {
		return
	}
	// Pre-compute srcID and eventTs so we can echo them in the response.
	// Inject freshly-generated values back into body so insertOptionExpiry
	// uses the same values.
	srcID := derefStr(body.ExpiryID, "")
	if srcID == "" {
		newID := a.newID()
		srcID = newID
		body.ExpiryID = &newID
	}
	eventTs := a.now()
	if body.EventTs != nil {
		eventTs = *body.EventTs
	} else {
		body.EventTs = &eventTs
	}
	if err := a.insertOptionExpiry(ctx, body); err != nil {
		respondErr(w, http.StatusBadGateway, err.Error())
		return
	}
	respondJSON(w, http.StatusCreated, OptionLifecycleOut{
		PortfolioID:   body.PortfolioID,
		InstrumentID:  body.InstrumentID,
		EventType:     "OPTION_EXPIRY",
		SourceID:      srcID,
		Currency:      strings.ToUpper(body.Currency),
		EventTs:       eventTs,
		ObservationID: a.newID(),
		GatewayOffset: 0,
	})
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

func (a *App) handleOptionMark(w http.ResponseWriter, r *http.Request) {
	if !methodGuard(w, r, http.MethodPost) {
		return
	}
	body, ok := decodeJSON[OptionMarkCreate](w, r)
	if !ok {
		return
	}
	ctx, ok := a.handlerCtx(w, r)
	if !ok {
		return
	}
	payloadStr, err := marshalPayload(map[string]any{
		"close":    body.Close,
		"currency": strings.ToUpper(body.Currency),
	})
	if err != nil {
		respondErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	// Option marks are not portfolio-scoped; portfolioID = "".
	if err := a.insertData(ctx, OptionMarkNamespace, body.InstrumentID, "", body.ObservedAt, payloadStr); err != nil {
		respondErr(w, http.StatusBadGateway, err.Error())
		return
	}
	respondJSON(w, http.StatusCreated, OptionMarkOut{
		InstrumentID:    body.InstrumentID,
		ObservedAt:      body.ObservedAt,
		Close:           body.Close,
		Currency:        strings.ToUpper(body.Currency),
		SourceNamespace: OptionMarkNamespace,
		GatewayOffset:   0,
	})
}
