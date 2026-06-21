STEP_SEC = 3600 if "${sample_interval}" == "1h" else 86400
STEP_US = STEP_SEC * 1_000_000

@bind(
    nav=("SELECT * FROM e_nav WHERE portfolio=$1 ORDER BY ts ASC", "$portfolio_id"),
    flows=("SELECT * FROM e_flows WHERE portfolio=$1 AND ts BETWEEN $2 AND $3 ORDER BY ts ASC",
           "$portfolio_id", window.t0, window.t1),
)
@metric(output="scalar")
def volatility(nav, flows):
    t0, t1 = window
    effective_start = t0 if nav.is_empty() else max(t0, nav["ts"][0])
    flow_ts = [r[0] for r in flows.select("ts").rows() if r[0] > effective_start]
    grid = build_grid(effective_start, t1, STEP_US)
    cum_series = cumulative_twr(nav, flow_ts, effective_start, grid)
    if not cum_series:
        return None
    cum = [v for _, v in cum_series]
    period_rs = cum_to_period_returns(cum)
    py = (365 * 86400) / STEP_SEC
    return volatility_annualized(period_rs, py)
