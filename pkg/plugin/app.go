package plugin

import (
	"context"
	"fmt"
	"net/http"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/instancemgmt"
	"github.com/grafana/grafana-plugin-sdk-go/backend/resource/httpadapter"

	"github.com/opencapital-dev/oc-plugin-sdk/pluginclient"
)

var (
	_ backend.CallResourceHandler   = (*App)(nil)
	_ instancemgmt.InstanceDisposer = (*App)(nil)
	_ backend.CheckHealthHandler    = (*App)(nil)
)

// App is the portfolio-admin backend plugin. v7 surface:
//   - Writes flow directly to RisingWave via pgwire (insertEvent/insertData/
//     deleteEvent). No gateway, no JWT minting, no Avro.
//   - Reads of event-derived RisingWave data go through client.Query (rwclient).
//   - Portfolios CRUD uses client.PGQuery/PGExec against Postgres control_db.
type App struct {
	backend.CallResourceHandler
	client   *pluginclient.Client
	pluginID string

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

	app := &App{
		client:   client,
		pluginID: client.Config().PluginID,
	}

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

// CheckHealth reports OK as long as the SDK client is constructed.
func (a *App) CheckHealth(_ context.Context, _ *backend.CheckHealthRequest) (*backend.CheckHealthResult, error) {
	if a.client == nil {
		return &backend.CheckHealthResult{Status: backend.HealthStatusError, Message: "pluginclient not initialised"}, nil
	}
	return &backend.CheckHealthResult{Status: backend.HealthStatusOk, Message: "ok"}, nil
}

// handlerCtx is the shared pre-flight every CallResource handler runs.
// v7: loopback trust — no JWT validation required on the direct pgwire path.
func (a *App) handlerCtx(w http.ResponseWriter, r *http.Request) (context.Context, bool) {
	if a.client == nil {
		respondErr(w, http.StatusServiceUnavailable, "pluginclient not initialised")
		return nil, false
	}
	return r.Context(), true
}
