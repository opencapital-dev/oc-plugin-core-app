package plugin

import (
	"context"
	"net/http"
	"strings"

	"github.com/opencapital-dev/oc-plugin-sdk/pluginclient"
)

// OptionMarkNamespace is the only data.v2 namespace this plugin publishes.
// Mirrors the pre-v6 data.v1 namespace string so RW source_namespace
// projections see byte-identical values.
const OptionMarkNamespace = "prices.option_mark"

// OptionDeliveryCreate covers OPTION_EXERCISE + OPTION_ASSIGNMENT. The
// kind=option pre-check that used to read instruments via PG is dropped —
// canonical instruments live in control_db; the gateway runs the
// existence + ownership check during publish.
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
	InstrumentID    string `json:"instrument_id"`
	ObservedAt      int64  `json:"observed_at"`
	Close           float64 `json:"close"`
	Currency        string `json:"currency"`
	SourceNamespace string `json:"source_namespace"`
	GatewayOffset   int64  `json:"gateway_offset"`
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
	var route string
	switch eventType {
	case "OPTION_EXERCISE":
		route = "option-exercises"
	case "OPTION_ASSIGNMENT":
		route = "option-assignments"
	default:
		respondErr(w, http.StatusInternalServerError, "unknown option delivery event type: "+eventType)
		return
	}
	payloadStr, payloadErr := marshalPayload(map[string]any{
		"underlying_id":    ptrStr(body.UnderlyingID),
		"settlement_price": body.SettlementPrice,
		"delivered_qty":    body.DeliveredQty,
		"delivered_side":   strings.ToLower(body.DeliveredSide),
		"currency":         strings.ToUpper(body.Currency),
	})
	if payloadErr != nil {
		respondErr(w, http.StatusInternalServerError, payloadErr.Error())
		return
	}
	instrumentID := body.InstrumentID
	result, err := a.client.PublishPortfolioEvent(ctx, route, pluginclient.PortfolioEventBody{
		SourceID:     srcID,
		PortfolioID:  body.PortfolioID,
		InstrumentID: &instrumentID,
		BusinessTs:   eventTs,
		Payload:      payloadStr,
	})
	if err != nil {
		respondErr(w, http.StatusBadGateway, err.Error())
		return
	}
	var offset int64
	if result != nil {
		offset = result.Offset
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
		GatewayOffset:   offset,
	})
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
	srcID := derefStr(body.ExpiryID, "")
	if srcID == "" {
		srcID = a.newID()
	}
	eventTs := a.now()
	if body.EventTs != nil {
		eventTs = *body.EventTs
	}
	payloadStr, payloadErr := marshalPayload(map[string]any{
		"currency": strings.ToUpper(body.Currency),
	})
	if payloadErr != nil {
		respondErr(w, http.StatusInternalServerError, payloadErr.Error())
		return
	}
	instrumentID := body.InstrumentID
	result, err := a.client.PublishPortfolioEvent(ctx, "option-expiries", pluginclient.PortfolioEventBody{
		SourceID:     srcID,
		PortfolioID:  body.PortfolioID,
		InstrumentID: &instrumentID,
		BusinessTs:   eventTs,
		Payload:      payloadStr,
	})
	if err != nil {
		respondErr(w, http.StatusBadGateway, err.Error())
		return
	}
	var offset int64
	if result != nil {
		offset = result.Offset
	}
	respondJSON(w, http.StatusCreated, OptionLifecycleOut{
		PortfolioID:   body.PortfolioID,
		InstrumentID:  body.InstrumentID,
		EventType:     "OPTION_EXPIRY",
		SourceID:      srcID,
		Currency:      strings.ToUpper(body.Currency),
		EventTs:       eventTs,
		ObservationID: a.newID(),
		GatewayOffset: offset,
	})
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
	gatewayBody := map[string]any{
		"source_id":   body.InstrumentID,
		"observed_at": body.ObservedAt,
		"updated_by":  body.UpdatedBy,
		"payload": map[string]any{
			"close":    body.Close,
			"currency": strings.ToUpper(body.Currency),
		},
	}
	result, err := a.publishDataMark(ctx, gatewayBody)
	if err != nil {
		respondErr(w, http.StatusBadGateway, err.Error())
		return
	}
	var offset int64
	if result != nil {
		offset = result.Offset
	}
	respondJSON(w, http.StatusCreated, OptionMarkOut{
		InstrumentID:    body.InstrumentID,
		ObservedAt:      body.ObservedAt,
		Close:           body.Close,
		Currency:        strings.ToUpper(body.Currency),
		SourceNamespace: OptionMarkNamespace,
		GatewayOffset:   offset,
	})
}

// publishDataMark is the wrapper that routes the option-mark publish to
// the right data.v2 namespace. Single hot site, but extracted for tests.
func (a *App) publishDataMark(ctx context.Context, body map[string]any) (*pubResult, error) {
	res, err := a.client.PublishData(ctx, OptionMarkNamespace, body)
	if err != nil {
		return nil, err
	}
	return &pubResult{Offset: res.Offset}, nil
}

// pubResult mirrors the subset of pluginclient.PublishResult tests need.
type pubResult struct {
	Offset int64
}
