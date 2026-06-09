package plugin

import "net/http"

// registerLocalRoutes wires every CallResource path the admin plugin
// serves. v6: write paths publish to the gateway; the portfolios +
// instruments CRUD surface lives on the control plane and is gone from
// this plugin.
func (a *App) registerLocalRoutes(mux *http.ServeMux) {
	a.registerRefRoutes(mux)
	a.registerEventRoutes(mux)
	a.registerTradeRoutes(mux)
	a.registerDividendRoutes(mux)
	a.registerCashflowRoutes(mux)
	a.registerFxConversionRoutes(mux)
	a.registerTransferRoutes(mux)
	a.registerOptionLifecycleRoutes(mux)
	a.registerOptionMarkRoutes(mux)
}
