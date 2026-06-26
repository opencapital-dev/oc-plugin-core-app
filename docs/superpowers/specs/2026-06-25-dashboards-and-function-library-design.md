# Design — Plugin function library + core-app dashboards redesign

Date: 2026-06-25
Status: approved (pending written-spec review)
Repos touched: `oc-plugin-core-datasource` (P), `oc-plugin-core-app` (P+D). Compute sidecar (`opencapital/services/compute`) **unchanged**.

---

## 1. Problem

Two coupled goals:

**P — Function library is welded to the frozen compute binary.** Metric helpers
(`cumulative_twr`, `sharpe`, `annualize_return`, …) live in `compute/metrics/*`,
baked into the PyInstaller sidecar. Changing or adding a helper means re-freeze +
new desktop app release. We want the function library to evolve like plugin
content (ship a `.py`, pull from GHCR, reconcile) — **no app release for function
changes** — and to let plugins ship their own functions.

**D — core-app dashboards are degraded.** Symptoms reported in the running app:
- Analytics panels show **no title** and a raw **`value`** field — caused by commit
  `276b1f5` ref-ifying 40 panels into Grafana `libraryPanel` references, which do
  not resolve under file-provisioning (title + field renames lost).
- Analytics panels are **stat tiles**; the user wants **timeseries** — each metric
  computed *as of each day* (expanding/cumulative-to-date), not one summary number.
- The **Portfolio dropdown shows the id**, not the portfolio name, on all three
  dashboards.
- Portfolio/Instrument panels lack clear titles; show variable names.
- Positions tables should **link each row to the Instrument dashboard**, **drop the
  portfolio column** (portfolio already selected), and **base currency** +
  **benchmark** clutter should be removed.

D depends on P: the redesigned metrics use a new combinator `over_time`, which
ships via the function library.

---

## 2. Architecture finding (the hinge)

The **datasource already reads each metric `.py` from disk** and sends only a
*source string* to compute; compute just `exec`s it:

- `oc-plugin-core-datasource/pkg/plugin/metricref.go:40` `readMetricSource` reads
  `<installRoot>/<pluginID>/library-panels/<metric>.py`.
- `datasource.go:82` `query()` → `selectCode()` → `substituteVars()` → POST
  `{source, window}` to compute.
- `compute/endpoint.py:117` `exec(source, ns)`; helpers come from `metrics.__all__`
  baked into the binary.

So functions can be decoupled from the binary **entirely at the datasource layer**:
have the datasource **prepend** a shared function library (+ the owning plugin's
own functions) to the source before POSTing. Compute is untouched; it execs a
bigger string. After the one-time datasource change, function changes ship as
`.py` files via GHCR — no re-freeze, no app release.

`core-datasource` is in the GHCR catalog (`plugins.json`) and reconciled like any
plugin, so the P enabler itself ships as a normal plugin republish (no app release;
restart → reconcile pulls the new backend).

### Boundary split

| Layer | Lives where | Examples |
|---|---|---|
| Irreducible primitives (need live store/exec) | **Frozen in compute** | `@metric`, `@bind`, `sql`/`pg`/`rw`, `window`, `pl`, `fetch_json`, `math`, and existing internal helpers (`build_grid`, `cumulative_twr`, `cumulative_to_period_returns`, `positions`, regression, `xirr`) |
| General, reused function library | **Shippable `.py`, prepended by datasource** | `over_time`, `returns` |
| Single-use formulas | **Inlined in each panel** | sharpe, sortino, calmar, annualize, max/current drawdown, cumulative-return extraction, win-rate / profit-factor / expectancy accumulation |

Existing frozen helpers stay (used by `beta_series`/`alpha_series`/`r_squared_series`
which we keep as-is). `returns` *wraps* the frozen `cumulative_twr` etc.; they become
internal primitives, no longer panel-facing API.

---

## 3. P — Function library subsystem

### 3.1 `functions/` convention

- A plugin may ship `<plugin>/functions/*.py` in its bundle (sibling of
  `library-panels/`). Each file is plain Python defining helper functions; no
  decorators, no `@metric`.
- `core-datasource` ships the **base library** as its own `functions/*.py`
  (always loaded, for every query).

### 3.2 Datasource loader (Go change in `core-datasource`)

In `selectCode`/`query` path:

1. Read base functions from the datasource's own plugin dir:
   `<installRoot>/<core-datasource-pluginID>/functions/*.py`, sorted by filename.
2. If the query is a `ref` (`pluginID/metric`), also read
   `<installRoot>/<pluginID>/functions/*.py`, sorted. (Inline-`source` queries get
   the base library only — no plugin id is known.)
3. Concatenate: **base functions → plugin functions → panel source**, joined by
   `\n`. Apply `substituteVars` to the **panel source only** (helpers are not
   variable-templated). POST the combined string as `source`.

Path resolution reuses the existing `installRoot` + plugin-dir-escape guard
(`resolveMetricPath` pattern). Missing `functions/` dir is not an error (skip).
Optional: cache file reads by (path, mtime); v1 may read per query (files are tiny
and OS-cached).

### 3.3 Load order, collisions, errors

- **Order:** base → plugin → panel. Later `def`s shadow earlier (plain exec into one
  namespace), so a plugin can override a base helper by name (last wins). Documented,
  intentional.
- **Line numbers:** prepending helpers offsets panel line numbers in tracebacks.
  v1 accepts this; helper code is small/stable and entrypoint errors are surfaced as
  `entrypoint error: <msg>`. Future enhancement (only if painful): add a `prelude`
  field to the `/compute` request so compute execs helpers separately — that *would*
  require a one-time compute re-freeze, deferred.

### 3.4 Base library v1

`core-datasource/functions/series.py`:

```python
def over_time(fn, step):
    """Evaluate fn(t) over a uniform grid across the dashboard window.

    fn:   Callable[[int], float | None] — given cutoff ts (epoch µs), return the
          metric value as of t. fn owns its windowing: expanding uses ts <= t,
          rolling uses t - lookback <= ts <= t.
    step: int microseconds, or a string like "1d" / "1h".
    Returns pl.DataFrame({"ts": Int64, "value": Float64}) over the grid
    [window.t0, window.t1] inclusive. ts is Int64 epoch-microseconds.
    Depends only on injected `window`, `build_grid`, `pl`.
    """
    grid = build_grid(window.t0, window.t1, step)
    return pl.DataFrame(
        {"ts": grid, "value": [fn(t) for t in grid]},
        schema={"ts": pl.Int64, "value": pl.Float64},
    )


def returns(nav, flows, step):
    """Flow-neutralized period-return series for a portfolio, on a step grid.

    nav:   e_nav frame (ts Int64 µs, value Float64 > 0)
    flows: e_flows frame (ts Int64 µs, amt Float64 signed)
    Returns pl.DataFrame({"ts": Int64, "ret": Float64}); first tick ret is null.
    Wraps injected build_grid + cumulative_twr + cumulative_to_period_returns.
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

### 3.5 P verification

Scratchpad harness (not committed, like the macro generator): run a representative
panel through the **compute source** with the datasource concatenation simulated
(prepend `functions/*.py`), stubbing `sql()` with canned `e_nav`/`e_flows`/`e_closures`
frames. Assert frame contract: `ts` is Int64 epoch-µs, JSON-serializable (the EOF
lesson), columns correct, last expanding value == the legacy scalar reference.
Go-side: a unit test for the loader (base+plugin concatenation, ordering, escape
guard, missing-dir skip).

---

## 4. D — Dashboards redesign (`oc-plugin-core-app`)

### 4.1 Dropdown id → name

`library-panels/portfolios.py`:
```python
@bind(rows=pg("SELECT portfolio_id::text AS portfolio_id, "
              "attributes->>'name' AS name "
              "FROM portfolios ORDER BY name"))
@metric(output="table")
def portfolios(rows):
    return rows
```
The datasource maps column `name`→option text, `portfolio_id`→value
(`core-datasource/src/datasource.ts:102`). Fixes the dropdown on all three
dashboards at once. (Portfolio display name is `attributes.name`, confirmed in
`src/components/PortfolioSelector.tsx`.)

### 4.2 Inline panel models (fix no-title / "value")

Replace every `libraryPanel` reference in the three dashboards with a **full inline
panel model** (title, type, fieldConfig, transformations, options) whose **target
keeps `ref: core-app/<metric>`** (so the datasource still reads the shipped `.py`
and can load the plugin's `functions/`). This both fixes title/field rendering and
keeps metrics DRY. A scratchpad generator merges `library-panels/*.json` models into
the dashboards (not committed; panels keep changing).

### 4.3 New expanding-series metrics (over_time + inline formula)

Each new `*_series` metric: bind the base frames, build `rets = returns(nav, flows,
step)` (NAV family) or filter closures (trade family) **inline**, define the
point-in-time `fn(t)` **inline**, return `over_time(fn, step)`. `ts` is Int64
epoch-µs. Default mode **expanding** (cumulative-to-date), matching "compute for each
day". Step from `$sample_interval` (1d/1h).

NAV family (use `returns`):
- `cumulative_return_series` (exists — keep)
- `annualized_return_series` — annualize cum return to-date
- `volatility_series` — stdev(rets ≤ t)·√py
- `sharpe_series`, `sortino_series` — inline formula over rets ≤ t
- `calmar_series` — annualized / |max drawdown to-date|
- `drawdown_series` — current drawdown of the cum curve at each t (area panel)
- `xirr_series` — annualized XIRR with flows ≤ t and terminal mark at t

Trade family (filter `e_closures`/`e_cycles` inline, cumulative as-of t):
- `win_rate_series`, `profit_factor_series`, `expectancy_series`
- `trade_counts_series` — cumulative trades / winners / losers (multi-column)
- `realized_pnl_series` — cumulative realized PnL

Keep as-is (already non-stat or already series): `beta_series`, `alpha_series`,
`r_squared_series`, `returns_pair_series`, `drawdown_episodes` (table),
`instruments_breakdown` (table), `hit_rate_by_duration` (table).

Old scalar metric files that become unused after the redesign are deleted in D.

### 4.4 Analytics dashboard — target layout (`metrics-analytics-numbat`)

Grouped multi-series timeseries (24-col grid), top to bottom:
1. **Return** — cumulative TWR + annualized (timeseries)
2. **Drawdown over time** — area
3. **Risk-adjusted** — Sharpe + Sortino + Calmar (timeseries)
4. **Volatility** — expanding vol (timeseries)
5. **Beta / Alpha / R²** — existing series panels
6. **XIRR over time** — cumulative + annualized
7. **Trade quality over time** — win rate + profit factor + expectancy
8. **Trade counts over time** — cumulative trades / winners / losers
9. **Per-instrument breakdown** + **hit rate by duration** — existing tables
10. **Drawdown episodes** — existing table

Variables: keep `portfolio_id` (now name), `sample_interval`, `risk_free`,
`lookback_periods`, and **benchmark** (`benchmark_ids`/`benchmark_weights` — required
by beta/alpha). **Remove `base_currency`.**

### 4.5 Portfolio dashboard (`metrics-portfolio`)

- Inline panel models (titles render).
- **Remove `base_currency`** variable + all `&var-base_currency=` link params.
- **Remove benchmark** (`benchmark_instrument_id`, hidden `primary_benchmark`).
- Positions tables (`portfolio_equity_positions`, `portfolio_cash_positions`):
  - **Row → Instrument link**, carrying `portfolio_id` + time range only
    (`/d/metrics-instrument?var-portfolio_id=${portfolio_id}&var-instrument_id=
    ${__data.fields.Instrument}&${__url_time_range}`). Verify the equity table's
    existing link works; add the equivalent to cash positions where applicable.
  - **Drop the portfolio column** (exclude `portfolio_id` in the organize transform).

### 4.6 Instrument dashboard (`metrics-instrument`)

- Inline panel models (titles render).
- Strip `base_currency` from the inline IRR SQL panel and the "Back to portfolio"
  link.

### 4.7 Cross-linking / user flow

Pick Portfolio (names) → Portfolio dashboard (overview + linked positions) → row →
Instrument (pre-filled). Top-right links Portfolio ↔ Analytics ↔ Instrument carry
`portfolio_id` + time range only (no base_currency).

### 4.8 base_currency / benchmark safety

Before removing, confirm no metric `@bind` references `$base_currency` (the `*_base`
metrics derive base from data, not the variable) and that no kept Portfolio metric
binds the benchmark vars. If any do, keep the minimal var rather than break a query.

---

## 5. Sequencing

1. **P** — datasource loader + `functions/` convention + base lib (`over_time`,
   `returns`). Republish `core-datasource`. Verify with harness + Go test.
2. **D** — dropdown fix; author `*_series` metrics (verify each via harness); inline
   + rebuild the three dashboards; positions links/columns; var removals;
   cross-linking. Republish `core-app`.

No compute re-freeze, no desktop app release in either step (function + plugin
content only; both plugins are GHCR-reconciled).

---

## 6. Testing & verification

- **Headless (this session):** scratchpad harness asserting frame contract +
  reference values for new metrics and the concatenation path; Go loader unit test;
  `test_dashboards_valid` equivalent for the rebuilt dashboards (every target has a
  valid `ref` or inline `@metric` source); grep that no `base_currency`/benchmark
  leftovers remain where removed.
- **Visual (requires user to restart app):** titles render, dropdown shows names,
  row links navigate, analytics panels are timeseries. Called out explicitly — not
  claimed as verified headlessly.

---

## 7. Out of scope / risks

- Out of scope: compute `prelude` field (deferred line-number enhancement); moving
  `positions`/regression/`xirr` out of the frozen binary (kept frozen, still used by
  retained series metrics); rolling (vs expanding) variants for vol/Sharpe/Sortino
  beyond what `lookback_periods` already drives in beta/alpha.
- Risk: prepended-helper line-number offset in tracebacks (accepted, documented).
- Risk: per-tick `fn(t)` is O(n²) over the grid; fine for daily ticks over the
  default 90d window (hundreds of points). Note in code if a panel uses 1h over long
  ranges.
- Risk: a plugin overriding a base-lib name by collision (last-wins) — documented
  behavior, not a bug.
