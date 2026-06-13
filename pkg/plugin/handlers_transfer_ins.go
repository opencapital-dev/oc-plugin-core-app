package plugin

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"github.com/ignacioballester/oc-plugin-sdk/pluginclient"
)

type TransferInCreate struct {
	PortfolioID         string   `json:"portfolio_id"`
	InstrumentID        string   `json:"instrument_id"`
	Quantity            float64  `json:"quantity"`
	CostBasisNative     float64  `json:"cost_basis_native"`
	Currency            string   `json:"currency"`
	UpdatedBy           string   `json:"updated_by"`
	AcquisitionDate     int64    `json:"acquisition_date"`
	FxRateAtAcquisition float64  `json:"fx_rate_at_acquisition"`
	LotID               *string  `json:"lot_id"`
	FxRateToBase        *float64 `json:"fx_rate_to_base"`
	TransferID          *string  `json:"transfer_id"`
	EventTs             *int64   `json:"event_ts"`
}

type TransferInBulkCreate struct {
	TransferIns []TransferInCreate `json:"transfer_ins"`
}

type TransferInOut struct {
	PortfolioID         string   `json:"portfolio_id"`
	InstrumentID        string   `json:"instrument_id"`
	TransferID          string   `json:"transfer_id"`
	LotID               string   `json:"lot_id"`
	Quantity            float64  `json:"quantity"`
	CostBasisNative     float64  `json:"cost_basis_native"`
	Currency            string   `json:"currency"`
	AcquisitionDate     int64    `json:"acquisition_date"`
	FxRateAtAcquisition float64  `json:"fx_rate_at_acquisition"`
	FxRateToBase        *float64 `json:"fx_rate_to_base"`
	EventTs             int64    `json:"event_ts"`
	ObservationID       string   `json:"observation_id"`
	GatewayOffset       int64    `json:"gateway_offset"`
}

func (a *App) registerTransferRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/ref/transfer-ins", a.handleCreateTransferIn)
	mux.HandleFunc("/ref/transfer-ins/bulk", a.handleTransferInsBulk)
}

func (a *App) handleCreateTransferIn(w http.ResponseWriter, r *http.Request) {
	if !methodGuard(w, r, http.MethodPost) {
		return
	}
	body, ok := decodeJSON[TransferInCreate](w, r)
	if !ok {
		return
	}
	ctx, ok := a.handlerCtx(w, r)
	if !ok {
		return
	}
	out, err := a.publishTransferIn(ctx, body)
	if err != nil {
		respondErr(w, http.StatusBadGateway, err.Error())
		return
	}
	respondJSON(w, http.StatusCreated, out)
}

func (a *App) handleTransferInsBulk(w http.ResponseWriter, r *http.Request) {
	if !methodGuard(w, r, http.MethodPost) {
		return
	}
	body, ok := decodeJSON[TransferInBulkCreate](w, r)
	if !ok {
		return
	}
	if err := validateTransferGrouping(body.TransferIns); err != nil {
		respondErr(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx, ok := a.handlerCtx(w, r)
	if !ok {
		return
	}
	out := make([]TransferInOut, 0, len(body.TransferIns))
	for _, t := range body.TransferIns {
		o, err := a.publishTransferIn(ctx, t)
		if err != nil {
			respondErr(w, http.StatusBadGateway, err.Error())
			return
		}
		out = append(out, o)
	}
	respondJSON(w, http.StatusCreated, out)
}

// validateTransferGrouping enforces the multi-lot invariant: rows sharing
// a non-nil transfer_id must all reference the same instrument_id and
// their lot_ids must be unique.
func validateTransferGrouping(items []TransferInCreate) error {
	type group struct {
		instrument string
		lots       map[string]struct{}
	}
	groups := map[string]*group{}
	for i, t := range items {
		tid := derefStr(t.TransferID, "")
		if tid == "" {
			continue
		}
		g, ok := groups[tid]
		if !ok {
			g = &group{instrument: t.InstrumentID, lots: map[string]struct{}{}}
			groups[tid] = g
		}
		if g.instrument != t.InstrumentID {
			return fmt.Errorf("row %d: transfer_id %s spans instruments %s and %s",
				i, tid, g.instrument, t.InstrumentID)
		}
		lot := derefStr(t.LotID, "")
		if lot == "" {
			continue
		}
		if _, dup := g.lots[lot]; dup {
			return fmt.Errorf("row %d: duplicate lot_id %s under transfer_id %s", i, lot, tid)
		}
		g.lots[lot] = struct{}{}
	}
	return nil
}

func (a *App) publishTransferIn(ctx context.Context, body TransferInCreate) (TransferInOut, error) {
	lotID := derefStr(body.LotID, "")
	if lotID == "" {
		lotID = a.newID()
	}
	transferID := derefStr(body.TransferID, "")
	if transferID == "" {
		transferID = lotID
	}
	// TRANSFER_IN business_ts = acquisition_date (pre-v6 convention).
	payloadStr, err := marshalPayload(map[string]any{
		"transfer_id":            transferID,
		"quantity":               body.Quantity,
		"cost_basis_native":      body.CostBasisNative,
		"currency":               strings.ToUpper(body.Currency),
		"acquisition_date":       body.AcquisitionDate,
		"fx_rate_at_acquisition": body.FxRateAtAcquisition,
		"fx_rate_to_base":        body.FxRateToBase,
	})
	if err != nil {
		return TransferInOut{}, err
	}
	instrumentID := body.InstrumentID
	result, err := a.client.PublishPortfolioEvent(ctx, "transfer-ins", pluginclient.PortfolioEventBody{
		SourceID:     lotID,
		PortfolioID:  body.PortfolioID,
		InstrumentID: &instrumentID,
		BusinessTs:   body.AcquisitionDate,
		Payload:      payloadStr,
	})
	if err != nil {
		return TransferInOut{}, err
	}
	var offset int64
	if result != nil {
		offset = result.Offset
	}
	return TransferInOut{
		PortfolioID:         body.PortfolioID,
		InstrumentID:        body.InstrumentID,
		TransferID:          transferID,
		LotID:               lotID,
		Quantity:            body.Quantity,
		CostBasisNative:     body.CostBasisNative,
		Currency:            strings.ToUpper(body.Currency),
		AcquisitionDate:     body.AcquisitionDate,
		FxRateAtAcquisition: body.FxRateAtAcquisition,
		FxRateToBase:        body.FxRateToBase,
		EventTs:             body.AcquisitionDate,
		ObservationID:       a.newID(),
		GatewayOffset:       offset,
	}, nil
}
