@bind(rows="instrument{portfolio=\"${portfolio_id}\", instrument=\"${instrument_id}\"} @latest")
@metric(output="table")
def passthrough(rows):
    return rows
