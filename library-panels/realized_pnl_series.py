@bind(closures=("SELECT * FROM e_closures WHERE portfolio=$1 AND ts BETWEEN $2 AND $3 ORDER BY ts ASC",
                "$portfolio_id", window.t0, window.t1))
@metric(output="series")
def realized_pnl_series(closures):
    step = "${sample_interval}"
    def asof_p(t):
        sub = closures.filter(pl.col("ts") <= t)["realized_pnl"]
        return float(sub.sum()) if sub.len() else 0.0
    return over_time(asof_p, step)
