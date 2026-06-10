@bind(
    closures="closures{portfolio=\"$portfolio_id\"} @window",
    cycles="cycles{portfolio=\"$portfolio_id\"} @window",
    events='events{portfolio=\"$portfolio_id\", event_type="TRADE"} @window',
    instrument="instrument{portfolio=\"$portfolio_id\"} @asof",
)
@metric(output="scalar")
def n_losing_instruments(closures, cycles, events, instrument):
    pos = positions(closures, cycles, events, instrument)
    return float(pos.filter(pl.col("total_pnl") < 0).height)
