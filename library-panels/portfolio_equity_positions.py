@bind(rows="instrument{portfolio=\"${portfolio_id}\", quantity != 0} @latest")
@metric(output="table")
def passthrough(rows):
    return rows
