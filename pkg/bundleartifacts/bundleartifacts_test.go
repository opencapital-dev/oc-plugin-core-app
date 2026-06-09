package bundleartifacts

import (
	"os"
	"path/filepath"
	"testing"
)

// TestCopySeedsDist exercises the copy in isolation: seed source dirs +
// dist/, run Copy, assert the artifacts land under dist/. This is the
// Phase 1 testable outcome without a full (CGO/librdkafka) backend build.
func TestCopySeedsDist(t *testing.T) {
	root := t.TempDir()
	mustMkdir(t, filepath.Join(root, "dist"))

	want := map[string]string{
		"dashboards/_placeholder.json":     `{"_placeholder": true}`,
		"library-panels/_placeholder.json": `{"_placeholder": true}`,
	}
	for rel, body := range want {
		mustWrite(t, filepath.Join(root, rel), body)
	}

	if err := Copy(root); err != nil {
		t.Fatalf("Copy: %v", err)
	}

	for rel, body := range want {
		got, err := os.ReadFile(filepath.Join(root, "dist", rel))
		if err != nil {
			t.Fatalf("dist/%s missing: %v", rel, err)
		}
		if string(got) != body {
			t.Fatalf("dist/%s = %q, want %q", rel, got, body)
		}
	}
}

// TestCopyNestedAndOverwrite exercises the two paths TestCopySeedsDist
// misses: a nested subdir under a source dir, and overwriting a stale file
// already in dist/ (copyFile uses os.Create, which truncates).
func TestCopyNestedAndOverwrite(t *testing.T) {
	root := t.TempDir()
	mustMkdir(t, filepath.Join(root, "dist"))

	const rel = "dashboards/nested/panel.json"
	mustWrite(t, filepath.Join(root, rel), `{"new": true}`)
	mustWrite(t, filepath.Join(root, "dist", rel), `{"stale": true}`)

	if err := Copy(root); err != nil {
		t.Fatalf("Copy: %v", err)
	}

	got, err := os.ReadFile(filepath.Join(root, "dist", rel))
	if err != nil {
		t.Fatalf("dist/%s missing: %v", rel, err)
	}
	if want := `{"new": true}`; string(got) != want {
		t.Fatalf("dist/%s = %q, want %q (overwrite of stale content)", rel, got, want)
	}
}

// TestCopyRealPluginArtifacts runs against the actual checked-in source
// dirs, so the seeded placeholders (and, later, Phase 5 content) are proven
// to reach dist/. Skips cleanly if dist/ has not been built yet.
func TestCopyRealPluginArtifacts(t *testing.T) {
	root := pluginRoot(t)
	if info, err := os.Stat(filepath.Join(root, "dist")); err != nil || !info.IsDir() {
		t.Skip("dist/ not built; run the plugin build first")
	}
	if err := Copy(root); err != nil {
		t.Fatalf("Copy: %v", err)
	}
	for _, dir := range ArtifactDirs {
		entries, err := os.ReadDir(filepath.Join(root, "dist", dir))
		if err != nil {
			t.Fatalf("dist/%s: %v", dir, err)
		}
		if len(entries) == 0 {
			t.Fatalf("dist/%s is empty; expected at least the seeded placeholder", dir)
		}
	}
}

// TestCopyMissingSourceDirIsSkipped confirms a plugin with no artifact dirs
// does not fail the build.
func TestCopyMissingSourceDirIsSkipped(t *testing.T) {
	root := t.TempDir()
	mustMkdir(t, filepath.Join(root, "dist"))
	if err := Copy(root); err != nil {
		t.Fatalf("Copy with no source dirs: %v", err)
	}
}

func pluginRoot(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	// pkg/bundleartifacts -> plugin root
	return filepath.Dir(filepath.Dir(wd))
}

func mustMkdir(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
}

func mustWrite(t *testing.T, path, body string) {
	t.Helper()
	mustMkdir(t, filepath.Dir(path))
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}
