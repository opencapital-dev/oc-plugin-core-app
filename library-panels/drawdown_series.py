@bind(
    nav=("SELECT * FROM e_nav WHERE portfolio=$1 ORDER BY ts ASC", "$portfolio_id"),
    flows=("SELECT * FROM e_flows WHERE portfolio=$1 AND ts BETWEEN $2 AND $3 ORDER BY ts ASC",
           "$portfolio_id", window.t0, window.t1),
)
@metric(output="series")
def drawdown_series(nav, flows):
    step = "${sample_interval}"
    rets = returns(nav, flows, step)
    def asof_d(t):
        sub = rets.filter((pl.col("ts") <= t) & pl.col("ret").is_not_null())["ret"]
        if sub.len() < 1:
            return None
        acc, peak = 1.0, 1.0
        for x in sub:
            acc *= (1.0 + x)
            if acc > peak:
                peak = acc
        return acc / peak - 1.0
    return over_time(asof_d, step)
