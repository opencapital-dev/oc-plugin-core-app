@bind(rows="cash{portfolio=\"${portfolio_id}\", balance_native != 0} @latest")
@metric(output="table")
def passthrough(rows):
    return rows
