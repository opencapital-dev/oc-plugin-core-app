@bind(closures=("SELECT * FROM e_closures WHERE portfolio=$1 AND ts BETWEEN $2 AND $3 ORDER BY ts ASC",
               "$portfolio_id", window.t0, window.t1))
@metric(output="scalar")
def avg_loss(closures):
    losses = closures.filter(pl.col("realized_pnl") < 0)
    return None if losses.is_empty() else float(losses["realized_pnl"].mean())
