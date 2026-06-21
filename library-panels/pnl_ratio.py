@bind(closures=("SELECT * FROM e_closures WHERE portfolio=$1 AND ts BETWEEN $2 AND $3 ORDER BY ts ASC",
               "$portfolio_id", window.t0, window.t1))
@metric(output="scalar")
def pnl_ratio(closures):
    wins = closures.filter(pl.col("realized_pnl") > 0)
    losses = closures.filter(pl.col("realized_pnl") < 0)
    if wins.is_empty() or losses.is_empty():
        return None
    return float(wins["realized_pnl"].mean()) / abs(float(losses["realized_pnl"].mean()))
