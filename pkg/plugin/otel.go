package plugin

import (
	"github.com/grafana/grafana-plugin-sdk-go/backend/tracing"
	"go.opentelemetry.io/otel/trace"
)

// TracerName is the OTel instrumentation scope used by handlers added in
// later phases. The grafana-plugin-sdk-go ships an OTLP/gRPC tracing
// pipeline configured by the host via OTEL_EXPORTER_* env vars; the
// plugin only has to grab a tracer with a consistent name.
const TracerName = "portfolio-admin-v2"

// Tracer returns the SDK-provided tracer for this plugin's scope.
func Tracer() trace.Tracer {
	return tracing.DefaultTracer()
}
