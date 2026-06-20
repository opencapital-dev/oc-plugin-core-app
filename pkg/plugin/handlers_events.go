package plugin

import "net/http"

func (a *App) registerEventRoutes(mux *http.ServeMux) {
	mux.HandleFunc("DELETE /ref/events/{source_id}", a.handleDeleteEvent)
}

// handleDeleteEvent issues a tombstone for one portfolio event via rw_key.
// Type-agnostic: the rw_key is plugin_id|source_id.
func (a *App) handleDeleteEvent(w http.ResponseWriter, r *http.Request) {
	sourceID := r.PathValue("source_id")
	if sourceID == "" {
		respondErr(w, http.StatusBadRequest, "source_id is required")
		return
	}
	ctx, ok := a.handlerCtx(w, r)
	if !ok {
		return
	}
	err := a.deleteEvent(ctx, sourceID)
	if err != nil {
		respondErr(w, http.StatusBadGateway, err.Error())
		return
	}
	respondJSON(w, http.StatusNoContent, nil)
}
