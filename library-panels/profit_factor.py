@bind(closures=("SELECT * FROM e_closures WHERE portfolio=$1 AND ts BETWEEN $2 AND $3 ORDER BY ts ASC",
               "$portfolio_id", window.t0, window.t1))
@metric(output="scalar")
def profit_factor(closures):
    wins = closures.filter(pl.col("realized_pnl") > 0)
    losses = closures.filter(pl.col("realized_pnl") < 0)
    if losses.is_empty():
        return None
    sum_losses = float(losses["realized_pnl"].sum())
    if sum_losses == 0.0:
        return None
    return float(wins["realized_pnl"].sum()) / abs(sum_losses)
