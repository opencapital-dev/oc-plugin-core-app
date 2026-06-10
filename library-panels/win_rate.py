@bind(closures="closures{portfolio=\"$portfolio_id\"} @window")
@metric(output="scalar")
def win_rate(closures):
    n_w = closures.filter(pl.col("realized_pnl") > 0).height
    n_l = closures.filter(pl.col("realized_pnl") < 0).height
    decisive = n_w + n_l
    return None if decisive == 0 else n_w / decisive
