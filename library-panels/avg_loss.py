@bind(closures="closures{portfolio=\"$portfolio_id\"} @window")
@metric(output="scalar")
def avg_loss(closures):
    losses = closures.filter(pl.col("realized_pnl") < 0)
    return None if losses.is_empty() else float(losses["realized_pnl"].mean())
