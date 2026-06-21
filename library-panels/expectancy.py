@bind(closures=("SELECT * FROM e_closures WHERE portfolio=$1 AND ts BETWEEN $2 AND $3 ORDER BY ts ASC",
               "$portfolio_id", window.t0, window.t1))
@metric(output="scalar")
def expectancy(closures):
    n_w = closures.filter(pl.col("realized_pnl") > 0).height
    n_l = closures.filter(pl.col("realized_pnl") < 0).height
    decisive = n_w + n_l
    if decisive == 0:
        return None
    wr = n_w / decisive
    wins = closures.filter(pl.col("realized_pnl") > 0)
    losses = closures.filter(pl.col("realized_pnl") < 0)
    aw = float(wins["realized_pnl"].mean()) if not wins.is_empty() else 0.0
    al = float(losses["realized_pnl"].mean()) if not losses.is_empty() else 0.0
    return wr * aw + (1 - wr) * al
