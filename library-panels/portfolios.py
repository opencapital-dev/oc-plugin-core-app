@bind(rows=pg("SELECT portfolio_id::text AS portfolio_id, base_currency, attributes FROM portfolios ORDER BY portfolio_id"))
@metric(output="table")
def portfolios(rows):
    return rows
