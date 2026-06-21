@bind(rows=("SELECT DISTINCT ON (portfolio, instrument) * FROM e_instrument "
            "WHERE portfolio=$1 AND instrument=$2 "
            "ORDER BY portfolio, instrument, ts DESC", "$portfolio_id", "${instrument_id}"))
@metric(output="table")
def passthrough(rows):
    return rows
