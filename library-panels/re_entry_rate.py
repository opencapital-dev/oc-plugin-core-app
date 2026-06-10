@bind(cycles="cycles{portfolio=\"$portfolio_id\"} @window")
@metric(output="scalar")
def re_entry_rate(cycles):
    n = cycles.height
    if n == 0:
        return float("nan")
    re_entries = cycles.filter(pl.col("was_re_entry") > 0).height
    return re_entries / n
