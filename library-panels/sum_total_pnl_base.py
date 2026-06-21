@bind(
    closures=("SELECT * FROM e_closures WHERE portfolio=$1 AND ts BETWEEN $2 AND $3 ORDER BY ts ASC",
              "$portfolio_id", window.t0, window.t1),
    cycles=("SELECT * FROM e_cycles WHERE portfolio=$1 AND ts BETWEEN $2 AND $3 ORDER BY ts ASC",
            "$portfolio_id", window.t0, window.t1),
    events=("SELECT * FROM e_events WHERE portfolio=$1 AND event_type=$2 AND ts BETWEEN $3 AND $4 ORDER BY ts ASC",
            "$portfolio_id", "TRADE", window.t0, window.t1),
    instrument=("SELECT * FROM e_instrument WHERE portfolio=$1 ORDER BY ts ASC",
                "$portfolio_id"),
)
@metric(output="scalar")
def sum_total_pnl_base(closures, cycles, events, instrument):
    pos = positions(closures, cycles, events, instrument)
    return float(pos["total_pnl"].sum())
