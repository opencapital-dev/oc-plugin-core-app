package plugin

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"strings"
)

const fxRateRelativeTolerance = 1e-4

type FxConversionCreate struct {
	PortfolioID    string   `json:"portfolio_id"`
	FromCurrency   string   `json:"from_currency"`
	FromAmount     float64  `json:"from_amount"`
	ToCurrency     string   `json:"to_currency"`
	ToAmount       float64  `json:"to_amount"`
	Rate           float64  `json:"rate"`
	UpdatedBy      string   `json:"updated_by"`
	FeesNative     *float64 `json:"fees_native"`
	FeesCurrency   *string  `json:"fees_currency"`
	FxConversionID *string  `json:"fx_conversion_id"`
	EventTs        *int64   `json:"event_ts"`
}

type FxConversionBulkCreate struct {
	FxConversions []FxConversionCreate `json:"fx_conversions"`
}

type FxConversionOut struct {
	PortfolioID    string   `json:"portfolio_id"`
	FxConversionID string   `json:"fx_conversion_id"`
	FromCurrency   string   `json:"from_currency"`
	FromAmount     float64  `json:"from_amount"`
	ToCurrency     string   `json:"to_currency"`
	ToAmount       float64  `json:"to_amount"`
	Rate           float64  `json:"rate"`
	FeesNative     *float64 `json:"fees_native"`
	FeesCurrency   *string  `json:"fees_currency"`
	EventTs        int64    `json:"event_ts"`
	ObservationID  string   `json:"observation_id"`
	GatewayOffset  int64    `json:"gateway_offset"`
}

func (a *App) registerFxConversionRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/ref/fx-conversions", a.handleCreateFxConversion)
	mux.HandleFunc("/ref/fx-conversions/bulk", a.handleFxConversionsBulk)
}

func (a *App) handleCreateFxConversion(w http.ResponseWriter, r *http.Request) {
	if !methodGuard(w, r, http.MethodPost) {
		return
	}
	body, ok := decodeJSON[FxConversionCreate](w, r)
	if !ok {
		return
	}
	if strings.EqualFold(body.FromCurrency, body.ToCurrency) {
		respondErr(w, http.StatusUnprocessableEntity, "from_currency and to_currency must differ")
		return
	}
	if err := validateFxRate(body); err != nil {
		respondErr(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx, ok := a.handlerCtx(w, r)
	if !ok {
		return
	}
	out, err := a.publishFxConversion(ctx, body)
	if err != nil {
		respondErr(w, http.StatusBadGateway, err.Error())
		return
	}
	respondJSON(w, http.StatusCreated, out)
}

// handleFxConversionsBulk publishes FX conversions one at a time. The SDK
// exposes no transaction API, so an error mid-batch leaves a partial insert.
// Callers should treat failures as requiring idempotent retry using the same
// fx_conversion_id values.
func (a *App) handleFxConversionsBulk(w http.ResponseWriter, r *http.Request) {
	if !methodGuard(w, r, http.MethodPost) {
		return
	}
	body, ok := decodeJSON[FxConversionBulkCreate](w, r)
	if !ok {
		return
	}
	for i, c := range body.FxConversions {
		if err := validateFxRate(c); err != nil {
			respondErr(w, http.StatusBadRequest, fmt.Sprintf("row %d: %s", i, err.Error()))
			return
		}
	}
	ctx, ok := a.handlerCtx(w, r)
	if !ok {
		return
	}
	out := make([]FxConversionOut, 0, len(body.FxConversions))
	for _, c := range body.FxConversions {
		o, err := a.publishFxConversion(ctx, c)
		if err != nil {
			respondErr(w, http.StatusBadGateway, err.Error())
			return
		}
		out = append(out, o)
	}
	respondJSON(w, http.StatusCreated, out)
}

func validateFxRate(c FxConversionCreate) error {
	if c.FromAmount <= 0 || c.ToAmount <= 0 || c.Rate <= 0 {
		return fmt.Errorf("from_amount/to_amount/rate must be > 0")
	}
	derived := c.ToAmount / c.FromAmount
	if math.Abs(derived-c.Rate)/c.Rate > fxRateRelativeTolerance {
		return fmt.Errorf("rate %.10f does not match to_amount/from_amount %.10f", c.Rate, derived)
	}
	return nil
}

func (a *App) publishFxConversion(ctx context.Context, body FxConversionCreate) (FxConversionOut, error) {
	id := derefStr(body.FxConversionID, "")
	if id == "" {
		id = a.newID()
	}
	eventTs := a.now()
	if body.EventTs != nil {
		eventTs = *body.EventTs
	}
	payloadStr, err := marshalPayload(map[string]any{
		"from_currency": strings.ToUpper(body.FromCurrency),
		"from_amount":   body.FromAmount,
		"to_currency":   strings.ToUpper(body.ToCurrency),
		"to_amount":     body.ToAmount,
		"rate":          body.Rate,
		"fees_native":   body.FeesNative,
		"fees_currency": optionalUpper(body.FeesCurrency),
	})
	if err != nil {
		return FxConversionOut{}, err
	}
	// FX conversions have no instrument_id.
	err = a.insertEvent(ctx, "FX_CONVERSION", id, body.PortfolioID, nil, eventTs, payloadStr)
	if err != nil {
		return FxConversionOut{}, err
	}
	return FxConversionOut{
		PortfolioID:    body.PortfolioID,
		FxConversionID: id,
		FromCurrency:   strings.ToUpper(body.FromCurrency),
		FromAmount:     body.FromAmount,
		ToCurrency:     strings.ToUpper(body.ToCurrency),
		ToAmount:       body.ToAmount,
		Rate:           body.Rate,
		FeesNative:     body.FeesNative,
		FeesCurrency:   optionalUpper(body.FeesCurrency),
		EventTs:        eventTs,
		ObservationID:  a.newID(),
		GatewayOffset:  0,
	}, nil
}
