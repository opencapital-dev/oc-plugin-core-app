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
