@bind(rows=pg("SELECT portfolio_id::text AS portfolio_id, "
              "attributes->>'name' AS name "
              "FROM portfolios ORDER BY name"))
@metric(output="table")
def portfolios(rows):
    return rows
