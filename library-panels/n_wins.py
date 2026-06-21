@bind(closures=("SELECT * FROM e_closures WHERE portfolio=$1 AND ts BETWEEN $2 AND $3 ORDER BY ts ASC",
               "$portfolio_id", window.t0, window.t1))
@metric(output="scalar")
def n_wins(closures):
    return float(closures.filter(pl.col("realized_pnl") > 0).height)
