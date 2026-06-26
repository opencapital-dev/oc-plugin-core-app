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
