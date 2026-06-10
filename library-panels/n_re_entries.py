@bind(cycles="cycles{portfolio=\"$portfolio_id\"} @window")
@metric(output="scalar")
def n_re_entries(cycles):
    if cycles.is_empty():
        return 0.0
    return float(cycles.filter(pl.col("was_re_entry") > 0).height)
