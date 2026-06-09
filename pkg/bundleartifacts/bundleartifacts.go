// Package bundleartifacts copies the plugin's provisioning artifacts
// (dashboards/, library-panels/) into dist/ so they ship inside the
// published OCI bundle. The grafana-plugin-sdk-go build target only emits
// the backend binaries + webpack output; these non-standard dirs would
// otherwise never reach the bundle.
package bundleartifacts

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// ArtifactDirs are the plugin-root source dirs copied verbatim into dist/.
var ArtifactDirs = []string{"dashboards", "library-panels"}

// Copy mirrors each ArtifactDir from pluginDir into pluginDir/dist. A
// missing source dir is skipped (not an error) so the target is safe to run
// on plugins that ship no artifacts. dist/ must already exist — the copy
// runs after the build, never before. copyTree never removes stale files;
// freshness comes from webpack's output.clean (npm run build, which wipes
// everything but the backend binaries), so the copy must follow it.
func Copy(pluginDir string) error {
	dist := filepath.Join(pluginDir, "dist")
	if info, err := os.Stat(dist); err != nil || !info.IsDir() {
		return fmt.Errorf("missing %s (run the plugin build first)", dist)
	}
	for _, name := range ArtifactDirs {
		src := filepath.Join(pluginDir, name)
		info, err := os.Stat(src)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return err
		}
		if !info.IsDir() {
			return fmt.Errorf("%s is not a directory", src)
		}
		if err := copyTree(src, filepath.Join(dist, name)); err != nil {
			return err
		}
	}
	return nil
}

func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		return copyFile(path, target)
	})
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
