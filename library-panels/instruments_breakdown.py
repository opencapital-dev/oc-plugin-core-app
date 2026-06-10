@bind(
    closures="closures{portfolio=\"$portfolio_id\"} @window",
    cycles="cycles{portfolio=\"$portfolio_id\"} @window",
    events='events{portfolio=\"$portfolio_id\", event_type="TRADE"} @window',
    instrument="instrument{portfolio=\"$portfolio_id\"} @asof",
)
@metric(output="table")
def instruments_breakdown(closures, cycles, events, instrument):
    return positions(closures, cycles, events, instrument)
