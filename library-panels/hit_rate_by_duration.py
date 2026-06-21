_DAY = 86400.0
_BANDS = [
    ("< 1d", 0.0, _DAY),
    ("1-7d", _DAY, 7 * _DAY),
    ("7-30d", 7 * _DAY, 30 * _DAY),
    (">30d", 30 * _DAY, float("inf")),
]


@bind(cycles=("SELECT * FROM e_cycles WHERE portfolio=$1 AND ts BETWEEN $2 AND $3 ORDER BY ts ASC",
              "$portfolio_id", window.t0, window.t1))
@metric(output="table")
def hit_rate_by_duration(cycles):
    labels, n_round_trips, n_wins, win_rate, avg_pnl = [], [], [], [], []
    for label, lo, hi in _BANDS:
        band = cycles.filter(
            (pl.col("duration_sec") >= lo) & (pl.col("duration_sec") < hi)
        )
        n = band.height
        if n == 0:
            continue
        pnl = band["pnl_base"]
        wins = int((pnl > 0).sum())
        decisive = int((pnl != 0).sum())
        labels.append(label)
        n_round_trips.append(float(n))
        n_wins.append(float(wins))
        win_rate.append(wins / decisive if decisive > 0 else float("nan"))
        avg_pnl.append(float(pnl.mean()))
    return pl.DataFrame({
        "label": labels,
        "n_round_trips": n_round_trips,
        "n_wins": n_wins,
        "win_rate": win_rate,
        "avg_pnl": avg_pnl,
    })
