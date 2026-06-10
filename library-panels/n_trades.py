@bind(closures="closures{portfolio=\"$portfolio_id\"} @window")
@metric(output="scalar")
def n_trades(closures):
    return float(closures.height)
