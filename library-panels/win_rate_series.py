@bind(closures=("SELECT * FROM e_closures WHERE portfolio=$1 AND ts BETWEEN $2 AND $3 ORDER BY ts ASC",
                "$portfolio_id", window.t0, window.t1))
@metric(output="series")
def win_rate_series(closures):
    step = "${sample_interval}"
    def asof_w(t):
        sub = closures.filter(pl.col("ts") <= t)["realized_pnl"]
        wins = sub.filter(sub > 0).len()
        losses = sub.filter(sub < 0).len()
        dec = wins + losses
        return wins / dec if dec > 0 else None
    return over_time(asof_w, step)
