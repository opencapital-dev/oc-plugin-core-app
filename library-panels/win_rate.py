@bind(closures=("SELECT * FROM e_closures WHERE portfolio=$1 AND ts BETWEEN $2 AND $3 ORDER BY ts ASC",
               "$portfolio_id", window.t0, window.t1))
@metric(output="scalar")
def win_rate(closures):
    n_w = closures.filter(pl.col("realized_pnl") > 0).height
    n_l = closures.filter(pl.col("realized_pnl") < 0).height
    decisive = n_w + n_l
    return None if decisive == 0 else n_w / decisive
