//go:build mage
// +build mage

package main

import (
	// mage:import
	build "github.com/grafana/grafana-plugin-sdk-go/build"

	"github.com/opencapital-dev/oc-plugin-sdk/pluginclient/artifacts"
)

// Default configures the default target.
var Default = build.BuildAll

// CopyArtifacts mirrors dashboards/ and library-panels/ into dist/ so they
// ship inside the published bundle. Run after npm run build (whose webpack
// output.clean wipes dist/ of all but the backend binaries); the SDK build
// does not copy these non-standard dirs.
func CopyArtifacts() error {
	return artifacts.Copy(".")
}

func init() {
	// No CGO dependencies; keep CGO disabled (SDK default) for reproducible builds.
	_ = build.SetBeforeBuildCallback(func(cfg build.Config) (build.Config, error) {
		return cfg, nil
	})
}
