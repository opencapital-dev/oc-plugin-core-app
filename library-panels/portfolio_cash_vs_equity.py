@bind(rows="portfolio{portfolio=\"${portfolio_id}\"} @latest")
@metric(output="table")
def passthrough(rows):
    return rows
