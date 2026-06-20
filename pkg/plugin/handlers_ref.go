package plugin

import (
	"encoding/json"
	"net/http"

	"github.com/google/uuid"
)

// PortfolioEntity matches the frontend's PortfolioEntity (api/reference.ts).
type PortfolioEntity struct {
	PortfolioID  string            `json:"portfolio_id"`
	BaseCurrency string            `json:"base_currency"`
	Attributes   map[string]string `json:"attributes"`
	UpdatedAt    int64             `json:"updated_at"` // epoch micros
}

// InstrumentEntity matches the frontend's InstrumentEntity.
type InstrumentEntity struct {
	InstrumentID       string   `json:"instrument_id"`
	Currency           *string  `json:"currency"`
	Kind               string   `json:"kind"`
	BaseCurrency       *string  `json:"base_currency"`
	Sector             *string  `json:"sector"`
	Subindustry        *string  `json:"subindustry"`
	UnderlyingID       *string  `json:"underlying_id"`
	Strike             *float64 `json:"strike"`
	ExpiryDate         *string  `json:"expiry_date"`
	OptionType         *string  `json:"option_type"`
	ContractMultiplier *float64 `json:"contract_multiplier"`
	UpdatedAt          int64    `json:"updated_at"`
}

// PortfolioCreate is the frontend's POST /ref/portfolios body.
type PortfolioCreate struct {
	PortfolioID  string            `json:"portfolio_id"`
	BaseCurrency string            `json:"base_currency"`
	Attributes   map[string]string `json:"attributes"`
}

// registerRefRoutes wires the frontend-facing reference data BFF.
func (a *App) registerRefRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/ref/portfolios", a.dispatchPortfolios)
	mux.HandleFunc("/ref/portfolios/{id}", a.dispatchPortfolioByID)
	mux.HandleFunc("/ref/instruments", a.dispatchInstruments)
	mux.HandleFunc("/ref/instruments/{id}", a.dispatchInstrumentByID)
}

func (a *App) dispatchPortfolios(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		a.handleListPortfolios(w, r)
	case http.MethodPost:
		a.handleCreatePortfolio(w, r)
	default:
		w.Header().Set("Allow", "GET, POST")
		respondErr(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (a *App) dispatchPortfolioByID(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodDelete {
		respondErr(w, http.StatusNotImplemented, "portfolio delete not implemented")
		return
	}
	respondErr(w, http.StatusMethodNotAllowed, "method not allowed")
}

func (a *App) dispatchInstruments(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		a.handleListInstruments(w, r)
	default:
		w.Header().Set("Allow", "GET")
		respondErr(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (a *App) dispatchInstrumentByID(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodDelete {
		respondErr(w, http.StatusNotImplemented, "instrument delete not implemented")
		return
	}
	respondErr(w, http.StatusMethodNotAllowed, "method not allowed")
}

// --- portfolios -------------------------------------------------------------

func (a *App) handleListPortfolios(w http.ResponseWriter, r *http.Request) {
	ctx, ok := a.handlerCtx(w, r)
	if !ok {
		return
	}
	res, err := a.client.PGQuery(ctx, "SELECT portfolio_id, base_currency, attributes FROM portfolios ORDER BY portfolio_id")
	if err != nil {
		respondErr(w, http.StatusBadGateway, "list portfolios: "+err.Error())
		return
	}
	out := make([]PortfolioEntity, 0, len(res.Rows))
	for _, row := range res.Rows {
		if len(row) < 3 {
			continue
		}
		portfolioID, _ := row[0].(string)
		baseCcy, _ := row[1].(string)
		var attrs map[string]string
		switch v := row[2].(type) {
		case string:
			_ = json.Unmarshal([]byte(v), &attrs)
		case []byte:
			_ = json.Unmarshal(v, &attrs)
		case map[string]interface{}:
			attrs = make(map[string]string, len(v))
			for k, val := range v {
				if s, ok := val.(string); ok {
					attrs[k] = s
				}
			}
		}
		if attrs == nil {
			attrs = map[string]string{}
		}
		out = append(out, PortfolioEntity{PortfolioID: portfolioID, BaseCurrency: baseCcy, Attributes: attrs})
	}
	respondJSON(w, http.StatusOK, out)
}

func (a *App) handleCreatePortfolio(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeJSON[PortfolioCreate](w, r)
	if !ok {
		return
	}
	ctx, ok := a.handlerCtx(w, r)
	if !ok {
		return
	}
	pid := body.PortfolioID
	if pid == "" {
		pid = uuid.NewString()
	}
	attrsJSON, err := json.Marshal(coalesceAttrs(body.Attributes))
	if err != nil {
		respondErr(w, http.StatusInternalServerError, "marshal attributes: "+err.Error())
		return
	}
	_, err = a.client.PGExec(ctx,
		`INSERT INTO portfolios (portfolio_id, base_currency, attributes, updated_by)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (portfolio_id) DO UPDATE
       SET base_currency=EXCLUDED.base_currency,
           attributes=EXCLUDED.attributes,
           updated_at=now(),
           updated_by=EXCLUDED.updated_by`,
		pid, body.BaseCurrency, string(attrsJSON), "core-app",
	)
	if err != nil {
		respondErr(w, http.StatusBadGateway, "create portfolio: "+err.Error())
		return
	}
	respondJSON(w, http.StatusCreated, PortfolioEntity{
		PortfolioID:  pid,
		BaseCurrency: body.BaseCurrency,
		Attributes:   coalesceAttrs(body.Attributes),
	})
}

// --- instruments ------------------------------------------------------------

func (a *App) handleListInstruments(w http.ResponseWriter, r *http.Request) {
	portfolioID := r.URL.Query().Get("portfolio_id")
	if portfolioID == "" {
		respondErr(w, http.StatusBadRequest, "portfolio_id query param required")
		return
	}
	ctx, ok := a.handlerCtx(w, r)
	if !ok {
		return
	}
	// instruments_catalog columns available: instrument_id, kind,
	// contract_multiplier, currency, base_currency. Fields sector,
	// subindustry, underlying_id, strike, expiry_date, option_type do not
	// exist in the view and remain null in the response (frontend type
	// declares them nullable).
	res, err := a.client.Query(ctx,
		`SELECT instrument_id, kind, contract_multiplier, currency, base_currency
		   FROM instruments_catalog
		  WHERE portfolio_id = $1`,
		portfolioID,
	)
	if err != nil {
		respondErr(w, http.StatusBadGateway, "instruments_catalog: "+err.Error())
		return
	}
	out := make([]InstrumentEntity, 0, len(res.Rows))
	for _, row := range res.Rows {
		if len(row) < 5 {
			continue
		}
		instrID, _ := row[0].(string)
		kind, _ := row[1].(string)
		cm := asFloat64Ptr(row[2])
		currency := asStringPtr(row[3])
		baseCcy := asStringPtr(row[4])
		out = append(out, InstrumentEntity{
			InstrumentID:       instrID,
			Kind:               kind,
			ContractMultiplier: cm,
			Currency:           currency,
			BaseCurrency:       baseCcy,
		})
	}
	respondJSON(w, http.StatusOK, out)
}

// asFloat64Ptr converts a pgx numeric value to *float64, returning nil for
// SQL NULL or unexpected types.
func asFloat64Ptr(v any) *float64 {
	switch x := v.(type) {
	case float64:
		return &x
	case float32:
		f := float64(x)
		return &f
	}
	return nil
}

// asStringPtr converts a pgx text value to *string, returning nil for SQL NULL.
func asStringPtr(v any) *string {
	s, ok := v.(string)
	if !ok || s == "" {
		return nil
	}
	return &s
}

// --- helpers ---------------------------------------------------------------

func coalesceAttrs(in map[string]string) map[string]string {
	if in == nil {
		return map[string]string{}
	}
	return in
}
