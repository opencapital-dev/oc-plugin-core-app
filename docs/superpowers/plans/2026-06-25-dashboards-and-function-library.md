# Plugin function library + core-app dashboards — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple the metric function library from the frozen compute binary (datasource prepends shippable `.py` helpers), then rebuild the three core-app dashboards as titled, all-timeseries views driven by an `over_time` combinator.

**Architecture:** The datasource already reads each metric `.py` and POSTs only a source string to the frozen compute sidecar. We prepend a base function library (shipped by `core-datasource`) plus the owning plugin's own `functions/*.py` to that string. Compute is untouched. New analytics metrics compute each value *as of each day* via `over_time(fn, step)`; panels inline their own formula; dashboards inline full panel models (fixing the `libraryPanel` no-title bug) while keeping `ref:` targets.

**Tech Stack:** Go (Grafana plugin SDK) for the datasource; Python 3 + polars for metrics/functions (run inside the frozen PyInstaller compute sidecar); Grafana dashboard JSON.

## Global Constraints

- `ts` columns in every series/table frame MUST be **Int64 epoch-microseconds** and JSON-serializable — never a polars `Datetime` (a Datetime ts crashes `json.dumps` in the sidecar → dropped connection → `compute: EOF`).
- Compute sidecar (`opencapital/services/compute`) is **NOT modified** and **NOT re-frozen**. No desktop app release in this plan.
- Both plugins are GHCR-reconciled. Shipping changes = republish the plugin (`oc-plugin.json` version bump + tag), pulled on app restart.
- Bundled scripts/sidecar run under macOS `/bin/bash` 3.2 — irrelevant here (no bash), noted for consistency.
- Generators/verification harnesses are **scratchpad only, never committed** (panels keep changing) — write them under the session scratchpad dir.
- Portfolio display name is `attributes.name`; the datasource variable resolver maps a column named `name`→option text and `portfolio_id`→option value (`oc-plugin-core-datasource/src/datasource.ts:102`).
- Base library lives beside the datasource binary at runtime: `filepath.Dir(os.Executable())/functions`. It must ship to `dist/functions/`.

---

# Part P — Function library decoupling (repo: `oc-plugin-core-datasource`)

Branch: `git -C /Users/ignacioballester/trading-code/oc-plugin-core-datasource checkout -b feat/function-library`

### Task P1: Base function library (`over_time`, `returns`)

**Files:**
- Create: `oc-plugin-core-datasource/functions/series.py`
- Verify (scratchpad): `<scratchpad>/verify_functions.py`

**Interfaces:**
- Produces: `over_time(fn, step) -> pl.DataFrame({"ts": Int64, "value": Float64})`; `returns(nav, flows, step) -> pl.DataFrame({"ts": Int64, "ret": Float64})`.
- Consumes (from injected compute namespace at exec time): `window` (NamedTuple `t0`,`t1` µs), `build_grid(t0,t1,step)->list[int]`, `cumulative_twr(nav, flow_ts, start, grid)->list[(ts,val)]`, `cumulative_to_period_returns(list[(ts,cum)])->list[(ts,ret)]`, `pl`.

- [ ] **Step 1: Write the base library**

`oc-plugin-core-datasource/functions/series.py`:
```python
# Base function library, prepended to every panel source by the datasource.
# These resolve build_grid / cumulative_twr / cumulative_to_period_returns /
# window / pl from the compute-injected namespace at call time. No decorators.

def over_time(fn, step):
    """Evaluate fn(t) over a uniform grid spanning the dashboard window.

    fn:   given cutoff ts t (epoch microseconds), returns the metric value as of
          t (float or None). fn owns its windowing (expanding: ts <= t).
    step: int microseconds or a string like "1d" / "1h".
    Returns pl.DataFrame({"ts": Int64, "value": Float64}) over [window.t0,
    window.t1] inclusive; ts is Int64 epoch-microseconds.
    """
    grid = build_grid(window.t0, window.t1, step)
    return pl.DataFrame(
        {"ts": grid, "value": [fn(t) for t in grid]},
        schema={"ts": pl.Int64, "value": pl.Float64},
    )


def returns(nav, flows, step):
    """Flow-neutralized period-return series for a portfolio on a step grid.

    nav:   e_nav frame (ts Int64 µs, value Float64 > 0).
    flows: e_flows frame (ts Int64 µs, amt Float64 signed).
    Returns pl.DataFrame({"ts": Int64, "ret": Float64}); first tick ret is null.
    """
    t0, t1 = window
    start = t0 if nav.is_empty() else max(t0, nav["ts"][0])
    flow_ts = [r[0] for r in flows.select("ts").rows() if r[0] > start]
    grid = build_grid(start, t1, step)
    cum = cumulative_twr(nav, flow_ts, start, grid)
    pairs = cumulative_to_period_returns(cum)
    return pl.DataFrame(
        {"ts": [ts for ts, _ in pairs], "ret": [r for _, r in pairs]},
        schema={"ts": pl.Int64, "ret": pl.Float64},
    )
```

- [ ] **Step 2: Write the scratchpad verifier**

`<scratchpad>/verify_functions.py` — execs `series.py` into a namespace with real compute helpers + a tiny canned NAV, asserts the frame contract:
```python
import sys
sys.path.insert(0, "/Users/ignacioballester/trading-code/opencapital/services/compute")
import json
import polars as pl
from compute import metrics  # build_grid, cumulative_twr, cumulative_to_period_returns
from collections import namedtuple

Window = namedtuple("Window", "t0 t1")
_D = 86_400_000_000  # 1 day in µs

ns = {
    "pl": pl,
    "window": Window(0, 3 * _D),
    "build_grid": metrics.build_grid,
    "cumulative_twr": metrics.cumulative_twr,
    "cumulative_to_period_returns": metrics.cumulative_to_period_returns,
}
src = open("/Users/ignacioballester/trading-code/oc-plugin-core-datasource/functions/series.py").read()
exec(src, ns)

nav = pl.DataFrame({"ts": [0, _D, 2 * _D, 3 * _D], "value": [1000.0, 1100.0, 1050.0, 1200.0]},
                   schema={"ts": pl.Int64, "value": pl.Float64})
flows = pl.DataFrame({"ts": [], "amt": []}, schema={"ts": pl.Int64, "amt": pl.Float64})

rets = ns["returns"](nav, flows, "1d")
assert rets.schema["ts"] == pl.Int64, rets.schema
ot = ns["over_time"](lambda t: float(t), "1d")
assert ot.columns == ["ts", "value"] and ot.schema["ts"] == pl.Int64
# JSON-serializable (the EOF guard):
json.dumps({"rows": ot.rows()})
print("OK", rets.shape, ot.shape)
```

- [ ] **Step 3: Run the verifier**

Run: `python <scratchpad>/verify_functions.py`
Expected: `OK (4, 2) (4, 2)` and no exception.

- [ ] **Step 4: Commit**

```bash
git -C /Users/ignacioballester/trading-code/oc-plugin-core-datasource add functions/series.py
git -C /Users/ignacioballester/trading-code/oc-plugin-core-datasource commit -m "feat(functions): base library — over_time + returns"
```

---

### Task P2: Datasource loader — concatenate base + plugin functions

**Files:**
- Modify: `oc-plugin-core-datasource/pkg/plugin/metricref.go` (add `loadFunctions`, `appendFunctionsDir`)
- Test: `oc-plugin-core-datasource/pkg/plugin/metricref_test.go` (add cases)

**Interfaces:**
- Produces: `loadFunctions(baseDir, installRoot, ref string) string` — concatenated helper source (base dir first, then `<installRoot>/<pluginID>/functions` when `ref` is a metric ref), each file terminated by `\n`; missing dirs skipped; never errors.

- [ ] **Step 1: Write the failing test**

Append to `metricref_test.go`:
```go
func writePy(t *testing.T, dir, name, body string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestLoadFunctions_baseThenPlugin(t *testing.T) {
	tmp := t.TempDir()
	base := filepath.Join(tmp, "ds", "functions")
	writePy(t, base, "series.py", "def over_time():\n    pass\n")
	install := filepath.Join(tmp, "install")
	writePy(t, filepath.Join(install, "core-app", "functions"), "extra.py", "def plug():\n    pass\n")

	got := loadFunctions(base, install, "core-app/total_return")
	if !strings.Contains(got, "over_time") || !strings.Contains(got, "plug") {
		t.Fatalf("missing helpers: %q", got)
	}
	if strings.Index(got, "over_time") > strings.Index(got, "plug") {
		t.Fatal("base must come before plugin functions")
	}
}

func TestLoadFunctions_inlineGetsBaseOnly(t *testing.T) {
	tmp := t.TempDir()
	base := filepath.Join(tmp, "ds", "functions")
	writePy(t, base, "series.py", "def over_time():\n    pass\n")
	got := loadFunctions(base, tmp, "") // inline source: no ref
	if !strings.Contains(got, "over_time") {
		t.Fatal("base lib must load for inline queries")
	}
}

func TestLoadFunctions_missingDirsSkip(t *testing.T) {
	got := loadFunctions(filepath.Join(t.TempDir(), "nope"), t.TempDir(), "core-app/x")
	if got != "" {
		t.Fatalf("expected empty, got %q", got)
	}
}

func TestLoadFunctions_refEscapeLoadsNoPlugin(t *testing.T) {
	tmp := t.TempDir()
	base := filepath.Join(tmp, "ds", "functions")
	writePy(t, base, "series.py", "X=1\n")
	got := loadFunctions(base, tmp, "../evil/metric")
	if strings.Contains(got, "evil") {
		t.Fatal("must not load plugin functions for a non-ref / escaping ref")
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/ignacioballester/trading-code/oc-plugin-core-datasource && go test ./pkg/plugin/ -run TestLoadFunctions`
Expected: FAIL — `undefined: loadFunctions`.

- [ ] **Step 3: Implement the loader**

Append to `metricref.go` (add `"sort"` to imports):
```go
// loadFunctions returns the helper Python prepended to a panel source: the base
// library shipped beside the datasource binary (baseDir), then the owning
// plugin's functions/ when ref is a metric ref. Missing dirs are skipped; this
// never errors (a broken helper surfaces later as a compute error).
func loadFunctions(baseDir, installRoot, ref string) string {
	var b strings.Builder
	appendFunctionsDir(&b, baseDir)
	if isMetricRef(ref) {
		pluginID, _, _ := strings.Cut(strings.TrimSpace(ref), "/")
		appendFunctionsDir(&b, filepath.Join(installRoot, pluginID, "functions"))
	}
	return b.String()
}

// appendFunctionsDir appends every *.py in dir (sorted) to b, each followed by
// a newline. A missing/unreadable dir is a silent skip.
func appendFunctionsDir(b *strings.Builder, dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".py") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	for _, n := range names {
		if data, err := os.ReadFile(filepath.Join(dir, n)); err == nil {
			b.Write(data)
			b.WriteString("\n")
		}
	}
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd /Users/ignacioballester/trading-code/oc-plugin-core-datasource && go test ./pkg/plugin/ -run TestLoadFunctions`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git -C /Users/ignacioballester/trading-code/oc-plugin-core-datasource add pkg/plugin/metricref.go pkg/plugin/metricref_test.go
git -C /Users/ignacioballester/trading-code/oc-plugin-core-datasource commit -m "feat(datasource): loadFunctions concatenates base + plugin helpers"
```

---

### Task P3: Wire loader into the query path

**Files:**
- Modify: `oc-plugin-core-datasource/pkg/plugin/datasource.go` (`Datasource` struct, `NewDatasource`, `query`)
- Test: `oc-plugin-core-datasource/pkg/plugin/datasource_test.go` (new or existing) — assert the posted source has helpers prepended.

**Interfaces:**
- Consumes: `loadFunctions` (Task P2).
- Produces: `Datasource.baseFuncDir string`; `query` posts `loadFunctions(...) + substituteVars(panelSource, vars)`.

- [ ] **Step 1: Write the failing test**

Create `pkg/plugin/datasource_test.go` (adapt if one exists):
```go
package plugin

import (
	"strings"
	"testing"
)

func TestComposeSourcePrependsHelpers(t *testing.T) {
	tmp := t.TempDir()
	base := tmp + "/ds/functions"
	writePy(t, base, "series.py", "def over_time(fn, step):\n    return None\n")
	panel := "@metric(output='series')\ndef m():\n    return over_time(lambda t: 1.0, '1d')\n"

	full := loadFunctions(base, tmp, "core-app/m") + substituteVars(panel, nil)
	if !strings.HasPrefix(full, "def over_time") {
		t.Fatal("helpers must be prepended before panel source")
	}
	if !strings.Contains(full, "def m()") {
		t.Fatal("panel source must be present")
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/ignacioballester/trading-code/oc-plugin-core-datasource && go test ./pkg/plugin/ -run TestComposeSource`
Expected: PASS already for compose (pure functions) — if it passes, proceed; the wiring is exercised by Step 3's manual check. (This test guards ordering.)

- [ ] **Step 3: Wire into `Datasource`**

In `datasource.go`, add the field:
```go
type Datasource struct {
	settings    *models.PluginSettings
	compute     *computeclient.Client
	installRoot string
	baseFuncDir string
}
```
In `NewDatasource`, after computing `installRoot`, derive the base functions dir from the binary location and set it:
```go
	baseFuncDir := ""
	if exe, err := os.Executable(); err == nil {
		baseFuncDir = filepath.Join(filepath.Dir(exe), "functions")
	}

	return &Datasource{
		settings:    settings,
		compute:     computeclient.New(settings.ComputeURL, &http.Client{Timeout: 60 * time.Second}),
		installRoot: installRoot,
		baseFuncDir: baseFuncDir,
	}, nil
```
Add `"os"` and `"path/filepath"` to `datasource.go` imports. In `query`, replace the compute call inputs:
```go
	code, err := selectCode(pm, d.installRoot)
	if err != nil {
		return backend.ErrDataResponse(backend.StatusBadRequest, err.Error())
	}
	code = substituteVars(code, pm.Vars)
	full := loadFunctions(d.baseFuncDir, d.installRoot, pm.Ref) + code

	from, to := q.TimeRange.From.UnixMicro(), q.TimeRange.To.UnixMicro()
	frame, err := d.compute.Compute(ctx, full, from, to)
```

- [ ] **Step 4: Run tests**

Run: `cd /Users/ignacioballester/trading-code/oc-plugin-core-datasource && go build ./... && go test ./pkg/plugin/`
Expected: build OK; all tests PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/ignacioballester/trading-code/oc-plugin-core-datasource add pkg/plugin/datasource.go pkg/plugin/datasource_test.go
git -C /Users/ignacioballester/trading-code/oc-plugin-core-datasource commit -m "feat(datasource): prepend function library to every panel source"
```

---

### Task P4: Bundle `functions/` into `dist/` + publish

**Files:**
- Modify: `oc-plugin-core-datasource/Magefile.go` (add a `CopyArtifacts` target copying `functions/` → `dist/functions/`)
- Modify: `oc-plugin-core-datasource/oc-plugin.json` (version bump)

- [ ] **Step 1: Add the copy target**

Append to `Magefile.go`:
```go
// CopyFunctions mirrors functions/ into dist/ so the base library ships in the
// published bundle (webpack output.clean wipes dist/ of non-standard dirs).
// Run after the frontend build.
func CopyFunctions() error {
	src := "functions"
	dst := filepath.Join("dist", "functions")
	entries, err := os.ReadDir(src)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return err
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".py") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(src, e.Name()))
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(dst, e.Name()), b, 0o644); err != nil {
			return err
		}
	}
	return nil
}
```
Add imports to `Magefile.go`: `"os"`, `"path/filepath"`, `"strings"`.

- [ ] **Step 2: Build and confirm functions land in dist**

Run:
```bash
cd /Users/ignacioballester/trading-code/oc-plugin-core-datasource
npm run build && mage -v buildAll && mage -v copyFunctions
ls dist/functions/
```
Expected: `series.py` present in `dist/functions/`. (If the project lacks `mage`, run `go run mage.go` per repo README; confirm the publish workflow includes `copyFunctions` — add it to `.github/workflows/*publish*.yml` build step if it runs mage targets explicitly.)

- [ ] **Step 3: Verify publish includes functions/**

Run: `grep -rn "library-panels\|dashboards\|CopyArtifacts\|copyFunctions\|functions" .github/workflows/ Magefile.go`
Ensure the publish workflow runs the copy step before packaging `dist/`. If artifacts are copied via the SDK helper elsewhere, mirror that for `functions/`.

- [ ] **Step 4: Bump version + commit + publish**

Edit `oc-plugin.json` `versions` to prepend the next version (e.g. `"0.1.4"`).
```bash
git -C /Users/ignacioballester/trading-code/oc-plugin-core-datasource add Magefile.go oc-plugin.json .github/
git -C /Users/ignacioballester/trading-code/oc-plugin-core-datasource commit -m "build: ship functions/ in dist; bump to 0.1.4"
```
Merge to `main` and tag/publish per the repo's release flow (push tag `v0.1.4`); confirm the GHCR artifact contains `functions/series.py`.

---

# Part D — Dashboards redesign (repo: `oc-plugin-core-app`, branch `feat/dashboards-ux-redesign`)

> The branch already exists with the committed spec. Continue on it.

### Task D1: Dropdown id → name

**Files:**
- Modify: `oc-plugin-core-app/library-panels/portfolios.py`

- [ ] **Step 1: Add the name column**

Replace the file with:
```python
@bind(rows=pg("SELECT portfolio_id::text AS portfolio_id, "
              "attributes->>'name' AS name "
              "FROM portfolios ORDER BY name"))
@metric(output="table")
def portfolios(rows):
    return rows
```

- [ ] **Step 2: Sanity-check the SQL shape**

Run: `grep -n "name" /Users/ignacioballester/trading-code/oc-plugin-core-datasource/src/datasource.ts | head`
Confirm the resolver keys on a column literally named `name` (text) + `portfolio_id` (value). No code change needed there.

- [ ] **Step 3: Commit**

```bash
git -C /Users/ignacioballester/trading-code/oc-plugin-core-app add library-panels/portfolios.py
git -C /Users/ignacioballester/trading-code/oc-plugin-core-app commit -m "fix(portfolios): expose name column so the dropdown shows names not ids"
```

---

### Task D2: Metric verification harness (scratchpad)

**Files:**
- Create (scratchpad): `<scratchpad>/run_metric.py`

**Interfaces:**
- Produces: `run_metric(metric_path, vars, canned) -> dict` — prepends the base library to the metric source, substitutes `vars`, runs it through the compute server with `sql()` stubbed to return `canned` frames keyed by table name, returns the neutral frame `{output, columns, rows}`.

- [ ] **Step 1: Build the harness by copying the parity-test scaffolding**

Model on `opencapital/services/compute/tests/test_parity_total_return.py` (its `_serve_compute`, `_post_compute`, `_make_query_stub` monkeypatch of `rwclient.connect`/`rwclient.query`). Write `<scratchpad>/run_metric.py`:
```python
import sys, json, re
sys.path.insert(0, "/Users/ignacioballester/trading-code/opencapital/services/compute")
# --- copy _serve_compute / _post_compute / _make_query_stub from the parity test ---
# _make_query_stub(canned) returns rows by matching the table name in the SQL:
#   "e_nav" -> canned["nav"], "e_flows" -> canned["flows"], "e_closures" -> canned["closures"]
BASE = open("/Users/ignacioballester/trading-code/oc-plugin-core-datasource/functions/series.py").read()

def _sub(src, vars):
    for k, v in vars.items():
        src = src.replace("${%s}" % k, v).replace("$%s" % k, v)
    return src

def run_metric(metric_path, vars, canned):
    src = BASE + "\n" + _sub(open(metric_path).read(), vars)
    # monkeypatch rwclient with _make_query_stub(canned); start server; POST
    # {"source": src, "window": {...}}; return parsed body. (scaffolding copied.)
    ...
```

- [ ] **Step 2: Smoke-test the harness on an existing metric**

Run the harness against `library-panels/cumulative_return_series.py` with a canned NAV; assert `body["output"] == "series"`, `body["columns"][0] == "ts"`, and every `rows[i][0]` is an int (Int64 epoch-µs, JSON round-trips).
Expected: passes — proves the base lib prepends cleanly and the frame contract holds.

(No commit — scratchpad only.)

---

### Task D3: NAV-family expanding-series metrics

**Files:**
- Create: `library-panels/annualized_return_series.py`, `volatility_series.py`, `sharpe_series.py`, `sortino_series.py`, `calmar_series.py`, `drawdown_series.py`, `xirr_series.py`
- Keep: `cumulative_return_series.py` (already correct)

**Interfaces:**
- Consumes: `returns(nav, flows, step)`, `over_time(fn, step)` (base lib); injected `window`, `pl`, `build_grid`, `asof`, `xirr`.
- Produces: each `@metric(output="series")` returning `{ts:Int64, value:Float64}`.

Shared `@bind` header (NAV family):
```python
@bind(
    nav=("SELECT * FROM e_nav WHERE portfolio=$1 ORDER BY ts ASC", "$portfolio_id"),
    flows=("SELECT * FROM e_flows WHERE portfolio=$1 AND ts BETWEEN $2 AND $3 ORDER BY ts ASC",
           "$portfolio_id", window.t0, window.t1),
)
```

- [ ] **Step 1: Write `volatility_series.py`**

```python
@bind(
    nav=("SELECT * FROM e_nav WHERE portfolio=$1 ORDER BY ts ASC", "$portfolio_id"),
    flows=("SELECT * FROM e_flows WHERE portfolio=$1 AND ts BETWEEN $2 AND $3 ORDER BY ts ASC",
           "$portfolio_id", window.t0, window.t1),
)
@metric(output="series")
def volatility_series(nav, flows):
    step = "${sample_interval}"
    PY = 252.0 if step == "1d" else 252.0 * 6.5
    rets = returns(nav, flows, step)
    def asof_v(t):
        r = rets.filter((pl.col("ts") <= t) & pl.col("ret").is_not_null())["ret"]
        if r.len() < 2:
            return None
        sd = r.std()
        return sd * (PY ** 0.5) if sd is not None else None
    return over_time(asof_v, step)
```

- [ ] **Step 2: Write `sharpe_series.py`**

```python
@bind(
    nav=("SELECT * FROM e_nav WHERE portfolio=$1 ORDER BY ts ASC", "$portfolio_id"),
    flows=("SELECT * FROM e_flows WHERE portfolio=$1 AND ts BETWEEN $2 AND $3 ORDER BY ts ASC",
           "$portfolio_id", window.t0, window.t1),
)
@metric(output="series")
def sharpe_series(nav, flows):
    step = "${sample_interval}"
    PY = 252.0 if step == "1d" else 252.0 * 6.5
    rf_per = float("${risk_free}") / PY
    rets = returns(nav, flows, step)
    def asof_s(t):
        r = rets.filter((pl.col("ts") <= t) & pl.col("ret").is_not_null())["ret"]
        if r.len() < 2:
            return None
        sd = r.std()
        if sd is None or sd == 0:
            return None
        return (r.mean() - rf_per) / sd * (PY ** 0.5)
    return over_time(asof_s, step)
```

- [ ] **Step 3: Write `sortino_series.py`**

```python
@bind(
    nav=("SELECT * FROM e_nav WHERE portfolio=$1 ORDER BY ts ASC", "$portfolio_id"),
    flows=("SELECT * FROM e_flows WHERE portfolio=$1 AND ts BETWEEN $2 AND $3 ORDER BY ts ASC",
           "$portfolio_id", window.t0, window.t1),
)
@metric(output="series")
def sortino_series(nav, flows):
    step = "${sample_interval}"
    PY = 252.0 if step == "1d" else 252.0 * 6.5
    rf_per = float("${risk_free}") / PY
    rets = returns(nav, flows, step)
    def asof_so(t):
        r = rets.filter((pl.col("ts") <= t) & pl.col("ret").is_not_null())["ret"]
        n = r.len()
        if n < 2:
            return None
        diff = r - rf_per
        neg = diff.filter(diff < 0)
        if neg.len() < 1:
            return None
        dd = (neg.pow(2).sum() / n) ** 0.5  # population downside deviation
        if dd == 0:
            return None
        return (r.mean() - rf_per) / dd * (PY ** 0.5)
    return over_time(asof_so, step)
```

- [ ] **Step 4: Write `annualized_return_series.py`**

```python
@bind(
    nav=("SELECT * FROM e_nav WHERE portfolio=$1 ORDER BY ts ASC", "$portfolio_id"),
    flows=("SELECT * FROM e_flows WHERE portfolio=$1 AND ts BETWEEN $2 AND $3 ORDER BY ts ASC",
           "$portfolio_id", window.t0, window.t1),
)
@metric(output="series")
def annualized_return_series(nav, flows):
    step = "${sample_interval}"
    PY = 252.0 if step == "1d" else 252.0 * 6.5
    rets = returns(nav, flows, step)
    def asof_a(t):
        sub = rets.filter((pl.col("ts") <= t) & pl.col("ret").is_not_null())["ret"]
        n = sub.len()
        if n < 1:
            return None
        acc = 1.0
        for x in sub:
            acc *= (1.0 + x)
        return acc ** (PY / n) - 1.0
    return over_time(asof_a, step)
```

- [ ] **Step 5: Write `calmar_series.py`**

```python
@bind(
    nav=("SELECT * FROM e_nav WHERE portfolio=$1 ORDER BY ts ASC", "$portfolio_id"),
    flows=("SELECT * FROM e_flows WHERE portfolio=$1 AND ts BETWEEN $2 AND $3 ORDER BY ts ASC",
           "$portfolio_id", window.t0, window.t1),
)
@metric(output="series")
def calmar_series(nav, flows):
    step = "${sample_interval}"
    PY = 252.0 if step == "1d" else 252.0 * 6.5
    rets = returns(nav, flows, step)
    def asof_c(t):
        sub = rets.filter((pl.col("ts") <= t) & pl.col("ret").is_not_null())["ret"]
        n = sub.len()
        if n < 1:
            return None
        acc, peak, mdd = 1.0, 1.0, 0.0
        for x in sub:
            acc *= (1.0 + x)
            if acc > peak:
                peak = acc
            dd = acc / peak - 1.0
            if dd < mdd:
                mdd = dd
        ann = acc ** (PY / n) - 1.0
        return ann / abs(mdd) if mdd < 0 else None
    return over_time(asof_c, step)
```

- [ ] **Step 6: Write `drawdown_series.py`**

```python
@bind(
    nav=("SELECT * FROM e_nav WHERE portfolio=$1 ORDER BY ts ASC", "$portfolio_id"),
    flows=("SELECT * FROM e_flows WHERE portfolio=$1 AND ts BETWEEN $2 AND $3 ORDER BY ts ASC",
           "$portfolio_id", window.t0, window.t1),
)
@metric(output="series")
def drawdown_series(nav, flows):
    step = "${sample_interval}"
    rets = returns(nav, flows, step)
    def asof_d(t):
        sub = rets.filter((pl.col("ts") <= t) & pl.col("ret").is_not_null())["ret"]
        if sub.len() < 1:
            return None
        acc, peak = 1.0, 1.0
        for x in sub:
            acc *= (1.0 + x)
            if acc > peak:
                peak = acc
        return acc / peak - 1.0
    return over_time(asof_d, step)
```

- [ ] **Step 7: Write `xirr_series.py`**

```python
@bind(
    nav=("SELECT * FROM e_nav WHERE portfolio=$1 ORDER BY ts ASC", "$portfolio_id"),
    flows=("SELECT * FROM e_flows WHERE portfolio=$1 AND ts BETWEEN $2 AND $3 ORDER BY ts ASC",
           "$portfolio_id", window.t0, window.t1),
)
@metric(output="series")
def xirr_series(nav, flows):
    step = "${sample_interval}"
    t0, t1 = window
    start = t0 if nav.is_empty() else max(t0, nav["ts"][0])
    opening = asof(nav, start)
    flow_rows = [(r[0], -r[1]) for r in flows.select("ts", "amt").rows() if r[0] > start]
    def asof_x(t):
        if opening is None or t <= start:
            return None
        term = asof(nav, t)
        if term is None:
            return None
        cf = [(start, -opening)] + [f for f in flow_rows if f[0] <= t] + [(t, term)]
        return xirr(cf)
    return over_time(asof_x, step)
```

- [ ] **Step 8: Verify every NAV-family metric via the harness**

For each new file, run `<scratchpad>/run_metric.py` with `vars={"portfolio_id":"p","sample_interval":"1d","risk_free":"0.04"}` and a canned rising-then-falling NAV. Assert: `output=="series"`, `columns==["ts","value"]`, every `rows[i][0]` is `int`, `json.dumps(rows)` succeeds, and the **last** value matches a hand-computed reference (e.g. `sharpe_series` last == sharpe over the full return series). Fix any `ts`-type or None-handling issues before committing.

- [ ] **Step 9: Commit**

```bash
git -C /Users/ignacioballester/trading-code/oc-plugin-core-app add library-panels/*_series.py
git -C /Users/ignacioballester/trading-code/oc-plugin-core-app commit -m "feat(metrics): NAV-family expanding series via over_time + inline formulas"
```

---

### Task D4: Trade-family expanding-series metrics

**Files:**
- Create: `library-panels/win_rate_series.py`, `profit_factor_series.py`, `expectancy_series.py`, `realized_pnl_series.py`, `trade_counts_series.py`

**Interfaces:**
- Consumes: `over_time`, injected `build_grid`, `pl`, `window`.
- Produces: `{ts, value}` series (single) or `{ts, trades, winners, losers}` (counts).

Shared `@bind` (closures):
```python
@bind(closures=("SELECT * FROM e_closures WHERE portfolio=$1 AND ts BETWEEN $2 AND $3 ORDER BY ts ASC",
                "$portfolio_id", window.t0, window.t1))
```

- [ ] **Step 1: `win_rate_series.py`**

```python
@bind(closures=("SELECT * FROM e_closures WHERE portfolio=$1 AND ts BETWEEN $2 AND $3 ORDER BY ts ASC",
                "$portfolio_id", window.t0, window.t1))
@metric(output="series")
def win_rate_series(closures):
    step = "${sample_interval}"
    def asof_w(t):
        sub = closures.filter(pl.col("ts") <= t)["realized_pnl"]
        wins = sub.filter(sub > 0).len()
        losses = sub.filter(sub < 0).len()
        dec = wins + losses
        return wins / dec if dec > 0 else None
    return over_time(asof_w, step)
```

- [ ] **Step 2: `profit_factor_series.py`**

```python
@bind(closures=("SELECT * FROM e_closures WHERE portfolio=$1 AND ts BETWEEN $2 AND $3 ORDER BY ts ASC",
                "$portfolio_id", window.t0, window.t1))
@metric(output="series")
def profit_factor_series(closures):
    step = "${sample_interval}"
    def asof_pf(t):
        sub = closures.filter(pl.col("ts") <= t)["realized_pnl"]
        gains = sub.filter(sub > 0).sum()
        losses = sub.filter(sub < 0).sum()
        return gains / abs(losses) if losses is not None and losses < 0 else None
    return over_time(asof_pf, step)
```

- [ ] **Step 3: `expectancy_series.py`**

```python
@bind(closures=("SELECT * FROM e_closures WHERE portfolio=$1 AND ts BETWEEN $2 AND $3 ORDER BY ts ASC",
                "$portfolio_id", window.t0, window.t1))
@metric(output="series")
def expectancy_series(closures):
    step = "${sample_interval}"
    def asof_e(t):
        sub = closures.filter(pl.col("ts") <= t)["realized_pnl"]
        wins = sub.filter(sub > 0)
        losses = sub.filter(sub < 0)
        dec = wins.len() + losses.len()
        if dec == 0:
            return None
        wr = wins.len() / dec
        aw = wins.mean() if wins.len() else 0.0
        al = losses.mean() if losses.len() else 0.0
        return wr * aw + (1.0 - wr) * al
    return over_time(asof_e, step)
```

- [ ] **Step 4: `realized_pnl_series.py`**

```python
@bind(closures=("SELECT * FROM e_closures WHERE portfolio=$1 AND ts BETWEEN $2 AND $3 ORDER BY ts ASC",
                "$portfolio_id", window.t0, window.t1))
@metric(output="series")
def realized_pnl_series(closures):
    step = "${sample_interval}"
    def asof_p(t):
        sub = closures.filter(pl.col("ts") <= t)["realized_pnl"]
        return float(sub.sum()) if sub.len() else 0.0
    return over_time(asof_p, step)
```

- [ ] **Step 5: `trade_counts_series.py` (multi-column, build grid directly)**

```python
@bind(closures=("SELECT * FROM e_closures WHERE portfolio=$1 AND ts BETWEEN $2 AND $3 ORDER BY ts ASC",
                "$portfolio_id", window.t0, window.t1))
@metric(output="series")
def trade_counts_series(closures):
    step = "${sample_interval}"
    grid = build_grid(window.t0, window.t1, step)
    rows = []
    for t in grid:
        sub = closures.filter(pl.col("ts") <= t)["realized_pnl"]
        rows.append((t, float(sub.len()),
                     float(sub.filter(sub > 0).len()),
                     float(sub.filter(sub < 0).len())))
    return pl.DataFrame(
        {"ts": [r[0] for r in rows], "trades": [r[1] for r in rows],
         "winners": [r[2] for r in rows], "losers": [r[3] for r in rows]},
        schema={"ts": pl.Int64, "trades": pl.Float64, "winners": pl.Float64, "losers": pl.Float64},
    )
```

- [ ] **Step 6: Verify via harness**

Run each through `<scratchpad>/run_metric.py` with canned `e_closures` (a few rows with mixed-sign `realized_pnl` at increasing `ts`). Assert frame contract (Int64 ts, JSON-serializable) + monotonic cumulative behavior (`trade_counts_series.trades` non-decreasing; final `win_rate` == wins/decisive over all closures).

- [ ] **Step 7: Commit**

```bash
git -C /Users/ignacioballester/trading-code/oc-plugin-core-app add library-panels/win_rate_series.py library-panels/profit_factor_series.py library-panels/expectancy_series.py library-panels/realized_pnl_series.py library-panels/trade_counts_series.py
git -C /Users/ignacioballester/trading-code/oc-plugin-core-app commit -m "feat(metrics): trade-family cumulative series"
```

---

### Task D5: Rebuild the Analytics dashboard (inline, grouped timeseries)

**Files:**
- Modify: `dashboards/metrics-analytics-numbat.json`
- Create (scratchpad): `<scratchpad>/gen_analytics.py`

**Panel spec (each is a `timeseries`, `ref: core-app/<metric>`, unit as noted):**

| Row | Panel title | Metric(s) (ref) | Unit |
|---|---|---|---|
| Return | Cumulative return | cumulative_return_series | percentunit |
| Return | Annualized return | annualized_return_series | percentunit |
| Drawdown | Drawdown over time | drawdown_series | percentunit (area) |
| Risk-adjusted | Sharpe | sharpe_series | none |
| Risk-adjusted | Sortino | sortino_series | none |
| Risk-adjusted | Calmar | calmar_series | none |
| Volatility | Volatility (annualized) | volatility_series | percentunit |
| Beta/Alpha/R² | (keep existing) | beta_series, alpha_series, r_squared_series, returns_pair_series | as-is |
| XIRR | XIRR (annualized) | xirr_series | percentunit |
| Trade quality | Win rate | win_rate_series | percentunit |
| Trade quality | Profit factor | profit_factor_series | none |
| Trade quality | Expectancy | expectancy_series | locale |
| Trade activity | Realized PnL (cumulative) | realized_pnl_series | locale |
| Trade activity | Trade counts | trade_counts_series | short |
| Tables | Per-instrument breakdown | instruments_breakdown | (table) |
| Tables | Hit rate by duration | hit_rate_by_duration | (table) |
| Tables | Drawdown episodes | drawdown_episodes | (table) |

- [ ] **Step 1: Write the generator**

`<scratchpad>/gen_analytics.py` builds the dashboard JSON: one inline `timeseries` panel per metric (id, gridPos in a 24-col grid grouped by `row` panels matching the table above), each with `targets:[{refId:"A", datasource:{type:"core-datasource",uid:"core-datasource"}, ref:"core-app/<metric>"}]`, `fieldConfig.defaults.unit` per the table, `options.legend` table w/ `[last,mean,min,max]`, `tooltip.mode:"multi"`. For `drawdown_series` set `custom.fillOpacity: 20` (area). For `ts` field add an override `displayName:"time"`. Tables reuse the inline models from `library-panels/<name>.json`. Keep variables: `portfolio_id`, `sample_interval`, `risk_free`, `lookback_periods`, `benchmark_ids`, `benchmark_weights`. **Delete** the `base_currency` variable. Add top-right dashboard links to Portfolio (`/d/metrics-portfolio?var-portfolio_id=${portfolio_id}&${__url_time_range}`).

- [ ] **Step 2: Generate + validate JSON**

Run: `python <scratchpad>/gen_analytics.py && python -c "import json; json.load(open('/Users/ignacioballester/trading-code/oc-plugin-core-app/dashboards/metrics-analytics-numbat.json'))"`
Expected: no error.

- [ ] **Step 3: Assert no base_currency + every target has a ref**

Run: `grep -c base_currency dashboards/metrics-analytics-numbat.json` → `0`.
Run a quick check that every `timeseries`/`table` panel target has a non-empty `ref`.

- [ ] **Step 4: Commit**

```bash
git -C /Users/ignacioballester/trading-code/oc-plugin-core-app add dashboards/metrics-analytics-numbat.json
git -C /Users/ignacioballester/trading-code/oc-plugin-core-app commit -m "feat(analytics): inline grouped timeseries; drop base_currency"
```

---

### Task D6: Rebuild the Portfolio dashboard

**Files:**
- Modify: `dashboards/metrics-portfolio.json`
- Modify: `library-panels/portfolio_equity_positions.json`, `library-panels/portfolio_cash_positions.json` (drop portfolio column; row→instrument link without base_currency)
- Use (scratchpad): `<scratchpad>/gen_portfolio.py` (inline the library-panel models)

- [ ] **Step 1: Edit the positions table models**

In `portfolio_equity_positions.json`: in the `organize` transform, add `"portfolio_id": true` under a new `excludeByName` map (drop the portfolio column); update the Instrument column link URL to:
`/d/metrics-instrument?var-portfolio_id=${portfolio_id}&var-instrument_id=${__data.fields.Instrument}&${__url_time_range}` (remove `&var-base_currency=...`).
Apply the equivalent column-drop + instrument link to `portfolio_cash_positions.json` where it has an instrument column.

- [ ] **Step 2: Inline panels + strip vars via generator**

`<scratchpad>/gen_portfolio.py` replaces every `libraryPanel` ref in `metrics-portfolio.json` with the full inline model from `library-panels/<name>.json` (keeping `id` + `gridPos`), and rewrites `templating.list` to keep `portfolio_id`, `position_filter`, `sample_interval` and **remove** `base_currency`, `benchmark_instrument_id`, `primary_benchmark`. Run it.

- [ ] **Step 3: Validate + assert removals**

Run: `python -c "import json; json.load(open('.../dashboards/metrics-portfolio.json'))"` → no error.
Run: `grep -Ec "base_currency|benchmark|libraryPanel" dashboards/metrics-portfolio.json` → `0`.

- [ ] **Step 4: Commit**

```bash
git -C /Users/ignacioballester/trading-code/oc-plugin-core-app add dashboards/metrics-portfolio.json library-panels/portfolio_equity_positions.json library-panels/portfolio_cash_positions.json
git -C /Users/ignacioballester/trading-code/oc-plugin-core-app commit -m "feat(portfolio): inline panels; positions link to instrument; drop portfolio col, base_currency, benchmark"
```

---

### Task D7: Rebuild the Instrument dashboard

**Files:**
- Modify: `dashboards/metrics-instrument.json`
- Use (scratchpad): `<scratchpad>/gen_instrument.py`

- [ ] **Step 1: Inline panels + strip base_currency**

`gen_instrument.py` inlines the `libraryPanel` models, and edits: remove the `base_currency` template variable; in the inline IRR `stat` panel's `rawSql` leave as-is (it filters by `portfolio_id`/`instrument_id`, not base_currency); rewrite the "Back to portfolio" link to `/d/metrics-portfolio?var-portfolio_id=${portfolio_id}&${__url_time_range}` (drop `&var-base_currency=...`). Run it.

- [ ] **Step 2: Validate + assert**

Run: `python -c "import json; json.load(open('.../dashboards/metrics-instrument.json'))"` → no error.
Run: `grep -Ec "base_currency|libraryPanel" dashboards/metrics-instrument.json` → `0`.

- [ ] **Step 3: Commit**

```bash
git -C /Users/ignacioballester/trading-code/oc-plugin-core-app add dashboards/metrics-instrument.json
git -C /Users/ignacioballester/trading-code/oc-plugin-core-app commit -m "feat(instrument): inline panels; drop base_currency from var + links"
```

---

### Task D8: Cleanup + dashboards-valid test

**Files:**
- Delete: unused scalar metric files superseded by `*_series` (see Step 1 list)
- Create: `tests/test_dashboards_valid.py` (Python; mirror the basic-data plugin's `tests/test_dashboards_valid.py`)

- [ ] **Step 1: Delete superseded scalar metrics**

Confirm none are referenced by any dashboard JSON, then delete:
`total_return.py annualized_return.py volatility.py sharpe_ratio.py sortino_ratio.py max_drawdown.py current_drawdown.py calmar_ratio.py xirr_annualized.py n_trades.py win_rate.py profit_factor.py expectancy.py avg_win.py avg_loss.py largest_profit.py largest_loss.py pnl_ratio.py avg_duration_sec.py re_entry_rate.py n_re_entries.py n_winning_instruments.py n_losing_instruments.py n_instruments_traded.py n_currently_open.py sum_realized_pnl_base.py sum_total_pnl_base.py` and their `.json` siblings.
Run: `for m in total_return volatility sharpe_ratio ...; do grep -rl "core-app/$m\b" dashboards/ && echo "STILL USED: $m"; done` — abort deletion of any that print `STILL USED`.

- [ ] **Step 2: Add the dashboards-valid test**

Copy `oc-plugin-yfinance-app/tests/test_dashboards_valid.py` into `oc-plugin-core-app/tests/`, adapt: plugin prefix `core-app`, assert every `core-datasource` target has either a `ref` resolving to a `library-panels/<metric>.py` **or** a non-empty inline `@metric` source; and assert no dashboard contains the string `base_currency`.

- [ ] **Step 3: Run it**

Run: `cd /Users/ignacioballester/trading-code/oc-plugin-core-app && python -m pytest tests/test_dashboards_valid.py -v`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git -C /Users/ignacioballester/trading-code/oc-plugin-core-app add -A
git -C /Users/ignacioballester/trading-code/oc-plugin-core-app commit -m "chore: remove superseded scalar metrics; add dashboards-valid test"
```

---

### Task D9: Version bump + publish core-app

**Files:**
- Modify: `oc-plugin-core-app/oc-plugin.json`

- [ ] **Step 1: Bump version**

Prepend the next version to `versions` (e.g. `"0.1.4"`).

- [ ] **Step 2: Build + final checks**

Run: `cd /Users/ignacioballester/trading-code/oc-plugin-core-app && npm run build && mage -v && python -m pytest tests/test_dashboards_valid.py`
Expected: build OK; tests PASS.

- [ ] **Step 3: Merge, tag, publish**

```bash
git -C /Users/ignacioballester/trading-code/oc-plugin-core-app add oc-plugin.json
git -C /Users/ignacioballester/trading-code/oc-plugin-core-app commit -m "release: core-app 0.1.4"
```
Merge to `main`, push tag `v0.1.4`; confirm the GHCR artifact + `oc-plugin.json` manifest bump.

- [ ] **Step 4: Hand off visual verification to the user**

Tell the user to restart/reconcile the app (pulls core-datasource ≥0.1.4 **and** core-app ≥0.1.4) and confirm: panels show titles (no `value`), analytics panels are timeseries, the portfolio dropdown shows names, positions rows link to the Instrument dashboard with the right instrument, no base-currency/benchmark controls.

---

## Self-Review

- **Spec coverage:** P (datasource concat P2/P3, base lib P1, functions/ convention + ship P4) ✓; D dropdown (D1) ✓; inline panels fix no-title (D5/D6/D7) ✓; over_time inline-math series (D3/D4) ✓; positions link + drop column (D6) ✓; remove base_currency everywhere (D5/D6/D7/D8) ✓; remove benchmark from Portfolio only, keep in Analytics (D5 keeps benchmark vars, D6 removes) ✓; cross-linking (D5/D6/D7) ✓; verification harness (D2) + dashboards-valid (D8) + visual handoff (D9) ✓; sequencing P before D ✓.
- **Placeholder scan:** harness internals in D2 reference an existing parity test to copy verbatim (named with path) rather than a vague TODO; generators are concrete transforms. No "add error handling"/"TBD".
- **Type consistency:** `over_time(fn, step)`/`returns(nav, flows, step)` names + return schemas used identically across D3/D4; `loadFunctions(baseDir, installRoot, ref)` signature consistent P2→P3; `ts` Int64 everywhere.

## Risks carried from spec
- Prepended-helper line-number offset in tracebacks (accepted).
- `fn(t)` per-tick filtering is O(n²) over the grid — fine for daily/90d; flag if a 1h panel spans long ranges.
- `core-datasource` build must actually run `copyFunctions` in the publish workflow (P4 Step 3 guards this).
