STEP_SEC = 3600 if "${sample_interval}" == "1h" else 86400
STEP_US = STEP_SEC * 1_000_000
LOOKBACK = ${lookback_periods}
PY = 252 * 6.5 if "${sample_interval}" == "1h" else 252.0

def _annualize_alpha(a):
    if a is None:
        return None
    if a <= -1.0:
        return 0.0
    return (1.0 + a) ** PY - 1.0

@bind(
    nav=("SELECT * FROM e_nav WHERE portfolio=$1 ORDER BY ts ASC",
         "$portfolio_id"),
    flows=("SELECT * FROM e_flows WHERE portfolio=$1 AND ts BETWEEN $2 AND $3 ORDER BY ts ASC",
           "$portfolio_id", window.t0, window.t1),
    bench=("SELECT * FROM e_price WHERE portfolio=$1 AND instrument=$2 ORDER BY ts ASC",
           "$portfolio_id", "$benchmark_ids"),
)
@metric(output="series")
def alpha_series(nav, flows, bench):
    t0, t1 = window
    effective_start = t0 if nav.is_empty() else max(t0, nav["ts"][0])
    flow_ts = [r[0] for r in flows.select("ts").rows() if r[0] > effective_start]
    grid = build_grid(effective_start, t1, STEP_US)
    cum_p = cumulative_twr(nav, flow_ts, effective_start, grid)
    bench_vals = sample_at_grid(bench, grid)
    cum_b_vals = cum_returns_from_navs(bench_vals)
    cum_b = list(zip([ts for ts, _ in cum_p], cum_b_vals))
    r_p_pairs = cumulative_to_period_returns(cum_p)
    r_b_pairs = cumulative_to_period_returns(cum_b)
    r_p = pl.DataFrame(
        {"ts": [ts for ts, _ in r_p_pairs], "ret": [r for _, r in r_p_pairs]},
        schema={"ts": pl.Int64, "ret": pl.Float64},
    )
    r_b = pl.DataFrame(
        {"ts": [ts for ts, _ in r_b_pairs], "ret": [r for _, r in r_b_pairs]},
        schema={"ts": pl.Int64, "ret": pl.Float64},
    )
    roll = rolling_regression_stats(r_p=r_p, r_b=r_b, lookback=LOOKBACK)
    exp = expanding_regression_stats(r_p=r_p, r_b=r_b)
    ts_col = [ts for ts, _ in r_p_pairs]
    rows = [
        (
            ts_col[i],
            _annualize_alpha(roll[i].alpha if roll[i] is not None else None),
            _annualize_alpha(exp[i].alpha if exp[i] is not None else None),
        )
        for i in range(1, len(ts_col))
    ]
    return pl.DataFrame(
        {"ts": [r[0] for r in rows], "rolling": [r[1] for r in rows], "expanding": [r[2] for r in rows]},
        schema={"ts": pl.Int64, "rolling": pl.Float64, "expanding": pl.Float64},
    )
