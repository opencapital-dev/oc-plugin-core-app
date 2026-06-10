STEP_SEC = 3600 if "${sample_interval}" == "1h" else 86400
STEP_US = STEP_SEC * 1_000_000

@bind(
    nav="nav{portfolio=\"$portfolio_id\"} @asof",
    flows="flows{portfolio=\"$portfolio_id\"} @window",
    bench="price{portfolio=\"$portfolio_id\", instrument=\"$benchmark_ids\"}[ts, value] @asof",
)
@metric(output="series")
def returns_pair_series(nav, flows, bench):
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
    rows = [
        (ts, rp, rb)
        for (ts, rp), (_, rb) in zip(r_p_pairs[1:], r_b_pairs[1:])
    ]
    return pl.DataFrame(
        {"ts": [r[0] for r in rows], "r_p": [r[1] for r in rows], "r_b": [r[2] for r in rows]},
        schema={"ts": pl.Int64, "r_p": pl.Float64, "r_b": pl.Float64},
    )
