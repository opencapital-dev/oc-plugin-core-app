@bind(closures="closures{portfolio=\"$portfolio_id\"} @window")
@metric(output="scalar")
def avg_win(closures):
    wins = closures.filter(pl.col("realized_pnl") > 0)
    return None if wins.is_empty() else float(wins["realized_pnl"].mean())
