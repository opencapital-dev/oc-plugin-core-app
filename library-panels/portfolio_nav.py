@bind(rows=("SELECT * FROM e_portfolio WHERE portfolio=$1 ORDER BY ts ASC", "$portfolio_id"))
@metric(output="table")
def passthrough(rows):
    return rows
