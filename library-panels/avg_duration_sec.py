@bind(closures="closures{portfolio=\"$portfolio_id\"} @window")
@metric(output="scalar")
def avg_duration_sec(closures):
    return None if closures.is_empty() else float(closures["holding_seconds"].mean())
