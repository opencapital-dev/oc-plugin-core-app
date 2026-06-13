package plugin

import (
	"context"
	"net/http"

	"github.com/google/uuid"

	"github.com/ignacioballester/oc-plugin-sdk/pluginclient"
)

// PortfolioEntity matches the frontend's PortfolioEntity (api/reference.ts).
// org_id is intentionally omitted — the per-tenant RW view (`portfolios_v`)
// already filters to the JWT's org.
type PortfolioEntity struct {
	PortfolioID  string            `json:"portfolio_id"`
	BaseCurrency string            `json:"base_currency"`
	Attributes   map[string]string `json:"attributes"`
	UpdatedAt    int64             `json:"updated_at"` // epoch micros
}

// InstrumentEntity matches the frontend's InstrumentEntity.
type InstrumentEntity struct {
	InstrumentID       string  `json:"instrument_id"`
	Currency           *string `json:"currency"`
	Kind               string  `json:"kind"`
	BaseCurrency       *string `json:"base_currency"`
	Sector             *string `json:"sector"`
	Subindustry        *string `json:"subindustry"`
	UnderlyingID       *string `json:"underlying_id"`
	Strike             *float64 `json:"strike"`
	ExpiryDate         *string `json:"expiry_date"`
	OptionType         *string `json:"option_type"`
	ContractMultiplier *float64 `json:"contract_multiplier"`
	UpdatedAt          int64    `json:"updated_at"`
}

// PortfolioCreate is the frontend's POST /ref/portfolios body.
type PortfolioCreate struct {
	PortfolioID  string            `json:"portfolio_id"`
	BaseCurrency string            `json:"base_currency"`
	Attributes   map[string]string `json:"attributes"`
}

// registerRefRoutes wires the frontend-facing reference data BFF: reads
// come from the per-tenant RW logical views (filtered by org_id at view
// definition time); writes are forwarded to the control plane (the canonical
// owner of `portfolios` since v6 Phase 2). Instruments are event-derived and
// read from `instrument_per_event_v` — no write path.
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
		respondErr(w, http.StatusNotImplemented, "portfolio delete not implemented in v6")
		return
	}
	w.Header().Set("Allow", "DELETE")
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
		respondErr(w, http.StatusNotImplemented, "instrument delete not implemented in v6")
		return
	}
	w.Header().Set("Allow", "DELETE")
	respondErr(w, http.StatusMethodNotAllowed, "method not allowed")
}

// --- portfolios -------------------------------------------------------------

func (a *App) handleListPortfolios(w http.ResponseWriter, r *http.Request) {
	ctx, ok := a.handlerCtx(w, r)
	if !ok {
		return
	}
	// Reference reads come from the canonical control plane (Track 1), not
	// the RW portfolios_v view: the write committed to control_db, so reading
	// it back here is read-your-write consistent and free of the CDC-lag race
	// that made a just-created portfolio briefly invisible. portfolios_v stays
	// for dashboard/cross-plugin joins; only this admin read moved.
	out := []PortfolioEntity{}
	if err := a.client.ControlPlaneCall(ctx, http.MethodGet, "/portfolios", nil, &out); err != nil {
		respondErr(w, http.StatusBadGateway, "control-plane list portfolios: "+err.Error())
		return
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
	idn, _ := identityFromCtx(ctx)
	cpBody := map[string]any{
		"org_id":        idn.OrgID,
		"portfolio_id":  pid,
		"base_currency": body.BaseCurrency,
		"attributes":    body.Attributes,
	}
	var resp struct {
		PortfolioID string `json:"portfolio_id"`
	}
	if err := a.client.ControlPlaneCall(ctx, http.MethodPost, "/portfolios", cpBody, &resp); err != nil {
		respondErr(w, http.StatusBadGateway, "control-plane create portfolio: "+err.Error())
		return
	}
	respondJSON(w, http.StatusCreated, PortfolioEntity{
		PortfolioID:  resp.PortfolioID,
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
	// Instruments are event-derived: the distinct instruments this portfolio
	// has ever held, with their event-carried kind + contract_multiplier.
	// Read org-wide via read-gateway and filter to this portfolio client-side
	// (an org-scoped selector avoids a portfolio-ownership round-trip).
	res, err := a.client.ReadGatewayQuery(ctx, pluginclient.ReadGatewayRequest{
		Bindings:   []pluginclient.ReadGatewayBinding{{Name: "A", Selector: `instruments_used{} @latest`}},
		OutputMode: "table",
		To:         nowMicros(),
	})
	if err != nil {
		respondErr(w, http.StatusBadGateway, "read-gateway: "+err.Error())
		return
	}
	col := refColIndex(res.Columns)
	out := []InstrumentEntity{}
	for _, row := range res.Rows {
		if refCell(row, col, "portfolio_id") != portfolioID {
			continue
		}
		e := InstrumentEntity{
			InstrumentID: refCell(row, col, "instrument_id"),
			Kind:         refCell(row, col, "kind"),
		}
		if i, ok := col["contract_multiplier"]; ok {
			if cm, ok := row[i].(float64); ok {
				e.ContractMultiplier = &cm
			}
		}
		out = append(out, e)
	}
	respondJSON(w, http.StatusOK, out)
}

func refColIndex(cols []pluginclient.ReadGatewayColumn) map[string]int {
	idx := make(map[string]int, len(cols))
	for i, c := range cols {
		idx[c.Name] = i
	}
	return idx
}

func refCell(row []any, col map[string]int, name string) string {
	if i, ok := col[name]; ok {
		if s, ok := row[i].(string); ok {
			return s
		}
	}
	return ""
}

// --- helpers ---------------------------------------------------------------

func coalesceAttrs(in map[string]string) map[string]string {
	if in == nil {
		return map[string]string{}
	}
	return in
}

// identityFromCtx wraps pluginclient.IdentityFrom so the *_org_id reads
// like a domain helper.
func identityFromCtx(ctx context.Context) (struct {
	OrgID  string
	UserID string
}, bool) {
	id, err := pluginclient.IdentityFrom(ctx)
	if err != nil {
		return struct {
			OrgID  string
			UserID string
		}{}, false
	}
	return struct {
		OrgID  string
		UserID string
	}{OrgID: id.OrgID.String(), UserID: id.UserID}, true
}
