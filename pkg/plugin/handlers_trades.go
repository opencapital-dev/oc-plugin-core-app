package plugin

import (
	"context"
	"net/http"
	"strings"

	"github.com/ignacioballester/oc-plugin-sdk/pluginclient"
)

// TradeCreate is the POST /trades body. The gateway injects org_id +
// source + ingest_ts from the session JWT; the plugin must not set them.
type TradeCreate struct {
	PortfolioID    string   `json:"portfolio_id"`
	InstrumentID   string   `json:"instrument_id"`
	Side           string   `json:"side"`
	Price          float64  `json:"price"`
	Quantity       float64  `json:"quantity"`
	Currency       string   `json:"currency"`
	Venue          string   `json:"venue"`
	UpdatedBy      string   `json:"updated_by"`
	TradeID        *string  `json:"trade_id"`
	EventTs        *int64   `json:"event_ts"`
	Commission     *float64 `json:"commission"`
	Fees           *float64 `json:"fees"`
	FxRateToBase   *float64 `json:"fx_rate_to_base"`
	FxFeesNative   *float64 `json:"fx_fees_native"`
	FxFeesCurrency *string  `json:"fx_fees_currency"`
	// Self-describing identity: forwarded into the event payload so the calc
	// pipeline derives kind/contract_multiplier from the event stream. nil ->
	// JSON null -> the instruments MV defaults equity/1.
	InstrumentKind     *string  `json:"instrument_kind"`
	ContractMultiplier *float64 `json:"contract_multiplier"`
}

type TradeBulkCreate struct {
	Trades []TradeCreate `json:"trades"`
}

// TradeCorrectionCreate matches the legacy /trades/{id}/corrections body.
// Retained at the handler layer for back-compat; the gateway side has no
// correction_of column in v2 — the field is dropped before publish.
type TradeCorrectionCreate struct {
	PortfolioID    string   `json:"portfolio_id"`
	InstrumentID   string   `json:"instrument_id"`
	Side           string   `json:"side"`
	Price          float64  `json:"price"`
	Quantity       float64  `json:"quantity"`
	Currency       string   `json:"currency"`
	Venue          string   `json:"venue"`
	EventTs        int64    `json:"event_ts"`
	UpdatedBy      string   `json:"updated_by"`
	Commission     *float64 `json:"commission"`
	Fees           *float64 `json:"fees"`
	FxRateToBase   *float64 `json:"fx_rate_to_base"`
	FxFeesNative   *float64 `json:"fx_fees_native"`
	FxFeesCurrency *string  `json:"fx_fees_currency"`
}

// TradeOut is the POST /trades response shape. Field names match
// src/api/reference.ts.
type TradeOut struct {
	PortfolioID        string  `json:"portfolio_id"`
	InstrumentID       string  `json:"instrument_id"`
	TradeID            string  `json:"trade_id"`
	Side               string  `json:"side"`
	TradeQuantity      float64 `json:"trade_quantity"`
	DeltaQuantity      float64 `json:"delta_quantity"`
	EventTs            int64   `json:"event_ts"`
	TradeObservationID string  `json:"trade_observation_id"`
	GatewayOffset      int64   `json:"gateway_offset"`
}

func (a *App) registerTradeRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/ref/trades", a.dispatchTradesRoot)
	mux.HandleFunc("/ref/trades/bulk", a.handleTradesBulk)
	mux.HandleFunc("/ref/trades/{id}/corrections", a.handleTradeCorrection)
}

func (a *App) dispatchTradesRoot(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		respondErr(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	a.handleCreateTrade(w, r)
}

func (a *App) handleCreateTrade(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeJSON[TradeCreate](w, r)
	if !ok {
		return
	}
	ctx, ok := a.handlerCtx(w, r)
	if !ok {
		return
	}
	out, err := a.publishTrade(ctx, body)
	if err != nil {
		respondErr(w, http.StatusBadGateway, err.Error())
		return
	}
	respondJSON(w, http.StatusCreated, out)
}

func (a *App) handleTradesBulk(w http.ResponseWriter, r *http.Request) {
	if !methodGuard(w, r, http.MethodPost) {
		return
	}
	body, ok := decodeJSON[TradeBulkCreate](w, r)
	if !ok {
		return
	}
	ctx, ok := a.handlerCtx(w, r)
	if !ok {
		return
	}
	out := make([]TradeOut, 0, len(body.Trades))
	for _, t := range body.Trades {
		o, err := a.publishTrade(ctx, t)
		if err != nil {
			respondErr(w, http.StatusBadGateway, err.Error())
			return
		}
		out = append(out, o)
	}
	respondJSON(w, http.StatusCreated, out)
}

// handleTradeCorrection: v2 portfolio_events drops correction_of (ADR-0037).
// The endpoint stays for client back-compat but publishes a normal TRADE.
func (a *App) handleTradeCorrection(w http.ResponseWriter, r *http.Request) {
	if !methodGuard(w, r, http.MethodPost) {
		return
	}
	body, ok := decodeJSON[TradeCorrectionCreate](w, r)
	if !ok {
		return
	}
	ctx, ok := a.handlerCtx(w, r)
	if !ok {
		return
	}
	tc := TradeCreate{
		PortfolioID:    body.PortfolioID,
		InstrumentID:   body.InstrumentID,
		Side:           body.Side,
		Price:          body.Price,
		Quantity:       body.Quantity,
		Currency:       body.Currency,
		Venue:          body.Venue,
		UpdatedBy:      body.UpdatedBy,
		EventTs:        &body.EventTs,
		Commission:     body.Commission,
		Fees:           body.Fees,
		FxRateToBase:   body.FxRateToBase,
		FxFeesNative:   body.FxFeesNative,
		FxFeesCurrency: body.FxFeesCurrency,
	}
	out, err := a.publishTrade(ctx, tc)
	if err != nil {
		respondErr(w, http.StatusBadGateway, err.Error())
		return
	}
	respondJSON(w, http.StatusCreated, out)
}

// publishTrade marshals the typed body into the gateway's portfolio_events
// JSON shape and posts. The gateway runs schema validation, portfolio_id
// ownership check, org_id injection, and Avro serialization — the plugin
// just delivers the typed payload.
func (a *App) publishTrade(ctx context.Context, body TradeCreate) (TradeOut, error) {
	tradeID := derefStr(body.TradeID, "")
	if tradeID == "" {
		tradeID = a.newID()
	}
	eventTs := a.now()
	if body.EventTs != nil {
		eventTs = *body.EventTs
	}
	payloadStr, err := marshalPayload(map[string]any{
		"side":                strings.ToLower(body.Side),
		"price":               body.Price,
		"quantity":            body.Quantity,
		"currency":            strings.ToUpper(body.Currency),
		"venue":               body.Venue,
		"commission":          body.Commission,
		"fees":                body.Fees,
		"fx_rate_to_base":     body.FxRateToBase,
		"fx_fees_native":      body.FxFeesNative,
		"fx_fees_currency":    optionalUpper(body.FxFeesCurrency),
		"instrument_kind":     body.InstrumentKind,
		"contract_multiplier": body.ContractMultiplier,
	})
	if err != nil {
		return TradeOut{}, err
	}
	instrumentID := body.InstrumentID
	result, err := a.client.PublishPortfolioEvent(ctx, "trades", pluginclient.PortfolioEventBody{
		SourceID:     tradeID,
		PortfolioID:  body.PortfolioID,
		InstrumentID: &instrumentID,
		BusinessTs:   eventTs,
		Payload:      payloadStr,
	})
	if err != nil {
		return TradeOut{}, err
	}
	delta := body.Quantity
	if strings.EqualFold(body.Side, "sell") {
		delta = -delta
	}
	var offset int64
	if result != nil {
		offset = result.Offset
	}
	return TradeOut{
		PortfolioID:        body.PortfolioID,
		InstrumentID:       body.InstrumentID,
		TradeID:            tradeID,
		Side:               strings.ToLower(body.Side),
		TradeQuantity:      body.Quantity,
		DeltaQuantity:      delta,
		EventTs:            eventTs,
		TradeObservationID: a.newID(),
		GatewayOffset:      offset,
	}, nil
}

func optionalUpper(p *string) *string {
	if p == nil || *p == "" {
		return nil
	}
	v := strings.ToUpper(*p)
	return &v
}
