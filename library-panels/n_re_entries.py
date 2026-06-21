@bind(cycles=("SELECT * FROM e_cycles WHERE portfolio=$1 AND ts BETWEEN $2 AND $3 ORDER BY ts ASC",
              "$portfolio_id", window.t0, window.t1))
@metric(output="scalar")
def n_re_entries(cycles):
    if cycles.is_empty():
        return 0.0
    return float(cycles.filter(pl.col("was_re_entry") > 0).height)
