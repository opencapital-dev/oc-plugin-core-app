@bind(closures="closures{portfolio=\"$portfolio_id\"} @window")
@metric(output="scalar")
def n_losses(closures):
    return float(closures.filter(pl.col("realized_pnl") < 0).height)
