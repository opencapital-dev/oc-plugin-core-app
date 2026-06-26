@bind(closures=("SELECT * FROM e_closures WHERE portfolio=$1 AND ts BETWEEN $2 AND $3 ORDER BY ts ASC",
                "$portfolio_id", window.t0, window.t1))
@metric(output="series")
def expectancy_series(closures):
    step = "${sample_interval}"
    def asof_e(t):
        sub = closures.filter(pl.col("ts") <= t)["realized_pnl"]
        wins = sub.filter(sub > 0)
        losses = sub.filter(sub < 0)
        dec = wins.len() + losses.len()
        if dec == 0:
            return None
        wr = wins.len() / dec
        aw = wins.mean() if wins.len() else 0.0
        al = losses.mean() if losses.len() else 0.0
        return wr * aw + (1.0 - wr) * al
    return over_time(asof_e, step)
