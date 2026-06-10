@bind(rows="instrument{portfolio=\"${portfolio_id}\", instrument=\"${instrument_id}\"} @asof")
@metric(output="table")
def passthrough(rows):
    return rows
