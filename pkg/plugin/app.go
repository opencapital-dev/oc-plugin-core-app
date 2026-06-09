package plugin

import (
	"context"
	"fmt"
	"net/http"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/instancemgmt"
	"github.com/grafana/grafana-plugin-sdk-go/backend/resource/httpadapter"

	"github.com/portfolio-management/pluginclient"
)

var (
	_ backend.CallResourceHandler   = (*App)(nil)
	_ instancemgmt.InstanceDisposer = (*App)(nil)
	_ backend.CheckHealthHandler    = (*App)(nil)
)

// App is the portfolio-admin backend plugin. v6 surface:
//   - Writes flow through the gateway via pluginclient.PublishPortfolioEvent
//     and pluginclient.PublishData (option marks). The plugin no longer
//     speaks Kafka, Schema Registry, or Avro directly.
//   - Reads of event-derived RisingWave data go through read-gateway's
//     selector DSL (pluginclient.ReadGatewayQuery), authenticated with the
//     plugin's minted session JWT — the plugin never opens RW pg-wire.
//   - Plugin-private operator scratch state lives in per-(plugin, org)
//     SQLite opened via pluginclient.OpenDB. The portfolios + instruments
//     tables moved to control_db; portfolio-admin no longer owns them.
//
// The five pieces of platform config (pluginId, controlPlaneUrl, gatewayUrl,
// otelEndpoint, platformToken) all come from the plugin's AppInstanceSettings
// — never from the Grafana container env, which is shared across plugin
// subprocesses.
type App struct {
	backend.CallResourceHandler
	client *pluginclient.Client

	// Overridable in tests to make event_ts / source_id deterministic.
	// nil → use package helpers nowMicros() / genID().
	nowFn func() int64
	idFn  func() string
}

// now returns the current time in microseconds. Tests inject a fixed clock.
func (a *App) now() int64 {
	if a.nowFn != nil {
		return a.nowFn()
	}
	return nowMicros()
}

// newID returns a fresh UUID. Tests inject a deterministic generator.
func (a *App) newID() string {
	if a.idFn != nil {
		return a.idFn()
	}
	return genID()
}

func NewApp(_ context.Context, settings backend.AppInstanceSettings) (instancemgmt.Instance, error) {
	client, err := pluginclient.NewFromSettings(pluginclient.Settings{
		JSONData:                settings.JSONData,
		DecryptedSecureJSONData: settings.DecryptedSecureJSONData,
	})
	if err != nil {
		return nil, fmt.Errorf("portfolio-admin: pluginclient init: %w", err)
	}

	app := &App{client: client}

	mux := http.NewServeMux()
	app.registerLocalRoutes(mux)
	app.CallResourceHandler = httpadapter.New(mux)
	return app, nil
}

func (a *App) Dispose() {
	if a.client != nil {
		_ = a.client.Close()
	}
}

// CheckHealth reports OK as long as the SDK client is constructed; control
// plane + gateway reachability surfaces per-request as 5xx with a useful
// body. CheckHealth running its own mint + cert dance would expose the
// plugin's PLATFORM_TOKEN to anyone who can hit the Grafana healthcheck.
func (a *App) CheckHealth(_ context.Context, _ *backend.CheckHealthRequest) (*backend.CheckHealthResult, error) {
	if a.client == nil {
		return &backend.CheckHealthResult{Status: backend.HealthStatusError, Message: "pluginclient not initialised"}, nil
	}
	return &backend.CheckHealthResult{Status: backend.HealthStatusOk, Message: "ok"}, nil
}

// handlerCtx is the shared pre-flight every CallResource handler runs: it
// attaches the verified (user, org, plugin) identity to the request context
// via pluginclient.WithRequest. On failure it writes 401 and returns ok=false
// so the handler can early-return.
func (a *App) handlerCtx(w http.ResponseWriter, r *http.Request) (context.Context, bool) {
	if a.client == nil {
		respondErr(w, http.StatusServiceUnavailable, "pluginclient not initialised")
		return nil, false
	}
	ctx, err := a.client.WithRequest(r.Context(), r)
	if err != nil {
		respondErr(w, http.StatusUnauthorized, err.Error())
		return nil, false
	}
	return ctx, true
}

