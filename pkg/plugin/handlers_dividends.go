package plugin

import (
	"context"
	"net/http"
	"strings"
)

type DividendCreate struct {
	PortfolioID       string   `json:"portfolio_id"`
	InstrumentID      string   `json:"instrument_id"`
	GrossNative       float64  `json:"gross_native"`
	Currency          string   `json:"currency"`
	UpdatedBy         string   `json:"updated_by"`
	WithholdingNative *float64 `json:"withholding_native"`
	DividendID        *string  `json:"dividend_id"`
	EventTs           *int64   `json:"event_ts"`
	FxRateToBase      *float64 `json:"fx_rate_to_base"`
	FxFeesNative      *float64 `json:"fx_fees_native"`
	FxFeesCurrency    *string  `json:"fx_fees_currency"`
}

type DividendBulkCreate struct {
	Dividends []DividendCreate `json:"dividends"`
}

type DividendOut struct {
	PortfolioID       string   `json:"portfolio_id"`
	InstrumentID      string   `json:"instrument_id"`
	DividendID        string   `json:"dividend_id"`
	GrossNative       float64  `json:"gross_native"`
	WithholdingNative *float64 `json:"withholding_native"`
	Currency          string   `json:"currency"`
	EventTs           int64    `json:"event_ts"`
	ObservationID     string   `json:"observation_id"`
	GatewayOffset     int64    `json:"gateway_offset"`
}

func (a *App) registerDividendRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/ref/dividends", a.handleCreateDividend)
	mux.HandleFunc("/ref/dividends/bulk", a.handleDividendsBulk)
}

func (a *App) handleCreateDividend(w http.ResponseWriter, r *http.Request) {
	if !methodGuard(w, r, http.MethodPost) {
		return
	}
	body, ok := decodeJSON[DividendCreate](w, r)
	if !ok {
		return
	}
	ctx, ok := a.handlerCtx(w, r)
	if !ok {
		return
	}
	out, err := a.publishDividend(ctx, body)
	if err != nil {
		respondErr(w, http.StatusBadGateway, err.Error())
		return
	}
	respondJSON(w, http.StatusCreated, out)
}

// handleDividendsBulk publishes dividends one at a time. The SDK exposes no
// transaction API, so an error mid-batch leaves a partial insert. Callers
// should treat failures as requiring idempotent retry using the same dividend_id
// values.
func (a *App) handleDividendsBulk(w http.ResponseWriter, r *http.Request) {
	if !methodGuard(w, r, http.MethodPost) {
		return
	}
	body, ok := decodeJSON[DividendBulkCreate](w, r)
	if !ok {
		return
	}
	ctx, ok := a.handlerCtx(w, r)
	if !ok {
		return
	}
	out := make([]DividendOut, 0, len(body.Dividends))
	for _, d := range body.Dividends {
		o, err := a.publishDividend(ctx, d)
		if err != nil {
			respondErr(w, http.StatusBadGateway, err.Error())
			return
		}
		out = append(out, o)
	}
	respondJSON(w, http.StatusCreated, out)
}

func (a *App) publishDividend(ctx context.Context, body DividendCreate) (DividendOut, error) {
	id := derefStr(body.DividendID, "")
	if id == "" {
		id = a.newID()
	}
	eventTs := a.now()
	if body.EventTs != nil {
		eventTs = *body.EventTs
	}
	payloadStr, err := marshalPayload(map[string]any{
		"gross_native":       body.GrossNative,
		"withholding_native": body.WithholdingNative,
		"currency":           strings.ToUpper(body.Currency),
		"fx_rate_to_base":    body.FxRateToBase,
		"fx_fees_native":     body.FxFeesNative,
		"fx_fees_currency":   optionalUpper(body.FxFeesCurrency),
	})
	if err != nil {
		return DividendOut{}, err
	}
	instrumentID := body.InstrumentID
	err = a.insertEvent(ctx, "DIVIDEND", id, body.PortfolioID, &instrumentID, eventTs, payloadStr)
	if err != nil {
		return DividendOut{}, err
	}
	return DividendOut{
		PortfolioID:       body.PortfolioID,
		InstrumentID:      body.InstrumentID,
		DividendID:        id,
		GrossNative:       body.GrossNative,
		WithholdingNative: body.WithholdingNative,
		Currency:          strings.ToUpper(body.Currency),
		EventTs:           eventTs,
		ObservationID:     a.newID(),
		GatewayOffset:     0,
	}, nil
}
