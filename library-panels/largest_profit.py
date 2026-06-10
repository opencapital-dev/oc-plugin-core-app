@bind(closures="closures{portfolio=\"$portfolio_id\"} @window")
@metric(output="scalar")
def largest_profit(closures):
    wins = closures.filter(pl.col("realized_pnl") > 0)
    return None if wins.is_empty() else float(wins["realized_pnl"].max())
