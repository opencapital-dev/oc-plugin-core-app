@bind(
    nav=("SELECT * FROM e_nav WHERE portfolio=$1 ORDER BY ts ASC", "$portfolio_id"),
    flows=("SELECT * FROM e_flows WHERE portfolio=$1 AND ts BETWEEN $2 AND $3 ORDER BY ts ASC",
           "$portfolio_id", window.t0, window.t1),
)
@metric(output="series")
def calmar_series(nav, flows):
    step = "${sample_interval}"
    PY = 252.0 if step == "1d" else 252.0 * 6.5
    rets = returns(nav, flows, step)
    # Expanding: O(n^2) over the grid (per-tick filter + inner accumulation).
    # Fine at the default 1d/90d (~90 ticks); heavy only if 1h is paired with a
    # multi-year range. Acceptable for now; revisit with a prefix-scan if needed.
    def asof_c(t):
        sub = rets.filter((pl.col("ts") <= t) & pl.col("ret").is_not_null())["ret"]
        n = sub.len()
        if n < 1:
            return None
        acc, peak, mdd = 1.0, 1.0, 0.0
        for x in sub:
            acc *= (1.0 + x)
            if acc > peak:
                peak = acc
            dd = acc / peak - 1.0
            if dd < mdd:
                mdd = dd
        ann = acc ** (PY / n) - 1.0
        return ann / abs(mdd) if mdd < 0 else None
    return over_time(asof_c, step)
