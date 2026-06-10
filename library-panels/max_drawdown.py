STEP_SEC = 3600 if "${sample_interval}" == "1h" else 86400
STEP_US = STEP_SEC * 1_000_000

@bind(nav="nav{portfolio=\"$portfolio_id\"} @asof", flows="flows{portfolio=\"$portfolio_id\"} @window")
@metric(output="scalar")
def max_drawdown_panel(nav, flows):
    t0, t1 = window
    effective_start = t0 if nav.is_empty() else max(t0, nav["ts"][0])
    flow_ts = [r[0] for r in flows.select("ts").rows() if r[0] > effective_start]
    grid = build_grid(effective_start, t1, STEP_US)
    cum_series = cumulative_twr(nav, flow_ts, effective_start, grid)
    if not cum_series:
        return None
    cum = [v for _, v in cum_series]
    return max_drawdown(cum)
