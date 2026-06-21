@bind(closures=("SELECT * FROM e_closures WHERE portfolio=$1 AND ts BETWEEN $2 AND $3 ORDER BY ts ASC",
               "$portfolio_id", window.t0, window.t1))
@metric(output="scalar")
def largest_profit(closures):
    wins = closures.filter(pl.col("realized_pnl") > 0)
    return None if wins.is_empty() else float(wins["realized_pnl"].max())
