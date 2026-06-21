@bind(rows=("SELECT DISTINCT ON (portfolio) * FROM e_portfolio "
            "WHERE portfolio=$1 ORDER BY portfolio, ts DESC", "$portfolio_id"))
@metric(output="table")
def passthrough(rows):
    return rows
