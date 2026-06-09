package plugin

import (
	"net/http"

	"github.com/portfolio-management/pluginclient"
)

func (a *App) registerEventRoutes(mux *http.ServeMux) {
	mux.HandleFunc("DELETE /ref/events/{source_id}", a.handleDeleteEvent)
}

// handleDeleteEvent issues a tombstone for one portfolio event via the SDK.
// Type-agnostic: org_id+plugin_id are stamped by the gateway.
func (a *App) handleDeleteEvent(w http.ResponseWriter, r *http.Request) {
	sourceID := r.PathValue("source_id")
	if sourceID == "" {
		respondErr(w, http.StatusBadRequest, "source_id is required")
		return
	}
	portfolioID := r.URL.Query().Get("portfolio_id")
	if portfolioID == "" {
		respondErr(w, http.StatusBadRequest, "portfolio_id query param is required")
		return
	}
	ctx, ok := a.handlerCtx(w, r)
	if !ok {
		return
	}
	err := a.client.PublishEventTombstones(ctx, []pluginclient.EventTombstoneKey{
		{SourceID: sourceID, PortfolioID: portfolioID},
	})
	if err != nil {
		respondErr(w, http.StatusBadGateway, err.Error())
		return
	}
	respondJSON(w, http.StatusNoContent, nil)
}
