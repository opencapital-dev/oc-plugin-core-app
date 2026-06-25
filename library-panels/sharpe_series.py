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
