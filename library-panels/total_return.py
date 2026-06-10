@bind(nav="nav{portfolio=\"$portfolio_id\"} @asof", flows="flows{portfolio=\"$portfolio_id\"} @window")
@metric(output="scalar")
def total_return(nav, flows):
    t0, t1 = window
    effective_start = t0 if nav.is_empty() else max(t0, nav["ts"][0])
    flow_ts = [r[0] for r in flows.select("ts").rows() if r[0] > effective_start]
    grid = build_grid(effective_start, t1, "1d")
    cum = cumulative_twr(nav, flow_ts, effective_start, grid)
    return cum[-1][1] if cum else None
