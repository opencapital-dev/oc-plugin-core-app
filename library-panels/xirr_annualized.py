@bind(nav="nav{portfolio=\"$portfolio_id\"} @asof", flows="flows{portfolio=\"$portfolio_id\"} @window")
@metric(output="scalar")
def xirr_annualized(nav, flows):
    t0, t1 = window
    effective_start = t0 if nav.is_empty() else max(t0, nav["ts"][0])
    opening_nav = asof(nav, effective_start)
    if opening_nav is None:
        return None
    terminal_rows = nav.filter(pl.col("ts") <= t1).drop_nulls("value")
    if terminal_rows.is_empty():
        return None
    terminal_nav = terminal_rows[-1]["value"][0]
    window_flows = [
        (r[0], -r[1])
        for r in flows.select("ts", "amt").rows()
        if r[0] > effective_start
    ]
    cashflows = [(effective_start, -opening_nav)] + window_flows + [(t1, terminal_nav)]
    return xirr(cashflows)
