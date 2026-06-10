@bind(closures="closures{portfolio=\"$portfolio_id\"} @window")
@metric(output="scalar")
def pnl_ratio(closures):
    wins = closures.filter(pl.col("realized_pnl") > 0)
    losses = closures.filter(pl.col("realized_pnl") < 0)
    if wins.is_empty() or losses.is_empty():
        return None
    return float(wins["realized_pnl"].mean()) / abs(float(losses["realized_pnl"].mean()))
