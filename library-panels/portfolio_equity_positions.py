@bind(rows=("SELECT DISTINCT ON (portfolio, instrument) * FROM e_instrument "
            "WHERE portfolio=$1 AND quantity != $2 "
            "ORDER BY portfolio, instrument, ts DESC", "$portfolio_id", 0))
@metric(output="table")
def passthrough(rows):
    return rows
