@bind(closures=("SELECT * FROM e_closures WHERE portfolio=$1 AND ts BETWEEN $2 AND $3 ORDER BY ts ASC",
                "$portfolio_id", window.t0, window.t1))
@metric(output="series")
def trade_counts_series(closures):
    step = "${sample_interval}"
    grid = build_grid(window.t0, window.t1, step)
    rows = []
    for t in grid:
        sub = closures.filter(pl.col("ts") <= t)["realized_pnl"]
        rows.append((t, float(sub.len()),
                     float(sub.filter(sub > 0).len()),
                     float(sub.filter(sub < 0).len())))
    return pl.DataFrame(
        {"ts": [r[0] for r in rows], "trades": [r[1] for r in rows],
         "winners": [r[2] for r in rows], "losers": [r[3] for r in rows]},
        schema={"ts": pl.Int64, "trades": pl.Float64, "winners": pl.Float64, "losers": pl.Float64},
    )
