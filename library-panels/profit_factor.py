@bind(closures="closures{portfolio=\"$portfolio_id\"} @window")
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
