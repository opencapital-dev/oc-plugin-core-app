@bind(rows=("SELECT DISTINCT ON (portfolio, currency) * FROM e_cash "
            "WHERE portfolio=$1 AND balance_native != $2 "
            "ORDER BY portfolio, currency, ts DESC", "$portfolio_id", 0))
@metric(output="table")
def passthrough(rows):
    return rows
