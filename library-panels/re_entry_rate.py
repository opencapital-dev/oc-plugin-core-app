@bind(cycles=("SELECT * FROM e_cycles WHERE portfolio=$1 AND ts BETWEEN $2 AND $3 ORDER BY ts ASC",
              "$portfolio_id", window.t0, window.t1))
@metric(output="scalar")
def re_entry_rate(cycles):
    n = cycles.height
    if n == 0:
        return float("nan")
    re_entries = cycles.filter(pl.col("was_re_entry") > 0).height
    return re_entries / n
