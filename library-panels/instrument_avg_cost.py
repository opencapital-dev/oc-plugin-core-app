@bind(rows=("SELECT * FROM e_instrument WHERE portfolio=$1 AND instrument=$2 ORDER BY ts ASC",
            "$portfolio_id", "${instrument_id}"))
@metric(output="table")
def passthrough(rows):
    return rows
