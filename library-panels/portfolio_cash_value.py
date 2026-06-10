@bind(rows="portfolio{portfolio=\"${portfolio_id}\"} @asof")
@metric(output="table")
def passthrough(rows):
    return rows
