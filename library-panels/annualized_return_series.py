@bind(
    nav=("SELECT * FROM e_nav WHERE portfolio=$1 ORDER BY ts ASC", "$portfolio_id"),
    flows=("SELECT * FROM e_flows WHERE portfolio=$1 AND ts BETWEEN $2 AND $3 ORDER BY ts ASC",
           "$portfolio_id", window.t0, window.t1),
)
@metric(output="series")
def annualized_return_series(nav, flows):
    step = "${sample_interval}"
    PY = 252.0 if step == "1d" else 252.0 * 6.5
    rets = returns(nav, flows, step)
    def asof_a(t):
        sub = rets.filter((pl.col("ts") <= t) & pl.col("ret").is_not_null())["ret"]
        n = sub.len()
        if n < 1:
            return None
        acc = 1.0
        for x in sub:
            acc *= (1.0 + x)
        return acc ** (PY / n) - 1.0
    return over_time(asof_a, step)
