package plugin

import (
	"context"
	"net/http"
	"strings"
)

type CashflowCreate struct {
	PortfolioID  string  `json:"portfolio_id"`
	Type         string  `json:"type"`
	AmountNative float64 `json:"amount_native"`
	Currency     string  `json:"currency"`
	UpdatedBy    string  `json:"updated_by"`
	CashflowID   *string `json:"cashflow_id"`
	EventTs      *int64  `json:"event_ts"`
}

type CashflowBulkCreate struct {
	Cashflows []CashflowCreate `json:"cashflows"`
}

type CashflowOut struct {
	PortfolioID   string  `json:"portfolio_id"`
	CashflowID    string  `json:"cashflow_id"`
	Type          string  `json:"type"`
	AmountNative  float64 `json:"amount_native"`
	Currency      string  `json:"currency"`
	EventTs       int64   `json:"event_ts"`
	ObservationID string  `json:"observation_id"`
	GatewayOffset int64   `json:"gateway_offset"`
}

func (a *App) registerCashflowRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/ref/cashflows", a.handleCreateCashflow)
	mux.HandleFunc("/ref/cashflows/bulk", a.handleCashflowsBulk)
}

func (a *App) handleCreateCashflow(w http.ResponseWriter, r *http.Request) {
	if !methodGuard(w, r, http.MethodPost) {
		return
	}
	body, ok := decodeJSON[CashflowCreate](w, r)
	if !ok {
		return
	}
	ctx, ok := a.handlerCtx(w, r)
	if !ok {
		return
	}
	out, err := a.publishCashflow(ctx, body)
	if err != nil {
		respondErr(w, http.StatusBadGateway, err.Error())
		return
	}
	respondJSON(w, http.StatusCreated, out)
}

// handleCashflowsBulk publishes cashflows one at a time. The SDK exposes no
// transaction API, so an error mid-batch leaves a partial insert. Callers
// should treat failures as requiring idempotent retry using the same cashflow_id
// values.
func (a *App) handleCashflowsBulk(w http.ResponseWriter, r *http.Request) {
	if !methodGuard(w, r, http.MethodPost) {
		return
	}
	body, ok := decodeJSON[CashflowBulkCreate](w, r)
	if !ok {
		return
	}
	ctx, ok := a.handlerCtx(w, r)
	if !ok {
		return
	}
	out := make([]CashflowOut, 0, len(body.Cashflows))
	for _, c := range body.Cashflows {
		o, err := a.publishCashflow(ctx, c)
		if err != nil {
			respondErr(w, http.StatusBadGateway, err.Error())
			return
		}
		out = append(out, o)
	}
	respondJSON(w, http.StatusCreated, out)
}

func (a *App) publishCashflow(ctx context.Context, body CashflowCreate) (CashflowOut, error) {
	id := derefStr(body.CashflowID, "")
	if id == "" {
		id = a.newID()
	}
	eventTs := a.now()
	if body.EventTs != nil {
		eventTs = *body.EventTs
	}
	payloadStr, err := marshalPayload(map[string]any{
		"type":          strings.ToUpper(body.Type),
		"amount_native": body.AmountNative,
		"currency":      strings.ToUpper(body.Currency),
	})
	if err != nil {
		return CashflowOut{}, err
	}
	// Cashflows have no instrument_id.
	err = a.insertEvent(ctx, "CASHFLOW", id, body.PortfolioID, nil, eventTs, payloadStr)
	if err != nil {
		return CashflowOut{}, err
	}
	return CashflowOut{
		PortfolioID:   body.PortfolioID,
		CashflowID:    id,
		Type:          strings.ToUpper(body.Type),
		AmountNative:  body.AmountNative,
		Currency:      strings.ToUpper(body.Currency),
		EventTs:       eventTs,
		ObservationID: a.newID(),
		GatewayOffset: 0,
	}, nil
}
